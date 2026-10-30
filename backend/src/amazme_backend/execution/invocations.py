"""Native invocations owned by one Supervisor."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from amazme_backend.contracts.execution import (
    EditFile,
    JobList,
    JobOutputView,
    JobState,
    JobView,
    ProcessLease,
    ToolObservation,
    ToolResult,
    WriteFile,
)
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.ipc.supervisor import (
    JobOutputQuery,
    JobReference,
    JobSession,
    RunTool,
    ToolLookup,
)
from amazme_backend.execution.native import (
    LocalPermit,
    LocalProcess,
    reconcile,
)
from amazme_backend.execution.output import ARCHIVE_LIMIT, RETENTION_SECONDS, read_archive, read_output
from amazme_backend.execution.processes import ProcessReservation
from amazme_backend.execution.state import tool_outcome
from amazme_backend.shared.errors import BackendError
from amazme_backend.workspaces.paths import PRIMARY, client_path, tool_path

BACKGROUND_LIMIT = 16
SESSION_BACKGROUND_LIMIT = 4

if TYPE_CHECKING:
    from amazme_backend.execution.supervisor import Supervisor


@dataclass(frozen=True)
class Inflight:
    value: RunTool
    acknowledged: asyncio.Future[ToolResult]


class InvocationOperations:
    def __init__(self, owner: Supervisor):
        self.owner = owner
        self.jobs: dict[str, asyncio.Task[ToolResult]] = {}
        self.job_requests: dict[str, Inflight] = {}
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

    async def execute(self, value: RunTool, acknowledged: asyncio.Future[ToolResult]) -> ToolResult:
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
                    if old["job_ack"]:
                        result = ToolResult.model_validate_json(str(old["job_ack"]))
                        acknowledged.set_result(result)
                        return result
                    if old["outcome"] == "completed":
                        result = ToolResult.model_validate_json(str(old["result"]))
                        acknowledged.set_result(result)
                        return result
                    raise BackendError("tool_outcome_unknown")
                self.owner.admit(value.session_id)
                if value.run_in_background:
                    if value.file is not None or value.output_read is not None or value.patch is not None:
                        raise BackendError("background_command_required")
                    counts = await self.owner.db.call(lambda db: db.execute(
                        "SELECT count(*),sum(session=?) FROM scopes WHERE background=1 AND (outcome='pending' OR clean=0)",
                        (value.session_id,)).fetchone())
                    if counts[0] >= BACKGROUND_LIMIT or (counts[1] or 0) >= SESSION_BACKGROUND_LIMIT:
                        raise BackendError("background_capacity", status=429)
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
                file_key = ""
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
                    file_key = client_path(name, inner)
                    if isinstance(file, (WriteFile, EditFile)) and value.expected_root != str(root.resolve()):
                        raise BackendError("file_preparation_mismatch")
                if value.patch is not None:
                    for target in [*value.patch.baselines, *value.patch.mutations]:
                        name, inner = tool_path(workspace, target.path)
                        location = (self.owner.profile.config.workspace if name == PRIMARY
                                    else dict(self.owner.queries.load_grants()).get(name))
                        if (not location or not inner or name == "grant" or target.relative != inner
                                or target.path != client_path(name, inner) or target.root != str(Path(location).resolve())):
                            raise BackendError("file_preparation_mismatch")
                instance = hashlib.sha256(value.call_id.encode()).hexdigest()[:32]
                directory = self.owner.profile.path / "executions" / instance
                log_expires = await self._reserve_output() if file is None and value.output_read is None and value.patch is None else 0
                directory.mkdir(mode=0o700, parents=True, exist_ok=False)
                with ProcessReservation(self.owner.profile.path, "execution", instance) as reservation:
                    await self.owner.db.call(lambda db: db.execute(
                        "INSERT INTO scopes(id,session,epoch,worker,supervisor,build,request,directory,lease,digest,phase,effect,log_expires,log_workspace,background,job_started) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,'registered',?,?,?,?,?)",
                        (value.call_id, value.session_id, value.execution_epoch, value.worker_id, self.owner.instance,
                         self.owner.build, value.request_id, str(directory), reservation.lease.model_dump_json(), digest,
                         value.effect, log_expires, str(root.resolve()), int(value.run_in_background),
                         time.time_ns() // 1_000_000 if value.run_in_background else 0)), write=True)
                    admitted = True
                    channel = await LocalProcess.start(self.owner.profile.path, instance, directory, reservation)
                    self.channels[value.call_id] = channel
                await self.owner.check_lease(value)
                await self.phase(value.call_id, "permit_intent")
                await channel.permit(LocalPermit(call_id=value.call_id, cwd=str(root), command=value.command,
                    timeout_seconds=value.timeout_seconds, file=file, expected_digest=value.expected_digest,
                    file_key=file_key,
                    patch=value.patch,
                    output_read=value.output_read, output_directory=output_directory, log_expires=log_expires,
                    log_error="output_capacity" if not log_expires else ""))
                await self.phase(value.call_id, "permitted")
                if value.run_in_background:
                    scope = await self.scope(value.call_id)
                    assert scope is not None
                    ack = ToolResult(call_id=value.call_id, exit_code=0, stdout=self.job_view(scope).model_dump_json(), stderr="")
                    await self.owner.db.call(lambda db: db.execute(
                        "UPDATE scopes SET job_ack=? WHERE id=?", (ack.model_dump_json(), value.call_id)), write=True)
                    acknowledged.set_result(ack)
            report = await channel.collect()
            if report.call_id != value.call_id or report.result is None:
                raise BackendError("tool_outcome_unknown")
            result = report.result
            async with self.owner.control:
                def captured(db: sqlite3.Connection) -> None:
                    changed = db.execute("UPDATE scopes SET outcome='completed',phase='result',result=?,job_finished=? "
                        "WHERE id=? AND worker=? AND epoch=? AND supervisor=? AND outcome='pending' AND clean=0",
                        (result.model_dump_json(), time.time_ns() // 1_000_000, value.call_id, value.worker_id, value.execution_epoch,
                         self.owner.instance)).rowcount
                    if changed != 1:
                        raise BackendError("tool_outcome_unknown")
                await self.owner.db.call(captured, write=True)
                scope = await self.scope(value.call_id)
                assert scope is not None
                await self.clean_scope(scope)
            if not acknowledged.done():
                acknowledged.set_result(result)
            return result
        except BaseException as error:
            if not acknowledged.done():
                if isinstance(error, asyncio.CancelledError):
                    acknowledged.cancel()
                else:
                    acknowledged.set_exception(error)
            if admitted:
                await self.owner.db.call(lambda db: db.execute("UPDATE scopes SET outcome='unknown',job_finished=? WHERE id=? "
                    "AND worker=? AND epoch=? AND supervisor=? AND outcome='pending'",
                    (time.time_ns() // 1_000_000, value.call_id, value.worker_id, value.execution_epoch, self.owner.instance)), write=True)
            raise
        finally:
            if channel is not None:
                await channel.close()
            self.channels.pop(value.call_id, None)

    async def run(self, value: RunTool) -> ToolResult:
        # A disconnected HTTP waiter does not cancel the supervisor-owned operation.
        if value.call_id in self.job_requests and self.job_requests[value.call_id].value != value:
            raise BackendError("call_conflict")
        if value.call_id not in self.jobs:
            if len(self.jobs) >= 16:
                raise BackendError("execution_capacity", status=429)
            acknowledged: asyncio.Future[ToolResult] = asyncio.get_running_loop().create_future()
            acknowledged.add_done_callback(lambda done: None if done.cancelled() else done.exception())
            task = asyncio.create_task(self.execute(value, acknowledged))
            self.jobs[value.call_id], self.job_requests[value.call_id] = task, Inflight(value, acknowledged)
            def finished(done: asyncio.Task[ToolResult]) -> None:
                if self.jobs.get(value.call_id) is done:
                    self.jobs.pop(value.call_id, None)
                    self.job_requests.pop(value.call_id, None)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(finished)
        task = self.jobs[value.call_id]
        if value.run_in_background:
            return await asyncio.shield(self.job_requests[value.call_id].acknowledged)
        return await asyncio.shield(task)

    async def lookup(self, value: ToolLookup) -> ToolObservation:
        await self.owner.validate_worker(value)
        scope = await self.scope(value.call_id)
        if scope is None:
            return ToolObservation(call_id=value.call_id, state="not_found")
        if scope["session"] != value.session_id:
            raise BackendError("call_scope_mismatch")
        if scope["job_ack"]:
            return ToolObservation(call_id=value.call_id, state="completed",
                result=ToolResult.model_validate_json(str(scope["job_ack"])), resource_clean=bool(scope["clean"]))
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
        await self.owner.db.call(lambda db: db.execute("UPDATE scopes SET clean=1 WHERE id=?", (scope["id"],)), write=True)

    async def cancel_all(self, session: str = "", epoch: int | None = None, *,
                         include_background: bool = True, background_only: bool = False) -> None:
        tasks = [task for key, task in self.jobs.items() if task is not asyncio.current_task()
                 and (not session or self.job_requests[key].value.session_id == session)
                 and (epoch is None or self.job_requests[key].value.execution_epoch == epoch)
                 and (include_background or not self.job_requests[key].value.run_in_background)
                 and (not background_only or self.job_requests[key].value.run_in_background)]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def close_handles(self) -> None:
        for channel in list(self.channels.values()):
            await channel.close()

    def job_view(self, scope: sqlite3.Row) -> JobView:
        result = ToolResult.model_validate_json(str(scope["result"])) if scope["result"] else None
        output = result.output if result else None
        if output is None:
            with contextlib.suppress(BackendError):
                output = read_archive(Path(str(scope["directory"])), str(scope["id"]))
        state: JobState = "running"
        if scope["outcome"] == "unknown":
            state = "unknown" if scope["clean"] else "cleanup_pending"
        elif scope["outcome"] == "completed":
            if not scope["clean"]:
                state = "cleanup_pending"
            elif scope["job_cancel"] or result and result.stop_reason in {"cancelled", "owner_disconnected"}:
                state = "cancelled"
            else:
                state = "succeeded" if result and result.exit_code == 0 else "failed"
        elif scope["job_cancel"]:
            state = "stopping"
        elif scope["phase"] in {"registered", "permit_intent"}:
            state = "starting"
        return JobView(job_id=str(scope["id"]), session_id=str(scope["session"]), request_id=str(scope["request"]),
            state=state, outcome=tool_outcome(str(scope["outcome"])), resource_clean=bool(scope["clean"]),
            cancel_requested=bool(scope["job_cancel"]), started_at_ms=int(scope["job_started"]),
            finished_at_ms=int(scope["job_finished"]), exit_code=result.exit_code if result else None,
            stop_reason=result.stop_reason if result else "", output=output)

    async def job_scope(self, value: JobReference, *, reading: bool = True) -> sqlite3.Row:
        self.owner.check_host(value)
        scope = await self.scope(value.job_id)
        if scope is None or not scope["background"]:
            raise BackendError("job_not_found", status=404)
        if scope["session"] != value.session_id:
            raise BackendError("job_scope_mismatch", status=403)
        if reading:
            workspace = self.owner.queries.session_workspace(value.session_id)
            location = (self.owner.profile.config.workspace if workspace == PRIMARY else
                        dict(self.owner.queries.load_grants()).get(workspace))
            if location is None or scope["log_workspace"] != str(Path(location).resolve()):
                raise BackendError("job_workspace_mismatch", status=403)
        return scope

    async def list_jobs(self, value: JobSession) -> JobList:
        self.owner.check_host(value)
        self.owner.queries.session_workspace(value.session_id)
        rows = await self.owner.db.call(lambda db: db.execute(
            "SELECT * FROM scopes WHERE session=? AND background=1 ORDER BY "
            "CASE WHEN outcome='pending' OR clean=0 THEN 0 ELSE 1 END,job_started DESC LIMIT 65",
            (value.session_id,)).fetchall())
        return JobList(jobs=[self.job_view(row) for row in rows[:64]], truncated=len(rows) > 64)

    async def job_output(self, value: JobOutputQuery) -> JobOutputView:
        scope = await self.job_scope(JobReference(**value.model_dump(include={"host_epoch", "build_id", "session_id", "job_id"})))
        view = self.job_view(scope)
        try:
            output = read_output(Path(str(scope["directory"])), value.read_request())
            return JobOutputView(job=view, output=output)
        except BackendError as error:
            return JobOutputView(job=view, error=error.code)

    async def kill_job(self, value: JobReference) -> JobView:
        async with self.owner.control:
            scope = await self.job_scope(value, reading=False)
            await self.owner.db.call(lambda db: db.execute(
                "UPDATE scopes SET job_cancel=1 WHERE id=? AND (outcome='pending' OR clean=0)", (value.job_id,)), write=True)
            channel = self.channels.get(value.job_id)
            task = self.jobs.get(value.job_id)
        if channel is not None:
            await channel.close()
        if task is not None and not task.done():
            with contextlib.suppress(BackendError):
                await asyncio.shield(task)
        async with self.owner.control:
            scope = await self.job_scope(value, reading=False)
            with contextlib.suppress(BackendError):
                await self.clean_scope(scope)
            scope = await self.job_scope(value, reading=False)
            return self.job_view(scope)

    async def pending_job_notices(self, value: HostFence) -> JobList:
        self.owner.check_host(value)
        rows = await self.owner.db.call(lambda db: db.execute(
            "SELECT * FROM scopes WHERE background=1 AND clean=1 AND outcome!='pending' AND job_notified=0 "
            "ORDER BY rowid LIMIT 64").fetchall())
        return JobList(jobs=[self.job_view(row) for row in rows])

    async def acknowledge_job_notice(self, value: JobReference) -> JobView:
        scope = await self.job_scope(value, reading=False)
        if scope["outcome"] == "pending" or not scope["clean"]:
            raise BackendError("job_not_settled")
        await self.owner.db.call(lambda db: db.execute(
            "UPDATE scopes SET job_notified=1 WHERE id=?", (value.job_id,)), write=True)
        return self.job_view(scope)
