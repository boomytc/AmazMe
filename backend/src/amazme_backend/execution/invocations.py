"""Native invocations owned by one Supervisor."""

from __future__ import annotations

import asyncio
import hashlib
import sqlite3
import time
from pathlib import Path
from typing import TYPE_CHECKING

from amazme_backend.contracts.execution import (
    ProcessLease,
    ToolObservation,
    ToolResult,
)
from amazme_backend.contracts.ipc.supervisor import (
    RunTool,
    ToolLookup,
)
from amazme_backend.execution.native import (
    LocalPermit,
    LocalProcess,
    reconcile,
)
from amazme_backend.execution.output import ARCHIVE_LIMIT, RETENTION_SECONDS
from amazme_backend.execution.processes import ProcessReservation
from amazme_backend.execution.state import tool_outcome
from amazme_backend.shared.errors import BackendError
from amazme_backend.workspaces.paths import PRIMARY, tool_path

if TYPE_CHECKING:
    from amazme_backend.execution.supervisor import Supervisor


class InvocationOperations:
    def __init__(self, owner: Supervisor):
        self.owner = owner
        self.jobs: dict[str, asyncio.Task[ToolResult]] = {}
        self.job_requests: dict[str, RunTool] = {}
        self.channels: dict[str, LocalProcess] = {}

    async def scope(self, call: str) -> sqlite3.Row | None:
        return await self.owner.db.call(lambda db: db.execute("SELECT * FROM scopes WHERE id=?", (call,)).fetchone())

    async def phase(self, call: str, phase: str) -> None:
        await self.owner.db.call(lambda db: db.execute(
            "UPDATE scopes SET phase=? WHERE id=? AND outcome='pending'", (phase, call)), write=True)

    async def _reserve_output(self) -> int:
        now = int(time.time())
        expired = await self.owner.db.call(lambda db: db.execute(
            "SELECT id,directory FROM scopes WHERE log_expires>0 AND log_expires<=? AND clean=1", (now,)).fetchall())
        for row in expired:
            for name in ("stdout.log", "stderr.log", "output.json"):
                (Path(str(row["directory"])) / name).unlink(missing_ok=True)
            for temporary in Path(str(row["directory"])).glob("output.json.*"):
                temporary.unlink()
            await self.owner.db.call(lambda db: db.execute(
                "UPDATE scopes SET log_expires=0 WHERE id=?", (row["id"],)), write=True)
        count = await self.owner.db.call(lambda db: int(db.execute(
            "SELECT count(*) FROM scopes WHERE log_expires>0").fetchone()[0]))
        return now + RETENTION_SECONDS if count < ARCHIVE_LIMIT else 0

    async def execute(self, value: RunTool) -> ToolResult:
        channel: LocalProcess | None = None
        admitted = False
        try:
            async with self.owner.control:
                await self.owner.check_lease(value, admit=False)
                worker = await self.owner.worker(value.worker_id)
                if worker.purpose == "validation":
                    raise BackendError("validation_tools_forbidden")
                digest = hashlib.sha256(value.model_dump_json().encode()).hexdigest()
                old = await self.scope(value.call_id)
                if old is not None:
                    if old["digest"] != digest:
                        raise BackendError("call_conflict")
                    if old["outcome"] == "completed":
                        return ToolResult.model_validate_json(str(old["result"]))
                    raise BackendError("tool_outcome_unknown")
                self.owner.admit(value.session_id)
                if value.effect == "write" and await self.owner.write_conflict(value.session_id):
                    raise BackendError("unknown_effect_conflict", status=503)
                workspace = self.owner.queries.session_workspace(value.session_id)
                location = self.owner.profile.config.workspace if workspace == PRIMARY else dict(self.owner.queries.load_grants()).get(workspace)
                if location is None:
                    raise BackendError("workspace_not_found")
                root = Path(location)
                output_directory = ""
                if value.output_read is not None:
                    source = await self.scope(value.output_read.locator)
                    if source is None:
                        raise BackendError("output_not_found", status=404)
                    if source["session"] != value.session_id:
                        raise BackendError("output_scope_mismatch", status=403)
                    if source["log_workspace"] != str(root.resolve()):
                        raise BackendError("output_workspace_mismatch", status=403)
                    if int(source["log_expires"]) <= int(time.time()):
                        raise BackendError("output_expired", status=410)
                    output_directory = str(source["directory"])
                file = value.file
                if file is not None:
                    name, inner = tool_path(workspace, file.path)
                    if name == "grant" or not inner:
                        raise BackendError("invalid_workspace_path")
                    if name == PRIMARY:
                        root = Path(self.owner.profile.config.workspace)
                    else:
                        location = dict(self.owner.queries.load_grants()).get(name)
                        if location is None:
                            raise BackendError("workspace_not_found")
                        root = Path(location)
                    file = file.model_copy(update={"path": inner})
                instance = hashlib.sha256(value.call_id.encode()).hexdigest()[:32]
                directory = self.owner.profile.path / "executions" / instance
                log_expires = await self._reserve_output() if file is None and value.output_read is None else 0
                directory.mkdir(mode=0o700, parents=True, exist_ok=False)
                with ProcessReservation(self.owner.profile.path, "execution", instance) as reservation:
                    await self.owner.db.call(lambda db: db.execute(
                        "INSERT INTO scopes(id,session,epoch,worker,supervisor,build,request,directory,lease,digest,phase,effect,log_expires,log_workspace) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,'registered',?,?,?)",
                        (value.call_id, value.session_id, value.execution_epoch, value.worker_id, self.owner.instance,
                         self.owner.build, value.request_id, str(directory), reservation.lease.model_dump_json(), digest,
                         value.effect, log_expires, str(root.resolve()))), write=True)
                    admitted = True
                    await self._hit("create_intent", value)
                    channel = await LocalProcess.start(self.owner.profile.path, instance, directory, reservation)
                    self.channels[value.call_id] = channel
                await self._hit("registered", value)
                await self._hit("before_permit", value)
                await self.owner.check_lease(value)
                await self.phase(value.call_id, "permit_intent")
                await channel.permit(LocalPermit(call_id=value.call_id, cwd=str(root), command=value.command,
                    timeout_seconds=value.timeout_seconds, file=file, expected_digest=value.expected_digest,
                    output_read=value.output_read, output_directory=output_directory, log_expires=log_expires,
                    log_error="output_capacity" if not log_expires else ""))
                await self._hit("permit_sent", value)
                await self.phase(value.call_id, "permitted")
                await self._hit("permitted", value)
            report = await channel.collect()
            if report.call_id != value.call_id or report.result is None:
                raise BackendError("tool_outcome_unknown")
            result = report.result
            async with self.owner.control:
                def captured(db: sqlite3.Connection) -> None:
                    changed = db.execute("UPDATE scopes SET outcome='completed',phase='result',result=? "
                        "WHERE id=? AND worker=? AND epoch=? AND supervisor=? AND outcome='pending' AND clean=0",
                        (result.model_dump_json(), value.call_id, value.worker_id, value.execution_epoch,
                         self.owner.instance)).rowcount
                    if changed != 1:
                        raise BackendError("tool_outcome_unknown")
                await self.owner.db.call(captured, write=True)
                await self._hit("result", value)
                scope = await self.scope(value.call_id)
                assert scope is not None
                await self.clean_scope(scope)
            return result
        except BaseException:
            if admitted:
                await self.owner.db.call(lambda db: db.execute("UPDATE scopes SET outcome='unknown' WHERE id=? "
                    "AND worker=? AND epoch=? AND supervisor=? AND outcome='pending'",
                    (value.call_id, value.worker_id, value.execution_epoch, self.owner.instance)), write=True)
            raise
        finally:
            if channel is not None:
                await channel.close()
            self.channels.pop(value.call_id, None)

    async def _hit(self, point: str, value: RunTool) -> None:
        await self.owner.faults.hit(point, session_id=value.session_id, request_id=value.request_id, call_id=value.call_id)

    async def run(self, value: RunTool) -> ToolResult:
        # A disconnected HTTP waiter does not cancel the supervisor-owned operation.
        if value.call_id in self.job_requests and self.job_requests[value.call_id] != value:
            raise BackendError("call_conflict")
        if value.call_id not in self.jobs:
            if len(self.jobs) >= 16:
                raise BackendError("execution_capacity", status=429)
            task = asyncio.create_task(self.execute(value))
            self.jobs[value.call_id], self.job_requests[value.call_id] = task, value
            def finished(done: asyncio.Task[ToolResult]) -> None:
                if self.jobs.get(value.call_id) is done:
                    self.jobs.pop(value.call_id, None)
                    self.job_requests.pop(value.call_id, None)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(finished)
        return await asyncio.shield(self.jobs[value.call_id])

    async def lookup(self, value: ToolLookup) -> ToolObservation:
        await self.owner.validate_worker(value)
        scope = await self.scope(value.call_id)
        if scope is None:
            return ToolObservation(call_id=value.call_id, state="not_found")
        if scope["session"] != value.session_id:
            raise BackendError("call_scope_mismatch")
        state = tool_outcome(str(scope["outcome"]))
        return ToolObservation(call_id=value.call_id, state=state,
                               result=ToolResult.model_validate_json(str(scope["result"])) if scope["result"] else None,
                               resource_clean=bool(scope["clean"]))

    async def clean_scope(self, scope: sqlite3.Row) -> None:
        if scope["clean"]:
            return
        channel = self.channels.get(str(scope["id"]))
        if channel:
            await channel.close()
        directory = Path(str(scope["directory"]))
        lease = ProcessLease.model_validate_json(str(scope["lease"]))
        if not await reconcile(directory, lease, permitted=scope["phase"] != "registered"):
            raise BackendError("stop_unconfirmed", status=503)
        await self.owner.faults.hit("cleanup_proven", session_id=str(scope["session"]), call_id=str(scope["id"]))
        await self.owner.db.call(lambda db: db.execute("UPDATE scopes SET clean=1 WHERE id=?", (scope["id"],)), write=True)

    async def cancel_all(self, session: str = "", epoch: int | None = None) -> None:
        tasks = [task for key, task in self.jobs.items() if task is not asyncio.current_task()
                 and (not session or self.job_requests[key].session_id == session)
                 and (epoch is None or self.job_requests[key].execution_epoch == epoch)]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def close_handles(self) -> None:
        for channel in list(self.channels.values()):
            await channel.close()
