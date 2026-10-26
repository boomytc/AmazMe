"""PTY operations on the Supervisor registry and control lock."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING

from amazme_backend.contracts.execution import (
    ProcessLease,
    TerminalList,
    TerminalView,
)
from amazme_backend.contracts.ipc.supervisor import (
    OpenTerminal,
    TerminalInput,
    TerminalQuery,
    TerminalResize,
    TerminalSession,
)
from amazme_backend.execution.native import (
    reconcile,
)
from amazme_backend.execution.processes import ProcessReservation
from amazme_backend.execution.pty.client import PtyClient
from amazme_backend.execution.services import ServiceProcess
from amazme_backend.shared.errors import BackendError
from amazme_backend.workspaces.paths import PRIMARY

if TYPE_CHECKING:
    from amazme_backend.execution.supervisor import Supervisor


class TerminalOperations:
    def __init__(self, owner: Supervisor):
        self.owner = owner
        self.clients: dict[str, PtyClient] = {}
        self.processes: dict[str, ServiceProcess] = {}

    async def _terminal_row(self, terminal_id: str) -> sqlite3.Row | None:
        return await self.owner.db.call(lambda db: db.execute("SELECT * FROM terminals WHERE id=?", (terminal_id,)).fetchone())

    def view(self, row: sqlite3.Row) -> TerminalView:
        phase = row["phase"]
        if phase not in {"running", "exited", "unknown"}:
            phase = "unknown"
        return TerminalView(terminal_id=str(row["id"]), session_id=str(row["session"]), cols=int(row["cols"]), rows=int(row["rows"]),
                            queued=int(row["queued"]), written=int(row["written"]),
                            exit_code=None if row["exit_code"] is None else int(row["exit_code"]),
                            output=str(row["output"]), output_seq=int(row["output_seq"] or 0),
                            phase=phase, clean=bool(row["clean"]),
                            workspace=str(row["workspace"]))

    async def _store_terminal(self, client: PtyClient, terminal_id: str, *, cols: int, rows: int, phase: str,
                              drain: bool = True) -> None:
        if drain:
            await asyncio.to_thread(client.drain)
        output, seq = client.text, client.text_seq

        def save(db: sqlite3.Connection) -> None:
            db.execute("UPDATE terminals SET queued=?,written=?,output=?,output_seq=?,cols=?,rows=?,phase=?,"
                       "exit_code=CASE WHEN ? IS NULL THEN exit_code ELSE ? END WHERE id=?",
                       (client.queued, client.written, output, seq, cols, rows, phase, client.exit_code,
                        client.exit_code, terminal_id))

        await self.owner.db.call(save, write=True)

    async def open(self, value: OpenTerminal) -> TerminalView:
        async with self.owner.control:
            self.owner.check_host(value)
            old = await self._terminal_row(value.terminal_id)
            if old is not None:
                workspace = value.workspace or str(old["workspace"])
                if (old["session"], old["command"], old["workspace"]) != (value.session_id, value.command, workspace):
                    raise BackendError("terminal_conflict")
                return self.view(old)
            self.owner.admit(value.session_id)
            recorded = self.owner.queries.session_workspace(value.session_id)
            workspace = value.workspace or recorded
            count = await self.owner.db.call(lambda db: db.execute("SELECT count(*) FROM terminals WHERE clean=0").fetchone()[0])
            if count >= 8:
                raise BackendError("terminal_capacity", status=429)
            blocked = await self.owner.db.call(lambda db: db.execute(
                "SELECT 1 FROM terminals WHERE session=? AND phase='unknown' AND clean=0", (value.session_id,)).fetchone())
            if blocked:
                raise BackendError("execution_cleanup_pending", status=503)
            location = self.owner.profile.config.workspace if workspace == PRIMARY else dict(self.owner.queries.load_grants()).get(workspace)
            if location is None:
                raise BackendError("workspace_not_found")
            instance = hashlib.sha256(("terminal:" + value.terminal_id).encode()).hexdigest()[:32]
            directory = self.owner.profile.path / "executions" / instance
            directory.mkdir(mode=0o700, parents=True, exist_ok=False)
            try:
                with ProcessReservation(self.owner.profile.path, "execution", instance) as reservation:
                    await self.owner.db.call(lambda db: db.execute(
                        "INSERT INTO terminals(id,session,command,cols,rows,phase,workspace,lease,directory) VALUES(?,?,?,?,?,'unknown',?,?,?)",
                        (value.terminal_id, value.session_id, value.command, value.cols, value.rows, workspace,
                         reservation.lease.model_dump_json(), str(directory))), write=True)
                    process = await ServiceProcess.start(self.owner.profile.path, instance, directory, reservation, "pty")
                    self.processes[value.terminal_id] = process
                client = PtyClient(process.sock)
                self.clients[value.terminal_id] = client
                await self.owner.db.call(lambda db: db.execute("UPDATE terminals SET permitted=1 WHERE id=?", (value.terminal_id,)), write=True)
                await asyncio.to_thread(client.permit, value.command, os.getuid(), os.getgid(), value.cols, value.rows, location)
                await self._store_terminal(client, value.terminal_id, cols=value.cols, rows=value.rows, phase="running")
            except BaseException:
                row = await self._terminal_row(value.terminal_id)
                if row is not None:
                    await self._close_terminal(row, interrupted=True)
                raise
            row = await self._terminal_row(value.terminal_id)
            assert row is not None
            return self.view(row)

    async def list(self, value: TerminalSession) -> TerminalList:
        async with self.owner.control:
            self.owner.check_host(value)
            rows = await self.owner.db.call(lambda db: db.execute("SELECT * FROM terminals WHERE session=? ORDER BY clean,rowid DESC LIMIT 100",
                                                           (value.session_id,)).fetchall())
            return TerminalList(terminals=[self.view(row) for row in rows])

    async def _close_terminal(self, row: sqlite3.Row, *, interrupted: bool = False) -> TerminalView:
        identity = str(row["id"])
        process = self.processes.get(identity)
        client = self.clients.get(identity)
        if client:
            with contextlib.suppress(OSError, BackendError):
                await asyncio.to_thread(client.drain)
        if process:
            await process.close()
        self.processes.pop(identity, None)
        self.clients.pop(identity, None)
        if client:
            await self._store_terminal(client, identity, cols=int(row["cols"]), rows=int(row["rows"]), phase="unknown",
                                       drain=False)
        clean = bool(row["clean"])
        if not clean and row["lease"]:
            clean = await reconcile(Path(row["directory"]), ProcessLease.model_validate_json(row["lease"]), permitted=bool(row["permitted"]))
        phase = "exited" if clean and not interrupted else "unknown"
        await self.owner.db.call(lambda db: db.execute("UPDATE terminals SET phase=?,clean=? WHERE id=?", (phase, int(clean), identity)), write=True)
        current = await self._terminal_row(identity)
        assert current is not None
        return self.view(current)

    async def close_all(self, session: str = "", *, require_clean: bool = True) -> None:
        rows = await self.owner.db.call(lambda db: db.execute("SELECT * FROM terminals WHERE clean=0 AND (?='' OR session=?)", (session, session)).fetchall())
        results = await asyncio.gather(*(self._close_terminal(row,
            interrupted=str(row["id"]) not in self.processes) for row in rows), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
        if require_clean and any(isinstance(result, TerminalView) and not result.clean for result in results):
            raise BackendError("terminal_stop_unconfirmed", status=503)

    async def close(self, value: TerminalQuery) -> TerminalView:
        async with self.owner.control:
            self.owner.check_host(value)
            row = await self._terminal_row(value.terminal_id)
            if row is None or row["session"] != value.session_id:
                raise BackendError("terminal_not_found", status=404)
            return await self._close_terminal(row)

    async def write(self, value: TerminalInput) -> TerminalView:
        async with self.owner.control:
            self.owner.check_host(value)
            row = await self._terminal_row(value.terminal_id)
            if row is None or row["session"] != value.session_id:
                raise BackendError("terminal_not_found", status=404)
            previous = await self.owner.db.call(lambda db: db.execute(
                "SELECT * FROM terminal_inputs WHERE id=?", (value.input_id,)).fetchone())
            if previous is not None:
                if str(previous["data"]) != value.data or previous["terminal"] != value.terminal_id:
                    raise BackendError("terminal_input_conflict")
                return self.view(row).model_copy(update={"input_id": value.input_id,
                    "input_status": "accepted" if previous["accepted"] == len(value.data.encode()) else "unknown"})
            self.owner.admit(value.session_id)
            if row["phase"] != "running" or row["exit_code"] is not None:
                raise BackendError("terminal_not_running")
            client = self.clients.get(value.terminal_id)
            if client is None:
                await self._mark_terminal_unknown(value.terminal_id)
                raise BackendError("terminal_channel_lost", status=503)
            encoded = value.data.encode()
            if not encoded or len(encoded) > client.credit:
                raise BackendError("pty_window_full")
            await self.owner.db.call(lambda db: db.execute(
                "INSERT INTO terminal_inputs(id,terminal,data,accepted) VALUES(?,?,?,-1)",
                (value.input_id, value.terminal_id, value.data)), write=True)
            before = client.written + client.queued
            await asyncio.to_thread(client.send_input, encoded)
            await asyncio.to_thread(client.pump, 0.5, lambda: client.written + client.queued >= before + len(encoded))
            accepted = client.written + client.queued - before
            await self.owner.db.call(lambda db: db.execute(
                "UPDATE terminal_inputs SET accepted=? WHERE id=?", (accepted, value.input_id)), write=True)
            await self._store_terminal(client, value.terminal_id, cols=int(row["cols"]), rows=int(row["rows"]), phase="running")
            current = await self._terminal_row(value.terminal_id)
            assert current is not None
            return self.view(current).model_copy(update={"input_id": value.input_id,
                "input_status": "accepted" if accepted == len(encoded) else "unknown"})

    async def resize(self, value: TerminalResize) -> TerminalView:
        async with self.owner.control:
            self.owner.check_host(value)
            self.owner.admit(value.session_id)
            row = await self._terminal_row(value.terminal_id)
            if row is None or row["session"] != value.session_id:
                raise BackendError("terminal_not_found", status=404)
            client = self.clients.get(value.terminal_id)
            if client is None or row["phase"] != "running":
                raise BackendError("terminal_not_running")
            await asyncio.to_thread(client.resize, value.cols, value.rows)
            await self._store_terminal(client, value.terminal_id, cols=value.cols, rows=value.rows, phase="running")
            current = await self._terminal_row(value.terminal_id)
            assert current is not None
            return self.view(current)

    async def read(self, value: TerminalQuery) -> TerminalView:
        async with self.owner.control:
            self.owner.check_host(value)
            session_id, terminal_id = value.session_id, value.terminal_id
            row = await self._terminal_row(terminal_id)
            if row is None or row["session"] != session_id:
                raise BackendError("terminal_not_found", status=404)
            client = self.clients.get(terminal_id)
            if client is None:
                return self.view(row)
            try:
                await asyncio.to_thread(client.drain)
            except (OSError, BackendError):
                await self._mark_terminal_unknown(terminal_id)
                current = await self._terminal_row(terminal_id)
                assert current is not None
                return self.view(current)
            if client.closed or client.exit_code is not None:
                return await self._close_terminal(row, interrupted=client.exit_code is None)
            phase = str(row["phase"])
            await self._store_terminal(client, terminal_id, cols=int(row["cols"]), rows=int(row["rows"]), phase=phase)
            current = await self._terminal_row(terminal_id)
            assert current is not None
            return self.view(current)

    async def _mark_terminal_unknown(self, terminal_id: str) -> None:
        await self.owner.db.call(lambda db: db.execute(
            "UPDATE terminals SET phase='unknown' WHERE id=? AND exit_code IS NULL", (terminal_id,)), write=True)

    async def poll(self) -> None:
        for terminal_id, client in list(self.clients.items()):
            row = await self._terminal_row(terminal_id)
            if row is None:
                continue
            try:
                await asyncio.to_thread(client.pump, 0)
                if client.closed or client.exit_code is not None:
                    await self._close_terminal(row, interrupted=client.exit_code is None)
                else:
                    await self._store_terminal(client, terminal_id, cols=int(row["cols"]), rows=int(row["rows"]), phase="running")
            except (OSError, BackendError):
                await self._close_terminal(row, interrupted=True)

    async def close_handles(self) -> None:
        for process in list(self.processes.values()):
            await process.close()
        self.processes.clear()
        self.clients.clear()
