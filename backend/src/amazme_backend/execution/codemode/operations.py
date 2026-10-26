"""Codemode operations and child cleanup barriers owned by the Supervisor."""

from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import json
import sqlite3
import threading
import time
from typing import TYPE_CHECKING

import httpx
from pydantic import TypeAdapter

from amazme_backend.contracts.code import CodeTools, CodeView
from amazme_backend.contracts.execution import (
    ProcessLease,
)
from amazme_backend.contracts.identity import HostReady
from amazme_backend.contracts.ipc.host import CodeToolBinding, CodeToolDispatch, CodeToolReceipt
from amazme_backend.contracts.ipc.supervisor import (
    CancelCode,
    CodeStatus,
    McpSession,
    OpenCode,
    WorkerRequest,
)
from amazme_backend.contracts.mcp import catalog_payload, offers_from_views
from amazme_backend.contracts.models import ToolCall
from amazme_backend.contracts.plugins import (
    PluginOffer,
)
from amazme_backend.execution.codemode.runtime import CodemodeOutcome, json_object, run_codemode
from amazme_backend.execution.native import (
    reconcile,
)
from amazme_backend.shared.errors import BackendError

if TYPE_CHECKING:
    from amazme_backend.execution.supervisor import Supervisor


class CodeOperations:
    def __init__(self, owner: Supervisor):
        self.owner = owner
        self.cancels: dict[str, threading.Event] = {}
        self.jobs: dict[str, asyncio.Task[CodeView]] = {}

    async def tools(self, session_id: str) -> CodeTools:
        workspace = self.owner.queries.session_workspace(session_id)
        servers = (await self.owner.mcp.state(McpSession(host_epoch=self.owner.host_epoch,build_id=self.owner.build,session_id=session_id))).servers
        offers = offers_from_views(servers, surface="code")
        plugins = [offer for view in (await self.owner.plugins.list(session_id)).plugins for offer in PluginOffer.from_view(view,workspace)]
        return CodeTools.model_validate({"tools":self.owner.code_tool_definitions(offers,self.owner.profile.config.provider,plugins)})

    async def bind_tool(self, value: CodeToolDispatch) -> CodeToolBinding:
        self.owner.check_host(value)
        request_id = hashlib.sha256(f"code:{value.session_id}:{value.run_id}:{value.sequence}".encode()).hexdigest()
        payload = json.dumps(value.model_dump(mode="json",exclude={"host_epoch","build_id","cancel"}),sort_keys=True)
        def bind(db: sqlite3.Connection) -> CodeToolBinding:
            prior = db.execute("SELECT * FROM code_tool_calls WHERE id=?", (request_id,)).fetchone()
            if prior is not None:
                if str(prior["payload"]) != payload:
                    raise BackendError("codemode_tool_conflict")
                return CodeToolBinding.model_validate_json(str(prior["binding"]))
            run = db.execute("SELECT * FROM code_runs WHERE id=? AND session=?", (value.run_id,value.session_id)).fetchone()
            catalog = db.execute("SELECT * FROM code_tools WHERE id=?", (value.run_id,)).fetchone()
            if (run is None or catalog is None or str(run["phase"]) != "unknown" or value.run_id not in self.cancels
                    or (self.cancels[value.run_id].is_set() and not value.cancel)):
                raise BackendError("codemode_run_inactive")
            definitions = TypeAdapter(list[dict[str, object]]).validate_json(str(catalog["tools"]))
            if not any(tool.get("name") == value.name for tool in definitions):
                raise BackendError("tool_not_offered")
            step_id = hashlib.sha256(f"direct:{value.session_id}:{request_id}".encode()).hexdigest()
            call = self.owner.resolve_model_call(str(catalog["mcp"]),ToolCall(id=str(value.sequence),name=value.name,arguments=json.dumps(value.arguments)),
                step_id[:32],str(catalog["plugins"]))
            result = CodeToolBinding(request_id=request_id, call=call, parent_request_id=str(run["parent_request"]), parent_step_id=str(run["parent_step"]))
            db.execute("INSERT INTO code_tool_calls VALUES(?,?,?,?,?)", (request_id,value.run_id,value.sequence,payload,result.model_dump_json()))
            return result
        return await self.owner.db.call(bind,write=True)

    async def _start_code(self, value: OpenCode) -> tuple[CodeView, asyncio.Task[CodeView] | None]:
        async with self.owner.control:
            self.owner.check_host(value)
            if value.parent_request_id or value.parent_step_id:
                await self.owner.validate_worker(WorkerRequest(session_id=value.session_id, worker_id=value.worker_id, build_id=value.build_id))
                if not value.parent_request_id or len(value.parent_step_id) != 64 or value.run_id != value.parent_step_id[:32]:
                    raise BackendError("codemode_parent_identity")
            if value.state_scope and (not value.parent_request_id or value.state_scope != value.parent_request_id):
                raise BackendError("codemode_state_scope")
            if value.initial_state is not None:
                try:
                    initial: object = json.loads(value.initial_state)
                except ValueError as error:
                    raise BackendError("codemode_state_invalid") from error
                if not isinstance(initial, dict):
                    raise BackendError("codemode_state_invalid")
            intent = value.model_dump_json(exclude={"host_epoch", "build_id", "worker_id"})
            existing = await self.owner.db.call(lambda db: db.execute("SELECT * FROM code_runs WHERE id=?", (value.run_id,)).fetchone())
            if existing is not None:
                if (existing["session"] != value.session_id or existing["source"] != value.source
                        or str(existing["parent_request"]) != value.parent_request_id or str(existing["parent_step"]) != value.parent_step_id
                        or existing["intent"] and str(existing["intent"]) != intent):
                    raise BackendError("codemode_conflict")
                return await self._code_view_with_state(existing), None
            self.owner.admit(value.session_id)
            if len(self.jobs) >= 8:
                raise BackendError("codemode_capacity")
            await self._code_blocked(value.session_id)
            workspace = self.owner.queries.session_workspace(value.session_id)
            servers = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE session=?", (value.session_id,)).fetchall())
            offers = offers_from_views([self.owner.mcp.view(row) for row in servers], surface="code")
            plugins = [offer for view in (await self.owner.plugins.list(value.session_id)).plugins for offer in PluginOffer.from_view(view,workspace)]
            options = self.owner.profile.config.provider.model_copy(update={"allowed_tools": value.allowed_tools, "excluded_tools": value.excluded_tools}) if value.parent_request_id else self.owner.profile.config.provider
            definitions = self.owner.code_tool_definitions(offers, options, plugins)
            cancelled = await self.owner.db.call(lambda db: db.execute(
                "SELECT session FROM code_cancellations WHERE id=?", (value.run_id,)).fetchone())
            if cancelled is not None and cancelled["session"] != value.session_id:
                raise BackendError("codemode_conflict")
            def reserve(db: sqlite3.Connection) -> None:
                db.execute("INSERT INTO code_runs(id,session,source,phase,parent_request,parent_step,intent) VALUES(?,?,?,'unknown',?,?,?)",
                           (value.run_id, value.session_id, value.source, value.parent_request_id, value.parent_step_id, intent))
                db.execute("INSERT INTO code_tools VALUES(?,?,?,?)",(value.run_id,json.dumps(definitions),catalog_payload(offers),
                    json.dumps([offer.model_dump() for offer in plugins],sort_keys=True)))
            await self.owner.db.call(reserve,write=True)
            event = threading.Event()
            if cancelled is not None:
                event.set()
            self.cancels[value.run_id] = event
            task = asyncio.create_task(self._run_code(value, definitions, event))
            self.jobs[value.run_id] = task
            def finished(result: asyncio.Task[CodeView]) -> None:
                self.jobs.pop(value.run_id, None)
                self.cancels.pop(value.run_id, None)
                if not result.cancelled():
                    result.exception()
            task.add_done_callback(finished)
        return CodeView(run_id=value.run_id, phase="unknown"), task

    async def run(self, value: OpenCode) -> CodeView:
        view, task = await self._start_code(value)
        return await asyncio.shield(task) if task is not None else view

    async def start(self, value: OpenCode) -> CodeStatus:
        view, _task = await self._start_code(value)
        return CodeStatus(view=view, running=value.run_id in self.jobs)

    async def status(self, value: CancelCode) -> CodeStatus:
        self.owner.check_host(value)
        row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM code_runs WHERE id=? AND session=?", (value.run_id, value.session_id)).fetchone())
        if row is None:
            raise BackendError("codemode_not_found", status=404)
        running = value.run_id in self.jobs
        return CodeStatus(view=await self._code_view_with_state(row) if running else await self.retire_run(row), running=running)

    async def _run_code(self, value: OpenCode, definitions: list[dict[str, object]], event: threading.Event) -> CodeView:
        saved = await self.owner.db.call(lambda db: db.execute(
            "SELECT document FROM code_state WHERE session=? AND scope=?", (value.session_id, value.state_scope)).fetchone())
        loaded: object = json.loads(str(saved["document"])) if saved else json.loads(value.initial_state or "{}")
        state = json_object(loaded)
        loop = asyncio.get_running_loop()
        dispatched: list[CodeToolDispatch] = []
        uncertain = threading.Event()

        async def invoke(request: CodeToolDispatch) -> dict[str, object]:
            ready = HostReady.model_validate_json((self.owner.profile.path / "ready.json").read_bytes())
            if ready.host_epoch != value.host_epoch or ready.build_id != self.owner.build or ready.profile_id != self.owner.profile.config.profile_id:
                raise BackendError("stale_host_epoch")
            client = httpx.AsyncClient(base_url=ready.url,trust_env=False,timeout=10,
                headers={"Authorization":"Bearer " + self.owner.profile.token})
            cancelled = False
            try:
                while True:
                    if event.is_set():
                        cancelled = True
                    response = await client.post("/control/code/tool/cancel" if cancelled else "/control/code/tool",
                        content=request.model_dump_json(),headers={"Content-Type":"application/json"})
                    if response.is_error:
                        raise BackendError("codemode_tool_transport",status=response.status_code)
                    received = CodeToolReceipt.model_validate_json(response.content)
                    receipt = received.receipt
                    if receipt.status in {"succeeded", "failed", "cancelled", "unknown", "interrupted"}:
                        if receipt.status == "unknown":
                            uncertain.set()
                            event.set()
                        if receipt.status != "succeeded":
                            return {"error":receipt.error or receipt.status,"_phase":receipt.status}
                        if request.name.startswith("plugin_") or request.name.startswith("mcp_"):
                            try:
                                result: object = json.loads(receipt.answer)
                                mapped = json_object(result)
                                if isinstance(result,dict) and received.images:
                                    result = {**mapped,"images":[{"type":"image","mimeType":image.media_type,"data":image.data_base64} for image in received.images]}
                                return {"result":result,"_phase":receipt.status}
                            except ValueError:
                                pass
                        return {"result":{"text":receipt.answer,"images":[{"type":"image","mimeType":image.media_type,"data":image.data_base64} for image in received.images]},"_phase":receipt.status} if received.images else {"result":receipt.answer,"_phase":receipt.status}
                    await asyncio.sleep(.1)
            finally:
                await client.aclose()

        def call_tool(message: dict[str, object]) -> dict[str, object]:
            request = CodeToolDispatch.model_validate({"host_epoch":value.host_epoch,"build_id":self.owner.build,
                "session_id":value.session_id,"run_id":value.run_id,"sequence":int(str(message.get("id"))),
                "name":message.get("name"),"arguments":message.get("arguments")})
            dispatched.append(request)
            future = asyncio.run_coroutine_threadsafe(invoke(request),loop)
            try:
                deadline = time.monotonic() + 310
                while True:
                    try:
                        result = future.result(timeout=.2)
                        break
                    except concurrent.futures.TimeoutError:
                        if event.is_set() or time.monotonic() >= deadline:
                            event.set()
                            future.cancel()
                            raise BackendError("codemode_tool_outcome_unknown") from None
            except BaseException:
                uncertain.set()
                event.set()
                future.cancel()
                raise
            return {"op":"tool_result","id":message["id"],**result}

        outcome = CodemodeOutcome("unknown")
        try:
            outcome = CodemodeOutcome("cancelled",clean=True) if event.is_set() else await asyncio.to_thread(
                run_codemode, value.source, state, profile=self.owner.profile.path,run_id=value.run_id,cancel=event,
                tools=[dict(tool) for tool in definitions],call_tool=call_tool)
        except Exception as error:
            before_spawn = isinstance(error,BackendError) and error.code in {"codemode_source_limit","codemode_runtime_missing"}
            outcome = CodemodeOutcome("failed" if before_spawn else "unknown",clean=before_spawn,
                error=error.code if isinstance(error, BackendError) else "codemode_runner_failed")
        finally:
            event.set()
            # Every dispatched child has its own durable cancellation/cleanup contract.
            cleanup = [asyncio.create_task(invoke(request)) for request in dispatched]
            if cleanup:
                try:
                    results = await asyncio.wait_for(asyncio.gather(*cleanup,return_exceptions=True),12)
                    if any(isinstance(result,BaseException) or result.get("_phase") == "unknown" for result in results):
                        outcome.phase, outcome.state = "unknown", None
                    else:
                        uncertain.clear()
                except TimeoutError:
                    outcome.phase, outcome.state = "unknown", None
        if uncertain.is_set():
            outcome.phase, outcome.state = "unknown", None
        kept = outcome.state
        if outcome.phase == "success" and kept is None:
            outcome.phase = "unknown"
        view = CodeView(run_id=value.run_id, phase=outcome.phase,
            value=json.dumps(outcome.value,ensure_ascii=False) if outcome.phase == "success" else "",
            state=json.dumps(kept,ensure_ascii=False,sort_keys=True) if outcome.phase == "success" else "",
            output=outcome.items,calls=outcome.calls,error=outcome.error,clean=outcome.clean,
            cancel_requested=await self.owner.db.call(lambda db: db.execute("SELECT 1 FROM code_cancellations WHERE id=?", (value.run_id,)).fetchone() is not None))
        def commit(db: sqlite3.Connection) -> None:
            db.execute("UPDATE code_runs SET phase=?,value=?,committed=? WHERE id=?",
                (view.phase,view.value,int(view.phase == "success"),value.run_id))
            if view.phase == "success":
                db.execute("INSERT INTO code_state(session,scope,document) VALUES(?,?,?) ON CONFLICT(session,scope) DO UPDATE SET document=excluded.document",
                    (value.session_id,value.state_scope,view.state))
            db.execute("INSERT INTO code_results VALUES(?,?)", (value.run_id,view.model_dump_json()))
        await self.owner.db.call(commit,write=True)
        return view

    async def _code_blocked(self, session_id: str) -> None:
        blocked = await self.owner.db.call(lambda db: db.execute(
            "SELECT 1 FROM code_runs c WHERE session=? AND phase='unknown' AND NOT EXISTS "
            "(SELECT 1 FROM code_results r JOIN code_cancellations x ON x.id=r.id "
            "WHERE r.id=c.id AND json_extract(r.document,'$.clean')=1)", (session_id,)).fetchone())
        if blocked is not None:
            raise BackendError("execution_cleanup_pending", status=503)

    async def _code_view_with_state(self, row: sqlite3.Row) -> CodeView:
        saved = await self.owner.db.call(lambda db: db.execute(
            "SELECT document FROM code_results WHERE id=?", (row["id"],)).fetchone())
        view = CodeView.model_validate_json(str(saved["document"])) if saved is not None else CodeView(run_id=str(row["id"]), phase="unknown")
        cancelled = await self.owner.db.call(lambda db: db.execute("SELECT 1 FROM code_cancellations WHERE id=?", (row["id"],)).fetchone())
        return view.model_copy(update={"cancel_requested":cancelled is not None})

    async def retire_run(self, row: sqlite3.Row) -> CodeView:
        view = await self._code_view_with_state(row)
        if view.clean or view.run_id in self.jobs:
            return view
        instance = "code-" + view.run_id
        path = self.owner.profile.path / "processes" / ("execution-"+instance+".lock")
        try:
            lease = ProcessLease.model_validate_json(path.read_bytes())
            if (lease.instance_id,lease.role,lease.profile_path,lease.path) != (instance,"execution",str(self.owner.profile.path),str(path)):
                raise BackendError("process_lease_owner_mismatch")
            clean = await reconcile(self.owner.profile.path / "executions" / instance,lease,permitted=True)
        except (OSError,ValueError,BackendError):
            return view
        if clean:
            view.clean = True
            await self.owner.db.call(lambda db: db.execute("INSERT INTO code_results VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
                (view.run_id,view.model_dump_json())),write=True)
        return view

    async def cancel(self, value: CancelCode) -> CodeView:
        async with self.owner.control:
            self.owner.check_host(value)
            self.owner.queries.session_workspace(value.session_id)
            def cancel(db: sqlite3.Connection) -> None:
                run = db.execute("SELECT session FROM code_runs WHERE id=?", (value.run_id,)).fetchone()
                prior = db.execute("SELECT session FROM code_cancellations WHERE id=?", (value.run_id,)).fetchone()
                if any(row is not None and row["session"] != value.session_id for row in (run,prior)):
                    raise BackendError("codemode_conflict")
                db.execute("INSERT OR IGNORE INTO code_cancellations VALUES(?,?)", (value.run_id,value.session_id))
            await self.owner.db.call(cancel,write=True)
            event = self.cancels.get(value.run_id)
            if event is not None:
                event.set()
            task = self.jobs.get(value.run_id)
        if task is not None:
            try:
                return await asyncio.wait_for(asyncio.shield(task),2.5)
            except TimeoutError:
                pass
        row = await self.owner.db.call(lambda db: db.execute(
            "SELECT * FROM code_runs WHERE id=? AND session=?", (value.run_id, value.session_id)).fetchone())
        return CodeView(run_id=value.run_id,phase="cancelled",clean=True,cancel_requested=True) if row is None else await self.retire_run(row)

    async def stop_all(self, session: str = "") -> None:
        ids = None if not session else {str(row[0]) for row in await self.owner.db.call(lambda db: db.execute(
            "SELECT id FROM code_runs WHERE session=?", (session,)).fetchall())}
        for run_id, event in list(self.cancels.items()):
            if ids is None or run_id in ids:
                event.set()
        tasks = [task for run_id, task in self.jobs.items() if ids is None or run_id in ids]
        if tasks:
            try:
                await asyncio.wait_for(asyncio.shield(asyncio.gather(*tasks,return_exceptions=True)),25)
            except TimeoutError:
                raise BackendError("codemode_cleanup_pending",status=503) from None
