"""Session plugin operations owned by the Supervisor."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING

import httpx
from pydantic import TypeAdapter

from amazme_backend.contracts.execution import (
    ProcessLease,
)
from amazme_backend.contracts.ipc.supervisor import (
    CancelPlugin,
    ClosePlugin,
    OpenPlugin,
    PluginCallEnvelope,
    ReloadPlugin,
    StopWorker,
    WorkerRequest,
)
from amazme_backend.contracts.plugins import (
    PluginCallView,
    PluginList,
    PluginResult,
    PluginTool,
    PluginView,
)
from amazme_backend.execution.native import (
    reconcile,
)
from amazme_backend.execution.plugins.client import (
    PluginClient,
    entry_digest,
    plugin_fingerprint,
    set_fingerprint,
    stored_config,
    validate_config,
)
from amazme_backend.execution.processes import ProcessReservation, exited
from amazme_backend.execution.services import ServiceProcess
from amazme_backend.shared.errors import BackendError
from amazme_backend.workspaces.paths import PRIMARY

if TYPE_CHECKING:
    from amazme_backend.execution.supervisor import Supervisor


class PluginOperations:
    def __init__(self, owner: Supervisor):
        self.owner = owner
        self.clients: dict[str, PluginClient] = {}
        self.jobs: dict[str, asyncio.Task[PluginCallView]] = {}
        self.job_requests: dict[str, str] = {}

    async def set_fingerprint(self, session_id: str = "") -> str:
        rows = await self.owner.db.call(lambda db: db.execute("SELECT fingerprint FROM plugins WHERE session=? AND phase!='removed'", (session_id,)).fetchall())
        return set_fingerprint([str(row[0]) for row in rows])

    def _plugin_view(self, row: sqlite3.Row) -> PluginView:
        client = self.clients.get(str(row["id"]))
        phase = str(row["phase"])
        if phase == "loading" and client is None:
            phase = "unknown"
        if phase == "ready" and (client is None or not client.ready or client.process.process.returncode is not None):
            phase = "disconnected"
        tools = TypeAdapter(list[PluginTool]).validate_json(str(row["tools"]))
        return PluginView.model_validate({"plugin_id":str(row["id"]), "session_id":str(row["session"]), "name":str(row["name"]),
            "capabilities":[tool.name for tool in tools], "tools":[tool.model_dump() for tool in tools],
            "config":stored_config(json.loads(str(row["config"]))), "fingerprint":str(row["fingerprint"]),
            "entry":str(row["entry"]), "phase":phase, "load_id":str(row["load_id"]), "error":str(row["error"])})

    async def list(self, session_id: str = "") -> PluginList:
        rows = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE phase!='removed'" + (" AND session=?" if session_id else "") + " ORDER BY name",
            (session_id,) if session_id else ()).fetchall())
        return PluginList(plugins=[self._plugin_view(row) for row in rows])

    async def _live_plugin_mismatch(self, expected: str, session_id: str) -> bool:
        for worker in await self.owner.workers(session_id):
            if worker.state == "stopped" or worker.process_lease is None or exited(worker.process_lease):
                continue
            if worker.plugin_fingerprint != expected:
                return True
        return False

    async def _plugin_change_blocked(self, upcoming: str, session_id: str) -> None:
        plugin_ids = {view.plugin_id for view in (await self.list(session_id)).plugins}
        if any(client.pending for plugin_id, client in self.clients.items() if plugin_id in plugin_ids):
            raise BackendError("plugin_reload_blocked", status=409)
        running_codes = await self.owner.db.call(lambda db: db.execute("SELECT id FROM code_runs WHERE session=?", (session_id,)).fetchall())
        if any(str(row[0]) in self.owner.code.jobs for row in running_codes):
            raise BackendError("plugin_reload_blocked", status=409)
        for worker in await self.owner.workers(session_id):
            if worker.plugin_fingerprint == upcoming or worker.state == "stopped" or (worker.process_lease is not None and exited(worker.process_lease)):
                continue
            if worker.state == "starting" and worker.process_lease is not None:
                try:
                    identity = await self.owner.peer_identity(worker)
                except (BackendError, httpx.TransportError, TimeoutError) as error:
                    raise BackendError("plugin_reload_blocked", status=409) from error
                if identity.state != "ready" or identity.host_epoch != self.owner.host_epoch:
                    raise BackendError("plugin_reload_blocked", status=409)
                worker.state, worker.fingerprint, worker.host_epoch = "ready", identity.fingerprint, identity.host_epoch
                await self.owner.save_worker(worker)
            if worker.state != "ready" or worker.process_lease is None:
                raise BackendError("plugin_reload_blocked", status=409)
            # Idle admission and stopping share the worker's SQLite transaction. A racing submission
            # either remains active and rejects this change, or observes stopping and keeps its ID.
            try:
                await self.owner.peer_identity(worker, "POST", "/stop", StopWorker(
                    build_id=worker.build_id, host_epoch=self.owner.host_epoch, session_id=session_id,
                    worker_id=worker.worker_id, execution_epoch=worker.execution_epoch,
                    reason="update", require_idle=True))
            except (BackendError, httpx.TransportError, TimeoutError) as error:
                raise BackendError("plugin_reload_blocked", status=409) from error
            proof = await self.owner.retire_worker(worker, "update")
            if proof.state != "clean":
                raise BackendError("execution_cleanup_pending", status=503)

    async def _plugin_fingerprint_ready(self, expected: str, session_id: str) -> None:
        if await self._live_plugin_mismatch(expected, session_id):
            raise BackendError("plugin_fingerprint_mismatch", status=409)

    async def _close_plugin(self, row: sqlite3.Row) -> bool:
        if str(row["phase"]) == "removed":
            return True
        plugin_id = str(row["id"])
        client = self.clients.get(plugin_id)
        if client is not None:
            await client.close()
        clean = not str(row["lease"]) or await reconcile(Path(str(row["directory"])),
            ProcessLease.model_validate_json(str(row["lease"])), permitted=True)
        if clean:
            self.clients.pop(plugin_id, None)
            await self.owner.db.call(lambda db: db.execute("UPDATE plugin_calls SET clean=1 WHERE plugin=? AND fingerprint=? AND phase='unknown'",
                (plugin_id, str(row["fingerprint"]))), write=True)
        await self.owner.db.call(lambda db: db.execute("UPDATE plugins SET phase=? WHERE id=?",
            ("disconnected" if clean else "unknown", plugin_id)), write=True)
        return clean

    async def close_all(self, session: str = "", *, require_clean: bool = True) -> None:
        rows = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE 1 AND (?='' OR session=?)", (session, session)).fetchall())
        results = await asyncio.gather(*(self._close_plugin(row) for row in rows), return_exceptions=True)
        if require_clean and any(result is not True for result in results):
            raise BackendError("execution_cleanup_pending", status=503)

    async def _load_plugin(self, plugin_id: str, load_id: str) -> PluginView:
        row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (plugin_id,)).fetchone())
        assert row is not None
        instance = hashlib.sha256(("plugin:" + plugin_id + ":" + load_id).encode()).hexdigest()[:32]
        directory = self.owner.profile.path / "executions" / instance
        directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        phase, error = "unknown", "plugin_load_interrupted"
        tools: list[PluginTool] = []
        try:
            with ProcessReservation(self.owner.profile.path, "execution", instance) as reservation:
                await self.owner.db.call(lambda db: db.execute("UPDATE plugins SET lease=?,directory=? WHERE id=?",
                    (reservation.lease.model_dump_json(), str(directory), plugin_id)), write=True)
                process = await ServiceProcess.start(self.owner.profile.path, instance, directory, reservation, "plugin")
            client = PluginClient(process)
            self.clients[plugin_id] = client
            workspace = self.owner.queries.session_workspace(str(row["session"]))
            location = self.owner.profile.config.workspace if workspace == PRIMARY else dict(self.owner.queries.load_grants()).get(workspace)
            if location is None:
                raise BackendError("workspace_not_found")
            reply = await client.load(str(row["entry"]), str(row["source_digest"]), stored_config(json.loads(str(row["config"]))), str(row["session"]), str(location))
            phase, error, tools = reply.phase, reply.error, reply.tools
        except (OSError, ValueError, BackendError, TimeoutError) as failure:
            error = failure.code if isinstance(failure, BackendError) else type(failure).__name__
        if phase != "ready":
            current = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (plugin_id,)).fetchone())
            assert current is not None
            if not await self._close_plugin(current):
                phase = "unknown"
        await self.owner.db.call(lambda db: db.execute("UPDATE plugins SET phase=?,error=?,tools=?,capabilities=? WHERE id=?",
            (phase, error, json.dumps([tool.model_dump() for tool in tools]), json.dumps([tool.name for tool in tools]), plugin_id)), write=True)
        current = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (plugin_id,)).fetchone())
        assert current is not None
        view = self._plugin_view(current)
        await self.owner.db.call(lambda db: db.execute("UPDATE plugin_loads SET result=? WHERE id=?",
            (view.model_dump_json(), load_id)), write=True)
        return view

    async def register(self, value: OpenPlugin) -> PluginView:
        async with self.owner.control:
            self.owner.check_host(value)
            self.owner.admit()
            config = validate_config(value.config)
            load_id = "register:" + value.plugin_id
            identity = hashlib.sha256(json.dumps(value.model_dump(mode="json", exclude={"host_epoch", "build_id"}), sort_keys=True).encode()).hexdigest()
            existing = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            if existing is not None:
                previous = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugin_loads WHERE id=?", (load_id,)).fetchone())
                if previous is None or str(previous["digest"]) != identity:
                    raise BackendError("plugin_conflict")
                return self._plugin_view(existing)
            self.owner.admit(value.session_id)
            if len(self.clients) >= 8:
                raise BackendError("plugin_capacity", status=429)
            entry, source_digest = entry_digest(value.entry)
            fingerprint = plugin_fingerprint(value.plugin_id, value.name, config, entry=entry, source_digest=source_digest, load_id=load_id)
            self.owner.queries.session_workspace(value.session_id)
            current = [str(row[0]) for row in await self.owner.db.call(lambda db: db.execute("SELECT fingerprint FROM plugins WHERE session=? AND phase!='removed'", (value.session_id,)).fetchall())]
            await self._plugin_change_blocked(set_fingerprint([*current, fingerprint]), value.session_id)
            def accepted(db: sqlite3.Connection) -> None:
                db.execute("INSERT INTO plugins(id,name,session,capabilities,config,fingerprint,entry,source_digest,load_id,phase) VALUES(?,?,?,'[]',?,?,?,?,?,'loading')",
                    (value.plugin_id, value.name, value.session_id, json.dumps(config), fingerprint, entry, source_digest, load_id))
                db.execute("INSERT INTO plugin_loads(id,plugin,digest) VALUES(?,?,?)", (load_id, value.plugin_id, identity))
            await self.owner.db.call(accepted, write=True)
            return await self._load_plugin(value.plugin_id, load_id)

    async def reload(self, value: ReloadPlugin) -> PluginView:
        async with self.owner.control:
            self.owner.check_host(value)
            self.owner.admit()
            current = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            if current is None:
                raise BackendError("plugin_not_found", status=404)
            if str(current["session"]) != value.session_id:
                raise BackendError("plugin_session_mismatch")
            # Pin retries to the request bytes, before observing a possibly changed entry file.
            identity = hashlib.sha256(json.dumps(value.model_dump(mode="json", exclude={"host_epoch", "build_id"}), sort_keys=True).encode()).hexdigest()
            load_id = "reload:" + value.reload_id
            previous = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugin_loads WHERE id=?", (load_id,)).fetchone())
            if previous is not None:
                if str(previous["digest"]) != identity or str(previous["plugin"]) != value.plugin_id:
                    raise BackendError("plugin_reload_conflict")
                return PluginView.model_validate_json(str(previous["result"])) if str(previous["result"]) else self._plugin_view(current)
            if str(current["phase"]) == "removed":
                raise BackendError("plugin_removed")
            self.owner.admit(value.session_id)
            config = validate_config(value.config)
            entry, source_digest = entry_digest(value.entry or str(current["entry"]))
            fingerprint = plugin_fingerprint(value.plugin_id, str(current["name"]), config, entry=entry, source_digest=source_digest, load_id=load_id)
            others = [str(row[0]) for row in await self.owner.db.call(lambda db: db.execute(
                "SELECT fingerprint FROM plugins WHERE id!=? AND session=? AND phase!='removed'", (value.plugin_id, value.session_id)).fetchall())]
            await self._plugin_change_blocked(set_fingerprint([*others, fingerprint]), value.session_id)
            if not await self._close_plugin(current):
                raise BackendError("execution_cleanup_pending", status=503)
            def accepted(db: sqlite3.Connection) -> None:
                db.execute("INSERT INTO plugin_loads(id,plugin,digest) VALUES(?,?,?)", (load_id, value.plugin_id, identity))
                db.execute("UPDATE plugins SET config=?,fingerprint=?,entry=?,source_digest=?,load_id=?,phase='loading',error='',lease='',directory='' WHERE id=?",
                    (json.dumps(config), fingerprint, entry, source_digest, load_id, value.plugin_id))
            await self.owner.db.call(accepted, write=True)
            return await self._load_plugin(value.plugin_id, load_id)

    def _plugin_call(self, row: sqlite3.Row) -> PluginCallView:
        result = PluginResult.model_validate_json(str(row["result"])) if str(row["result"]) else None
        return PluginCallView.model_validate({"call_id":str(row["id"]), "phase":str(row["phase"]),
                                              "result":result, "error":str(row["error"]), "cancel_requested":bool(row["cancel_requested"]), "clean":bool(row["clean"])})

    async def call(self, value: PluginCallEnvelope) -> PluginCallView:
        self.owner.check_host(value)
        identity = value.intent_payload()
        if value.call_id in self.job_requests and self.job_requests[value.call_id] != identity:
            raise BackendError("plugin_call_conflict")
        if value.call_id not in self.jobs:
            task = asyncio.create_task(self._execute_plugin(value))
            self.jobs[value.call_id] = task
            self.job_requests[value.call_id] = identity
            def finished(result: asyncio.Task[PluginCallView]) -> None:
                if self.jobs.get(value.call_id) is result:
                    self.jobs.pop(value.call_id, None)
                    self.job_requests.pop(value.call_id, None)
                if not result.cancelled():
                    result.exception()
            task.add_done_callback(finished)
        return await asyncio.shield(self.jobs[value.call_id])

    async def _execute_plugin(self, value: PluginCallEnvelope) -> PluginCallView:
        async with self.owner.control:
            self.owner.check_host(value)
            plugin = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            if plugin is None:
                raise BackendError("plugin_not_found", status=404)
            if str(plugin["session"]) != value.session_id:
                raise BackendError("plugin_session_mismatch")
            if value.origin == "model":
                worker = await self.owner.validate_worker(WorkerRequest(session_id=value.session_id,worker_id=value.worker_id,build_id=value.build_id))
                if (worker.purpose == "validation" or value.kind != "tool" or not value.request_id or len(value.step_id) != 64
                        or value.call_id != value.step_id[:32]):
                    raise BackendError("plugin_model_identity")
            payload = value.intent_payload()
            existing = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugin_calls WHERE id=?", (value.call_id,)).fetchone())
            if existing is not None:
                if (str(existing["plugin"]), str(existing["session"]), str(existing["text"])) != (value.plugin_id, value.session_id, payload):
                    raise BackendError("plugin_call_conflict")
                if not existing["clean"] and value.plugin_id not in self.clients:
                    await self._close_plugin(plugin)
                    existing = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugin_calls WHERE id=?", (value.call_id,)).fetchone())
                    assert existing is not None
                return self._plugin_call(existing)
            if str(plugin["phase"]) == "removed":
                raise BackendError("plugin_removed")
            cancelled = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugin_cancels WHERE id=?", (value.call_id,)).fetchone())
            if cancelled is not None:
                if (str(cancelled["plugin"]), str(cancelled["session"])) != (value.plugin_id, value.session_id):
                    raise BackendError("plugin_call_conflict")
                await self.owner.db.call(lambda db: db.execute("INSERT INTO plugin_calls(id,plugin,session,text,phase,cancel_requested,clean) VALUES(?,?,?,?,'cancelled',1,1)",
                    (value.call_id, value.plugin_id, value.session_id, payload)), write=True)
                return PluginCallView(call_id=value.call_id, phase="cancelled", cancel_requested=True, clean=True)
            self.owner.admit(value.session_id)
            if await self.owner.write_conflict(value.session_id):
                raise BackendError("unknown_effect_conflict", status=503)
            await self._plugin_fingerprint_ready(await self.set_fingerprint(value.session_id), value.session_id)
            if self.owner.queries.session_workspace(value.session_id) != value.workspace:
                raise BackendError("workspace_mismatch")
            workspace = self.owner.profile.config.workspace if value.workspace == PRIMARY else dict(self.owner.queries.load_grants()).get(value.workspace)
            if workspace is None:
                raise BackendError("workspace_not_found")
            client = self.clients.get(value.plugin_id)
            if client is None or not client.ready:
                raise BackendError("plugin_disconnected", "Explicitly reload the plugin", 503)
            if client.pending:
                raise BackendError("plugin_busy", status=429)
            if not any(tool.name == value.name and tool.kind == value.kind for tool in client.tools):
                raise BackendError("plugin_tool_not_found", status=404)
            if value.origin == "model":
                tool = next(tool for tool in client.tools if tool.name == value.name and tool.kind == value.kind)
                if (value.expected_fingerprint != str(plugin["fingerprint"]) or value.expected_load_id != str(plugin["load_id"])
                        or value.expected_schema_digest != tool.schema_digest()):
                    raise BackendError("plugin_catalog_conflict")
            elif ((value.expected_fingerprint or value.expected_load_id)
                  and (value.expected_fingerprint != str(plugin["fingerprint"]) or value.expected_load_id != str(plugin["load_id"]))):
                raise BackendError("plugin_catalog_conflict")
            await self.owner.db.call(lambda db: db.execute(
                "INSERT INTO plugin_calls(id,plugin,session,text,phase,fingerprint,step_id,request_id,origin) VALUES(?,?,?,?,'unknown',?,?,?,?)",
                (value.call_id, value.plugin_id, value.session_id, payload, str(plugin["fingerprint"]),
                 value.step_id, value.request_id, value.origin)), write=True)
            # Reserve before releasing control, so another call cannot overtake the journaled one.
            client.pending = value.call_id
        phase, result, error, clean = "unknown", "", "plugin_outcome_unknown", False
        try:
            client.pending = ""
            reply = await client.call(value.call_id, value.name, value.arguments, str(workspace), value.session_id, value.kind)
            phase, result, error, clean = reply.phase, reply.result.model_dump_json() if reply.result else "", reply.error, False
        except asyncio.CancelledError:
            client.ready = False
            await asyncio.shield(self._close_plugin(plugin))
            raise
        except (OSError, ValueError, BackendError, TimeoutError) as failure:
            client.ready = False
            clean = await self._close_plugin(plugin)
            error = failure.code if isinstance(failure, BackendError) else type(failure).__name__
        finally:
            client.pending = ""
        await self.owner.db.call(lambda db: db.execute("UPDATE plugin_calls SET phase=?,result=?,error=?,clean=? WHERE id=?",
            (phase, result, error, int(clean), value.call_id)), write=True)
        row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugin_calls WHERE id=?", (value.call_id,)).fetchone())
        assert row is not None
        return self._plugin_call(row)

    async def close(self, value: ClosePlugin) -> PluginView:
        async with self.owner.control:
            self.owner.check_host(value)
            row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            if row is None or str(row["session"]) != value.session_id:
                raise BackendError("plugin_session_mismatch")
            await self._close_plugin(row)
            current = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            assert current is not None
            return self._plugin_view(current)

    async def remove(self, value: ClosePlugin) -> PluginView:
        async with self.owner.control:
            self.owner.check_host(value)
            row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            if row is None or str(row["session"]) != value.session_id:
                raise BackendError("plugin_session_mismatch")
            if str(row["phase"]) != "removed":
                others = [str(item[0]) for item in await self.owner.db.call(lambda db: db.execute(
                    "SELECT fingerprint FROM plugins WHERE session=? AND id!=? AND phase!='removed'",
                    (value.session_id, value.plugin_id)).fetchall())]
                await self._plugin_change_blocked(set_fingerprint(others), value.session_id)
                if not await self._close_plugin(row):
                    raise BackendError("execution_cleanup_pending", status=503)
                await self.owner.db.call(lambda db: db.execute("UPDATE plugins SET phase='removed' WHERE id=?", (value.plugin_id,)), write=True)
            current = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            assert current is not None
            return self._plugin_view(current)

    async def cancel(self, value: CancelPlugin) -> PluginCallView:
        async with self.owner.control:
            self.owner.check_host(value)
            plugin = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            if plugin is None or str(plugin["session"]) != value.session_id:
                raise BackendError("plugin_session_mismatch")
            row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugin_calls WHERE id=?", (value.call_id,)).fetchone())
            previous = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugin_cancels WHERE id=?", (value.call_id,)).fetchone())
            for record in [row, previous]:
                if record is not None and (str(record["plugin"]), str(record["session"])) != (value.plugin_id, value.session_id):
                    raise BackendError("plugin_call_conflict")
            if row is not None and str(row["phase"]) != "unknown":
                return self._plugin_call(row)
            await self.owner.db.call(lambda db: db.execute("INSERT OR IGNORE INTO plugin_cancels VALUES(?,?,?)",
                (value.call_id, value.plugin_id, value.session_id)), write=True)
            if row is None:
                return PluginCallView(call_id=value.call_id, phase="cancelled", cancel_requested=True, clean=True)
            await self.owner.db.call(lambda db: db.execute("UPDATE plugin_calls SET cancel_requested=1 WHERE id=?", (value.call_id,)), write=True)
            plugin = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugins WHERE id=?", (value.plugin_id,)).fetchone())
            assert plugin is not None
            client = self.clients.get(value.plugin_id)
            if client is not None and client.pending == value.call_id:
                with contextlib.suppress(OSError, BackendError):
                    await client.send({"op":"cancel", "call_id":value.call_id})
                clean = await self._close_plugin(plugin)
                await self.owner.db.call(lambda db: db.execute("UPDATE plugin_calls SET clean=? WHERE id=?", (int(clean), value.call_id)), write=True)
            current = await self.owner.db.call(lambda db: db.execute("SELECT * FROM plugin_calls WHERE id=?", (value.call_id,)).fetchone())
            assert current is not None
            return self._plugin_call(current)

    async def close_handles(self) -> None:
        for client in list(self.clients.values()):
            await client.close()
        await asyncio.gather(*list(self.jobs.values()), return_exceptions=True)
        self.clients.clear()
