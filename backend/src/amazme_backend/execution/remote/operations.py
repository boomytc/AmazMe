"""Remote operations with the existing SSH transport identity and lock."""

from __future__ import annotations

import asyncio
import sqlite3
from typing import TYPE_CHECKING

from pydantic import TypeAdapter

from amazme_backend.contracts.ipc.supervisor import (
    OpenRemote,
)
from amazme_backend.contracts.remote import RemoteCallRequest, RemoteCallView, RemoteView, SshTarget
from amazme_backend.execution.native import (
    ProcessIdentity,
    stop_tracked,
)
from amazme_backend.execution.remote.client import RemoteClient
from amazme_backend.execution.state import remote_reply
from amazme_backend.shared.errors import BackendError

if TYPE_CHECKING:
    from amazme_backend.execution.supervisor import Supervisor


class RemoteOperations:
    def __init__(self, owner: Supervisor):
        self.owner = owner
        self.clients: dict[str, RemoteClient] = {}
        self.control = asyncio.Lock()

    async def _stop_remote_transport(self, row: sqlite3.Row) -> bool:
        raw = str(row["transport"])
        leases = TypeAdapter(list[ProcessIdentity]).validate_json(raw) if raw else []
        stopped = await asyncio.to_thread(stop_tracked, leases)
        if stopped:
            await self.owner.db.call(lambda db: db.execute("UPDATE remotes SET transport='' WHERE id=?", (row["id"],)), write=True)
        return stopped

    async def close_all(self, session: str = "", *, require_clean: bool = True) -> None:
        async with self.control:
            rows = await self.owner.db.call(lambda db: db.execute("SELECT * FROM remotes WHERE 1 AND (?='' OR session=?)", (session, session)).fetchall())
            errors: list[Exception] = []
            for row in rows:
                try:
                    await self.disconnect_remote_id(str(row["id"]))
                    if not await self._stop_remote_transport(row) and require_clean:
                        errors.append(BackendError("ssh_transport_stop_unconfirmed", status=503))
                except Exception as exc:
                    errors.append(exc)
            if errors:
                raise errors[0]

    def _remote_view(self, row: sqlite3.Row) -> RemoteView:
        phase = str(row["phase"])
        if phase not in {"connected", "disconnected", "blocked"}:
            phase = "blocked"
        return RemoteView(remote_id=str(row["id"]), host=str(row["host"]), phase=phase,  # type: ignore[arg-type]
                          generation=int(row["generation"]))

    def _remote_call(self, row: sqlite3.Row) -> RemoteCallView:
        phase = str(row["phase"])
        if phase not in {"unknown", "done", "conflict"}:
            phase = "unknown"
        return RemoteCallView(call_id=str(row["id"]), phase=phase, result=str(row["result"]))  # type: ignore[arg-type]

    async def _remote_row(self, remote_id: str) -> sqlite3.Row | None:
        return await self.owner.db.call(lambda db: db.execute("SELECT * FROM remotes WHERE id=?", (remote_id,)).fetchone())

    async def _unknown_remote(self, remote_id: str) -> bool:
        row = await self.owner.db.call(lambda db: db.execute(
            "SELECT 1 FROM remote_calls WHERE remote=? AND phase='unknown'", (remote_id,)).fetchone())
        return row is not None

    def _hello_matches(self, row: sqlite3.Row, hello: dict[str, object]) -> bool:
        return (hello.get("op") == "hello" and hello.get("daemon_id") == row["daemon_id"]
                and hello.get("generation") == int(row["generation"]))

    async def _dial_remote(self, row: sqlite3.Row) -> RemoteClient | None:
        if not await self._stop_remote_transport(row):
            raise BackendError("ssh_transport_stop_unconfirmed", status=503)
        try:
            target = SshTarget.model_validate_json(str(row["target"]))
            directory = self.owner.profile.path / "remotes" / str(row["id"])
            client = await asyncio.to_thread(RemoteClient.connect, target, directory, str(row["host_key"]), str(row["id"]))
        except (OSError, BackendError, ValueError) as exc:
            phase = "blocked" if isinstance(exc, (ValueError, BackendError)) and (
                not isinstance(exc, BackendError) or exc.code in {"ssh_host_key_unknown", "ssh_host_key_changed", "invalid_ssh_host_key"}) else "disconnected"
            await self.owner.db.call(lambda db: db.execute(
                "UPDATE remotes SET phase=? WHERE id=?", (phase, row["id"])), write=True)
            if isinstance(exc, BackendError):
                raise
            return None
        if not self._hello_matches(row, client.hello):
            client.close()
            await self.owner.db.call(lambda db: db.execute(
                "UPDATE remotes SET phase='blocked' WHERE id=?", (row["id"],)), write=True)
            return None
        self.clients[str(row["id"])] = client
        await self.owner.db.call(lambda db: db.execute(
            "UPDATE remotes SET phase='connected',transport=? WHERE id=?",
            (TypeAdapter(list[ProcessIdentity]).dump_json(client.leases).decode(), row["id"])), write=True)
        return client

    async def _absorb_remote(self, remote_id: str, client: RemoteClient) -> None:
        pending = await self.owner.db.call(lambda db: db.execute(
            "SELECT id FROM remote_calls WHERE remote=? AND phase='unknown'", (remote_id,)).fetchall())
        for item in pending:
            call_id = str(item["id"])
            try:
                reply = await asyncio.to_thread(client.query, call_id)
            except (OSError, BackendError):
                await self.disconnect_remote_id(remote_id)
                return
            if reply.get("op") == "result" and isinstance(reply.get("text"), str):
                await self.owner.db.call(lambda db, cid=call_id, text=reply["text"]: db.execute(
                    "UPDATE remote_calls SET phase='done',result=? WHERE id=? AND phase='unknown'",
                    (text, cid)), write=True)

    @staticmethod
    def _remote_matches(row: sqlite3.Row, value: OpenRemote) -> bool:
        target = SshTarget.model_validate(value.model_dump(include=set(SshTarget.model_fields))).model_dump_json()
        return (row["session"], row["host"], row["host_key"], row["daemon_id"], int(row["generation"]), row["target"]) == (
            value.session_id, value.host, value.host_key, value.daemon_id, value.generation, target)

    async def open(self, value: OpenRemote) -> RemoteView:
        async with self.control:
            return await self._open_remote(value)

    async def _open_remote(self, value: OpenRemote) -> RemoteView:
        self.owner.check_host(value)
        self.owner.admit(value.session_id)
        target = SshTarget.model_validate(value.model_dump(include=set(SshTarget.model_fields))).model_dump_json()
        existing = await self._remote_row(value.remote_id)
        if existing is not None:
            if not self._remote_matches(existing, value):
                raise BackendError("remote_conflict")
            await self._reconnect_remote(value)
            current = await self._remote_row(value.remote_id)
            assert current is not None
            return self._remote_view(current)
        await self.owner.db.call(lambda db: db.execute(
            "INSERT INTO remotes(id,session,host,host_key,daemon_id,generation,phase,target) VALUES(?,?,?,?,?,?,'disconnected',?)",
            (value.remote_id, value.session_id, value.host, value.host_key, value.daemon_id, value.generation, target)),
            write=True)
        row = await self._remote_row(value.remote_id)
        assert row is not None
        client = await self._dial_remote(row)
        if client is not None:
            await self._absorb_remote(value.remote_id, client)
        current = await self._remote_row(value.remote_id)
        assert current is not None
        if current["phase"] == "blocked":
            raise BackendError("remote_identity_mismatch")
        if current["phase"] != "connected":
            raise BackendError("remote_disconnected", status=503)
        return self._remote_view(current)

    async def reconnect(self, value: OpenRemote) -> RemoteView:
        async with self.control:
            return await self._reconnect_remote(value)

    async def _reconnect_remote(self, value: OpenRemote) -> RemoteView:
        self.owner.check_host(value)
        self.owner.admit(value.session_id)
        row = await self._remote_row(value.remote_id)
        if row is None or row["session"] != value.session_id:
            raise BackendError("remote_not_found", status=404)
        if not self._remote_matches(row, value):
            raise BackendError("remote_conflict")
        if value.remote_id in self.clients:
            await self.disconnect_remote_id(value.remote_id)
            row = await self._remote_row(value.remote_id)
            assert row is not None
        client = await self._dial_remote(row)
        if client is None:
            current = await self._remote_row(value.remote_id)
            assert current is not None
            if current["phase"] == "blocked":
                raise BackendError("remote_identity_mismatch")
            raise BackendError("remote_disconnected", status=503)
        await self._absorb_remote(value.remote_id, client)
        current = await self._remote_row(value.remote_id)
        assert current is not None
        return self._remote_view(current)

    async def disconnect_remote_id(self, remote_id: str) -> None:
        client = self.clients.get(remote_id)
        if client is not None:
            try:
                await asyncio.to_thread(client.close)
            finally:
                # Persist any descendants observed while stopping before releasing the live handle.
                await self.owner.db.call(lambda db: db.execute("UPDATE remotes SET transport=? WHERE id=?",
                    (TypeAdapter(list[ProcessIdentity]).dump_json(client.leases).decode(), remote_id)), write=True)
            self.clients.pop(remote_id, None)
        await self.owner.db.call(lambda db: db.execute(
            "UPDATE remotes SET phase='disconnected' WHERE id=? AND phase!='blocked'", (remote_id,)), write=True)

    async def disconnect(self, value: OpenRemote) -> RemoteView:
        async with self.control:
            return await self._disconnect_remote(value)

    async def _disconnect_remote(self, value: OpenRemote) -> RemoteView:
        self.owner.check_host(value)
        self.owner.admit()
        row = await self._remote_row(value.remote_id)
        if row is None or row["session"] != value.session_id:
            raise BackendError("remote_not_found", status=404)
        if not self._remote_matches(row, value):
            raise BackendError("remote_conflict")
        await self.disconnect_remote_id(value.remote_id)
        current = await self._remote_row(value.remote_id)
        assert current is not None
        return self._remote_view(current)

    async def submit(self, value: OpenRemote, call: RemoteCallRequest) -> RemoteCallView:
        async with self.control:
            return await self._submit_remote(value, call)

    async def _submit_remote(self, value: OpenRemote, call: RemoteCallRequest) -> RemoteCallView:
        self.owner.check_host(value)
        self.owner.admit(value.session_id)
        row = await self._remote_row(value.remote_id)
        if row is None or row["session"] != value.session_id:
            raise BackendError("remote_not_found", status=404)
        if not self._remote_matches(row, value):
            raise BackendError("remote_conflict")
        if row["phase"] != "connected":
            raise BackendError("remote_unreachable", status=503)
        if await self._unknown_remote(value.remote_id):
            existing = await self.owner.db.call(lambda db: db.execute(
                "SELECT * FROM remote_calls WHERE id=?", (call.call_id,)).fetchone())
            if existing is None or existing["remote"] != value.remote_id:
                raise BackendError("remote_blocked", status=503)
        existing = await self.owner.db.call(lambda db: db.execute(
            "SELECT * FROM remote_calls WHERE id=?", (call.call_id,)).fetchone())
        client = self.clients.get(value.remote_id)
        if client is None:
            await self.disconnect_remote_id(value.remote_id)
            raise BackendError("remote_disconnected", status=503)
        if existing is not None:
            if existing["remote"] != value.remote_id or existing["command"] != call.command:
                raise BackendError("remote_call_conflict")
            if existing["phase"] == "done":
                return self._remote_call(existing)
            try:
                reply = await asyncio.to_thread(client.query, call.call_id)
            except (OSError, BackendError):
                await self.disconnect_remote_id(value.remote_id)
                raise BackendError("remote_disconnected", status=503) from None
            return await self._apply_remote_reply(call.call_id, reply, allow_new=False)
        await self.owner.db.call(lambda db: db.execute(
            "INSERT INTO remote_calls(id,remote,command,phase) VALUES(?,?,?,'unknown')",
            (call.call_id, value.remote_id, call.command)), write=True)
        try:
            reply = await asyncio.to_thread(client.call, call.call_id, call.command)
        except (OSError, BackendError):
            await self.disconnect_remote_id(value.remote_id)
            current = await self.owner.db.call(lambda db: db.execute(
                "SELECT * FROM remote_calls WHERE id=?", (call.call_id,)).fetchone())
            assert current is not None
            return self._remote_call(current)
        return await self._apply_remote_reply(call.call_id, reply, allow_new=True)

    async def _apply_remote_reply(self, call_id: str, reply: dict[str, object], *, allow_new: bool) -> RemoteCallView:
        phase, result = remote_reply(reply, allow_new=allow_new)
        await self.owner.db.call(lambda db: db.execute(
            "UPDATE remote_calls SET phase=?,result=? WHERE id=?", (phase, result, call_id)), write=True)
        current = await self.owner.db.call(lambda db: db.execute("SELECT * FROM remote_calls WHERE id=?", (call_id,)).fetchone())
        assert current is not None
        return self._remote_call(current)

    async def close_handles(self) -> None:
        for client in self.clients.values():
            await asyncio.to_thread(client.close)
        self.clients.clear()
