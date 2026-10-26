"""MCP operations on the Supervisor registry and control lock."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING

from amazme_backend.contracts.execution import (
    ProcessLease,
)
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.ipc.supervisor import (
    McpCallRef,
    McpQuery,
    McpSession,
    OpenMcp,
)
from amazme_backend.contracts.mcp import (
    McpCall,
    McpCallRequest,
    McpDecision,
    McpState,
    McpView,
    catalog_schema_digest,
    exposure,
)
from amazme_backend.execution.mcp.client import (
    McpClient,
    mcp_digest,
)
from amazme_backend.execution.native import (
    reconcile,
)
from amazme_backend.execution.processes import ProcessReservation
from amazme_backend.execution.services import ServiceProcess
from amazme_backend.shared.errors import BackendError
from amazme_backend.workspaces.paths import PRIMARY

if TYPE_CHECKING:
    from amazme_backend.execution.supervisor import Supervisor


MCP_UNRESOLVED_LIMIT = 512
MCP_ACTIVE_LIMIT = 16
MCP_IDENTITY_LIMIT = 4096
MCP_TERMINAL_WINDOW = 100


class McpOperations:
    def __init__(self, owner: Supervisor):
        self.owner = owner
        self.clients: dict[str, McpClient] = {}
        self.processes: dict[str, ServiceProcess] = {}

    def view(self, row: sqlite3.Row) -> McpView:
        config = self.owner.queries.mcp_policy(str(row["session"]), str(row["managed_id"]), str(row["id"]))
        return McpView.model_validate({
            "server_id": row["id"], "session_id": row["session"], "workspace": row["workspace"],
            "command": row["command"], "protocol_version": row["protocol_version"],
            "managed_id": str(row["managed_id"]), "name": str(row["name"]),
            "enabled": config.enabled if config else not bool(row["managed_id"]),
            "exposure": config.exposure if config else "hidden" if row["managed_id"] else "direct",
            "tool_exposure": config.tool_exposure if config else {},
            "phase": row["phase"] if row["phase"] in {"ready", "exited", "unknown"} else "unknown",
            "exit_code": row["exit_code"], "tools": json.loads(row["catalog"]), "clean": bool(row["clean"]),
        })

    def _mcp_call(self, row: sqlite3.Row) -> McpCall:
        return McpCall.model_validate({
            "call_id": row["id"], "server_id": row["server"], "name": row["name"],
            "phase": row["phase"], "result": row["result"], "digest": row["digest"],
            "arguments": json.loads(row["arguments"]), "is_error": bool(row["is_error"]),
            "result_data": json.loads(row["result_data"]) if row["result_data"] else None,
            "origin": row["origin"] if row["origin"] in {"manual", "model"} else "manual",
        })

    async def open(self, value: OpenMcp) -> McpView:
        async with self.owner.control:
            self.owner.check_host(value)
            old = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (value.server_id,)).fetchone())
            workspace = value.workspace or (str(old["workspace"]) if old is not None else self.owner.queries.session_workspace(value.session_id))
            launch_body = value.model_dump(exclude={"host_epoch", "build_id", "server_id"})
            launch_body["workspace"] = workspace
            launch_body["environment_commands"] = list(value.environment_commands.items())
            launch = hashlib.sha256(json.dumps(launch_body, sort_keys=True).encode()).hexdigest()
            if old is not None:
                workspace = value.workspace or str(old["workspace"])
                if (old["session"], old["command"], old["workspace"]) != (value.session_id, value.command, workspace):
                    raise BackendError("mcp_server_conflict")
                if (str(old["launch_digest"]) and str(old["launch_digest"]) != launch
                        or not str(old["launch_digest"]) and (value.cwd or value.environment)):
                    raise BackendError("mcp_server_conflict")
                return self.view(old)
            self.owner.admit(value.session_id)
            recorded = self.owner.queries.session_workspace(value.session_id)
            workspace = value.workspace or recorded
            if value.managed_id:
                config = self.owner.queries.mcp_policy(value.session_id, value.managed_id, value.server_id)
                if config is None or not config.enabled:
                    raise BackendError("mcp_config_changed")
            count = await self.owner.db.call(lambda db: db.execute("SELECT count(*) FROM mcp_servers WHERE clean=0").fetchone()[0])
            if count >= 8:
                raise BackendError("mcp_server_capacity", status=429)
            blocked = await self.owner.db.call(lambda db: db.execute(
                "SELECT 1 FROM mcp_servers WHERE session=? AND phase='unknown' AND clean=0", (value.session_id,)).fetchone())
            if blocked:
                raise BackendError("execution_cleanup_pending", status=503)
            location = self.owner.profile.config.workspace if workspace == PRIMARY else dict(self.owner.queries.load_grants()).get(workspace)
            if location is None:
                raise BackendError("workspace_not_found")
            configured_cwd = Path(value.cwd).expanduser()
            cwd = (Path(location) / configured_cwd).resolve() if value.cwd else Path(location)
            if not cwd.is_dir():
                raise BackendError("mcp_cwd_invalid")
            instance = hashlib.sha256(("mcp:" + value.server_id).encode()).hexdigest()[:32]
            directory = self.owner.profile.path / "executions" / instance
            directory.mkdir(mode=0o700, parents=True, exist_ok=False)
            try:
                with ProcessReservation(self.owner.profile.path, "execution", instance) as reservation:
                    await self.owner.db.call(lambda db: db.execute(
                        "INSERT INTO mcp_servers(id,session,command,phase,workspace,lease,directory,launch_digest,managed_id,name) VALUES(?,?,?,'unknown',?,?,?,?,?,?)",
                        (value.server_id, value.session_id, value.command, workspace, reservation.lease.model_dump_json(), str(directory), launch, value.managed_id, value.name)), write=True)
                    process = await ServiceProcess.start(self.owner.profile.path, instance, directory, reservation, "mcp")
                    self.processes[value.server_id] = process
                client = McpClient(process.sock)
                self.clients[value.server_id] = client
                await self.owner.db.call(lambda db: db.execute("UPDATE mcp_servers SET permitted=1 WHERE id=?", (value.server_id,)), write=True)
                await asyncio.to_thread(client.permit, value.command, os.getuid(), os.getgid(), str(cwd), value.environment, value.environment_commands, value.timeout_seconds,
                                        value.http, str(self.owner.profile.path), value.name or value.server_id)
                catalog = json.dumps([tool.model_dump() for tool in client.tools], ensure_ascii=False)
                busy = await self.owner.db.call(lambda db: db.execute(
                    "SELECT 1 FROM mcp_calls WHERE server=? AND phase IN ('waiting_approval','running')",
                    (value.server_id,)).fetchone())
                if busy:
                    raise BackendError("mcp_tool_identity")
                await self.owner.db.call(lambda db: db.execute("UPDATE mcp_servers SET phase='ready',catalog=?,protocol_version=? WHERE id=?",
                    (catalog, client.protocol_version, value.server_id)), write=True)
            except BaseException:
                row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (value.server_id,)).fetchone())
                if row is not None:
                    await self._close_mcp(row, interrupted=True)
                raise
            row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (value.server_id,)).fetchone())
            assert row is not None
            return self.view(row)

    async def _sync_mcp(self, server_id: str) -> None:
        client = self.clients.get(server_id)
        if client is None:
            return
        await asyncio.to_thread(client.pump, 0)
        for call_id, result in list(client.results.items()):
            await self.owner.db.call(lambda db: db.execute(
                "UPDATE mcp_calls SET phase='done',result=?,result_data=?,is_error=? WHERE id=? AND server=? AND phase='running'",
                (result.text, json.dumps(result.data, ensure_ascii=False), int(result.is_error), call_id, server_id)), write=True)
            client.results.pop(call_id, None)
        for call_id in list(client.conflicts):
            await self.owner.db.call(lambda db: db.execute("UPDATE mcp_calls SET phase='conflict' WHERE id=? AND server=? AND phase='running'",
                                                    (call_id, server_id)), write=True)
            client.conflicts.discard(call_id)
        for call_id in list(client.busy):
            await self.owner.db.call(lambda db: db.execute(
                "UPDATE mcp_calls SET phase='waiting_approval',decision_id='',decision='' "
                "WHERE id=? AND server=? AND phase='running'",
                (call_id, server_id)), write=True)
            client.busy.discard(call_id)
        if client.ready and not client.catalog_failed:
            catalog = json.dumps([tool.model_dump() for tool in client.tools], ensure_ascii=False)
            await self.owner.db.call(lambda db: db.execute(
                "UPDATE mcp_servers SET catalog=? WHERE id=? AND phase='ready' AND catalog!=?",
                (catalog, server_id, catalog)), write=True)

    async def query(self, value: McpQuery) -> McpView:
        async with self.owner.control:
            self.owner.check_host(value)
            row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=? AND session=?", (value.server_id, value.session_id)).fetchone())
            if row is None:
                raise BackendError("mcp_channel_unconfirmed", status=503)
            await self._sync_mcp(value.server_id)
            row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (value.server_id,)).fetchone())
            assert row is not None
            return self.view(row)

    async def state(self, value: McpSession) -> McpState:
        async with self.owner.control:
            self.owner.check_host(value)
            servers = await self.owner.db.call(lambda db: db.execute(
                "SELECT * FROM mcp_servers WHERE session=? ORDER BY clean,rowid DESC LIMIT 100", (value.session_id,)).fetchall())
            for server in servers:
                server_id = str(server["id"])
                client = self.clients.get(server_id)
                try:
                    await self._sync_mcp(server_id)
                    if client and (client.closed or client.exit_code is not None):
                        await self._close_mcp(server, interrupted=client.exit_code is None)
                except (OSError, BackendError, ValueError):
                    await self._close_mcp(server, interrupted=True)
            servers = await self.owner.db.call(lambda db: db.execute(
                "SELECT * FROM mcp_servers WHERE session=? ORDER BY clean,rowid DESC LIMIT 100", (value.session_id,)).fetchall())
            calls = await self._listed_calls(value.session_id)
            return McpState(servers=[self.view(row) for row in servers], calls=[self._mcp_call(row) for row in calls])

    async def _listed_calls(self, session_id: str) -> list[sqlite3.Row]:
        """Non-terminal calls stay visible. Terminal history keeps its newest window and is never deleted here."""
        def query(db: sqlite3.Connection) -> tuple[list[sqlite3.Row], list[sqlite3.Row]]:
            open_rows = db.execute(
                "SELECT c.* FROM mcp_calls c JOIN mcp_servers s ON s.id=c.server "
                "WHERE s.session=? AND c.phase NOT IN ('done','denied') ORDER BY c.rowid", (session_id,)).fetchall()
            recent = db.execute(
                "SELECT c.* FROM mcp_calls c JOIN mcp_servers s ON s.id=c.server "
                "WHERE s.session=? AND c.phase IN ('done','denied') ORDER BY c.rowid DESC LIMIT ?",
                (session_id, MCP_TERMINAL_WINDOW)).fetchall()
            return list(open_rows), list(recent)
        open_rows, recent = await self.owner.db.call(query)
        seen: set[str] = set()
        merged: list[sqlite3.Row] = []
        for row in [*open_rows, *recent]:
            call_id = str(row["id"])
            if call_id in seen:
                continue
            seen.add(call_id)
            merged.append(row)
        return merged

    async def request_call(self, session_id: str, server_id: str, value: McpCallRequest, fence: HostFence) -> McpCall:
        async with self.owner.control:
            self.owner.check_host(fence)
            self.owner.admit()
            server = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
            if server is None or server["session"] != session_id:
                raise BackendError("mcp_not_found", status=404)
            digest = mcp_digest(server_id, str(server["command"]), str(server["workspace"]), self.owner.build, value.name, value.arguments)
            existing = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (value.call_id,)).fetchone())
            if existing is not None:
                stored_origin = str(existing["origin"] or "manual")
                if (existing["server"] != server_id or existing["digest"] != digest
                        or stored_origin != value.origin or str(existing["schema_digest"] or "") != value.schema_digest):
                    raise BackendError("mcp_call_conflict")
                if existing["phase"] == "running":
                    await self._sync_mcp(server_id)
                    existing = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (value.call_id,)).fetchone())
                    assert existing is not None
                return self._mcp_call(existing)
            self.owner.admit(session_id)
            await self._sync_mcp(server_id)
            server = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
            assert server is not None
            client = self.clients.get(server_id)
            if client is not None and client.catalog_failed:
                raise BackendError("mcp_catalog_stale", status=503)
            if server["phase"] != "ready":
                raise BackendError("mcp_not_ready")
            managed = self.view(server)
            if not managed.enabled or exposure(managed.exposure, managed.tool_exposure, value.name) == "hidden":
                raise BackendError("mcp_tool_hidden")
            if value.name not in {item["name"] for item in json.loads(server["catalog"])}:
                raise BackendError("mcp_tool_unknown")
            counts = await self.owner.db.call(lambda db: db.execute(
                "SELECT count(*), sum(phase IN ('waiting_approval','running','unknown')), "
                "sum(phase IN ('waiting_approval','running')) FROM mcp_calls").fetchone())
            total, unresolved, active = int(counts[0] or 0), int(counts[1] or 0), int(counts[2] or 0)
            if total >= MCP_IDENTITY_LIMIT or unresolved >= MCP_UNRESOLVED_LIMIT or active >= MCP_ACTIVE_LIMIT:
                raise BackendError("mcp_call_capacity", status=429)
            await self.owner.db.call(lambda db: db.execute(
                "INSERT INTO mcp_calls(id,server,name,arguments,digest,phase,schema_digest,origin) "
                "VALUES(?,?,?,?,?,'waiting_approval',?,?)",
                (value.call_id, server_id, value.name, json.dumps(value.arguments, sort_keys=True, ensure_ascii=False),
                 digest, value.schema_digest, value.origin)), write=True)
            row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (value.call_id,)).fetchone())
            assert row is not None
            return self._mcp_call(row)

    async def decide_call(self, session_id: str, server_id: str, call_id: str, value: McpDecision, fence: HostFence) -> McpCall:
        async with self.owner.control:
            self.owner.check_host(fence)
            self.owner.admit()
            row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (call_id,)).fetchone())
            server = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
            if row is None or row["server"] != server_id or server is None or server["session"] != session_id:
                raise BackendError("mcp_call_not_found", status=404)
            if row["digest"] != value.digest:
                raise BackendError("mcp_call_conflict")
            await self._sync_mcp(server_id)
            server = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
            assert server is not None
            client = self.clients.get(server_id)
            decision = json.dumps({"approve": value.approve, "digest": value.digest})
            if row["decision_id"]:
                if row["decision_id"] != value.decision_id or (row["phase"] != "conflict" and row["decision"] != decision):
                    raise BackendError("mcp_decision_conflict")
                return self._mcp_call(row)
            self.owner.admit(session_id)
            if row["phase"] != "waiting_approval":
                raise BackendError("mcp_call_conflict")
            managed = self.view(server)
            if value.approve and (not managed.enabled or exposure(managed.exposure, managed.tool_exposure, str(row["name"])) == "hidden"):
                raise BackendError("mcp_tool_hidden")
            if value.approve and client is not None and client.catalog_failed:
                raise BackendError("mcp_catalog_stale", status=503)
            pinned = str(row["schema_digest"] or "")
            if value.approve and pinned and catalog_schema_digest(str(server["catalog"]), str(row["name"])) != pinned:
                refusal = json.dumps({"approve": False, "digest": value.digest, "reason": "schema"})
                await self.owner.db.call(lambda db: db.execute(
                    "UPDATE mcp_calls SET phase='conflict',decision_id=?,decision=? WHERE id=? AND phase='waiting_approval'",
                    (value.decision_id, refusal, call_id)), write=True)
                current = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (call_id,)).fetchone())
                assert current is not None
                return self._mcp_call(current)
            if value.approve:
                busy = await self.owner.db.call(lambda db: db.execute(
                    "SELECT 1 FROM mcp_calls WHERE server=? AND phase IN ('running','unknown')", (server_id,)).fetchone())
                if busy:
                    raise BackendError("mcp_call_pending")
                if server["phase"] != "ready" or server_id not in self.clients:
                    raise BackendError("mcp_not_ready")
            # Durable intent precedes the first byte to a third-party service.
            await self.owner.db.call(lambda db: db.execute(
                "UPDATE mcp_calls SET phase=?,decision_id=?,decision=? WHERE id=?",
                ("running" if value.approve else "denied", value.decision_id, decision, call_id)), write=True)
            if value.approve:
                client = self.clients[server_id]
                try:
                    await asyncio.to_thread(client.call, call_id, str(row["name"]), json.loads(row["arguments"]))
                    await asyncio.to_thread(client.pump, .1)
                    await self._sync_mcp(server_id)
                except (OSError, BackendError, ValueError):
                    await self._close_mcp(server, interrupted=True)
            current = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (call_id,)).fetchone())
            assert current is not None
            if value.approve and current["phase"] == "waiting_approval" and not current["decision_id"]:
                raise BackendError("mcp_catalog_stale", status=503)
            return self._mcp_call(current)

    async def _close_mcp(self, row: sqlite3.Row, *, interrupted: bool = False) -> McpView:
        server_id = str(row["id"])
        process, client = self.processes.get(server_id), self.clients.get(server_id)
        if client:
            with contextlib.suppress(OSError, BackendError, ValueError):
                await self._sync_mcp(server_id)
        if process:
            await process.close()
        self.processes.pop(server_id, None)
        self.clients.pop(server_id, None)
        clean = bool(row["clean"])
        if not clean and row["lease"]:
            clean = await reconcile(Path(row["directory"]), ProcessLease.model_validate_json(row["lease"]), permitted=bool(row["permitted"]))
        phase = "exited" if clean and not interrupted else "unknown"
        def closed(db: sqlite3.Connection) -> None:
            db.execute("UPDATE mcp_servers SET phase=?,clean=?,exit_code=coalesce(?,exit_code) WHERE id=?",
                       (phase, int(clean), client.exit_code if client else None, server_id))
            db.execute("UPDATE mcp_calls SET phase=CASE WHEN phase='waiting_approval' THEN 'denied' ELSE 'unknown' END "
                       "WHERE server=? AND phase IN ('waiting_approval','running')", (server_id,))
        await self.owner.db.call(closed, write=True)
        current = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
        assert current is not None
        return self.view(current)

    async def close_all(self, session: str = "", *, require_clean: bool = True) -> None:
        rows = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE clean=0 AND (?='' OR session=?)", (session, session)).fetchall())
        results = await asyncio.gather(*(self._close_mcp(row,
            interrupted=str(row["id"]) not in self.processes) for row in rows), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
        if require_clean and any(isinstance(result, McpView) and not result.clean for result in results):
            raise BackendError("mcp_stop_unconfirmed", status=503)

    async def lookup_call(self, value: McpCallRef) -> McpCall:
        async with self.owner.control:
            self.owner.check_host(value)
            row = await self._owned_call(value.session_id, value.server_id, value.call_id)
            if row["phase"] == "running":
                await self._sync_mcp(value.server_id)
                row = await self._owned_call(value.session_id, value.server_id, value.call_id)
            return self._mcp_call(row)

    async def _owned_call(self, session_id: str, server_id: str, call_id: str) -> sqlite3.Row:
        row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_calls WHERE id=?", (call_id,)).fetchone())
        server = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
        if row is None or server is None or row["server"] != server_id or server["session"] != session_id:
            raise BackendError("mcp_call_not_found", status=404)
        return row

    async def cancel_call(self, value: McpCallRef) -> McpCall:
        """Cancel one call. Waiting calls are denied before any send. A running service is not closed."""
        async with self.owner.control:
            self.owner.check_host(value)
            row = await self._owned_call(value.session_id, value.server_id, value.call_id)
            phase = str(row["phase"])
            if phase in {"done", "denied", "unknown", "conflict"}:
                return self._mcp_call(row)
            if phase == "waiting_approval":
                decision = json.dumps({"approve": False, "digest": row["digest"], "reason": "cancelled"})
                await self.owner.db.call(lambda db: db.execute(
                    "UPDATE mcp_calls SET phase='denied',decision_id=?,decision=? WHERE id=? AND phase='waiting_approval'",
                    ("cancel:" + value.call_id, decision, value.call_id)), write=True)
                return self._mcp_call(await self._owned_call(value.session_id, value.server_id, value.call_id))
            if phase == "running":
                client = self.clients.get(value.server_id)
                if client is not None:
                    with contextlib.suppress(OSError, BackendError, ValueError):
                        await asyncio.to_thread(client.cancel_call, value.call_id)
                        await asyncio.to_thread(client.pump, 0.2)
                        await self._sync_mcp(value.server_id)
                current = await self._owned_call(value.session_id, value.server_id, value.call_id)
                if current["phase"] == "running":
                    await self.owner.db.call(lambda db: db.execute(
                        "UPDATE mcp_calls SET phase='unknown' WHERE id=? AND phase='running'", (value.call_id,)), write=True)
                    current = await self._owned_call(value.session_id, value.server_id, value.call_id)
                return self._mcp_call(current)
            raise BackendError("mcp_call_conflict")

    async def cancel(self, value: McpQuery) -> McpView:
        async with self.owner.control:
            self.owner.check_host(value)
            row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (value.server_id,)).fetchone())
            if row is None or row["session"] != value.session_id:
                raise BackendError("mcp_not_found", status=404)
            client = self.clients.get(value.server_id)
            if client:
                await self._sync_mcp(value.server_id)
                await self.owner.db.call(lambda db: db.execute("UPDATE mcp_calls SET phase='unknown' WHERE server=? AND phase='running'",
                                                        (value.server_id,)), write=True)
                with contextlib.suppress(OSError, BackendError, ValueError):
                    await asyncio.to_thread(client.cancel)
            return await self._close_mcp(row)

    async def poll(self) -> None:
        for server_id, client in list(self.clients.items()):
            row = await self.owner.db.call(lambda db: db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone())
            if row is None:
                continue
            try:
                await self._sync_mcp(server_id)
                if client.closed or client.exit_code is not None:
                    await self._close_mcp(row, interrupted=client.exit_code is None)
            except (OSError, BackendError, ValueError):
                await self._close_mcp(row, interrupted=True)

    async def close_handles(self) -> None:
        for process in list(self.processes.values()):
            await process.close()
        self.processes.clear()
        self.clients.clear()
