from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from pydantic import BaseModel

from amazme_backend.contracts.execution import Cleanup, SupervisorHealth, WorkerInfo
from amazme_backend.contracts.ipc.supervisor import StopWorker, WorkerSpec
from amazme_backend.execution.processes import exited, wait_exited
from amazme_backend.host.integrations import IntegrationOperations
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.host.session_view import SessionView
from amazme_backend.platform.ipc import Peer
from amazme_backend.profiles.layout import session_database
from amazme_backend.profiles.profile import wait_peer
from amazme_backend.sessions.client import SessionRelay
from amazme_backend.sessions.service import SessionOps, read_session
from amazme_backend.shared.errors import BackendError


class ReadPeer(Peer):
    """A borrowed diagnostic capability cannot issue business mutations or close its owner."""

    def __init__(self, peer: Peer):
        self.peer = peer

    async def call[T: BaseModel](
        self, method: str, path: str, response: type[T], body: BaseModel | None = None
    ) -> T:
        if method != "GET" or body is not None:
            raise BackendError("read_only_peer")
        return await self.peer.call(method, path, response)

    async def close(self) -> None:
        pass


class WorkerSessions:
    def __init__(self, integrations: IntegrationOperations, lifecycle: HostLifecycle):
        self.integrations = integrations
        self.lifecycle = lifecycle
        self.worker_peers: dict[str, tuple[str, Peer]] = {}
        self.worker_locks: dict[str, asyncio.Lock] = {}

    async def read[T](self, session: str, operation: Callable[[SessionView], Awaitable[T]]) -> T:
        async with read_session(
            session_database(self.lifecycle.profile.path, session), session, build=self.lifecycle.build
        ) as store:
            return await operation(store)

    async def operate[T](
        self,
        session: str,
        operation: Callable[[SessionOps], Awaitable[T]],
        *,
        require_active: bool = True,
        write: bool = True,
    ) -> T:
        self.lifecycle.admit()
        if require_active and await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        source = await self.lifecycle.store.session(session)
        if source is None:
            raise BackendError("session_not_found", status=404)
        if require_active and (not source.prepared):
            raise BackendError("branch_preparation_pending")
        if require_active and source.archived:
            raise BackendError("session_archived")
        if not write and session_database(self.lifecycle.profile.path, session).is_file():
            return await self.read(session, operation)
        if write and source.archived:
            async with self.maintenance(session, allow_business=True) as client:
                return await operation(client)
        return await operation(SessionRelay(await self.worker(session)))

    async def reader(self, session: str) -> ReadPeer:
        self.lifecycle.admit()
        async with self.worker_locks.setdefault(session, asyncio.Lock()):
            await self.lifecycle.require_session(session)
            active = await self.lifecycle.store.active_update()
            service = await self.lifecycle.store.service()
            if service and (not exited(service.process_lease)):
                if service.state in {"stopping", "stopped"} or service.build_id != self.lifecycle.build:
                    raise BackendError("supervisor_retirement_pending", status=503)
                health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
                self.lifecycle.check_supervisor(health.identity, service, fenced=True)
                if health.identity.state == "stopping":
                    raise BackendError("supervisor_retirement_pending", status=503)
                owners = [w for w in health.workers if w.session_id == session and w.state != "stopped"]
                if len(owners) > 1:
                    raise BackendError("participant_identity_mismatch", status=503)
                if owners:
                    info = owners[0]
                    if (
                        info.build_id != self.lifecycle.build
                        or info.host_epoch != self.lifecycle.fence.host_epoch
                        or info.fingerprint != self.lifecycle.build
                        or (info.process_lease is None)
                        or exited(info.process_lease)
                        or (info.state == "stopping")
                    ):
                        raise BackendError("worker_identity_mismatch", status=503)
                    cached = self.worker_peers.get(session)
                    if cached and cached[0] != info.worker_id:
                        await cached[1].close()
                        self.worker_peers.pop(session, None)
                        cached = None
                    peer = cached[1] if cached else Peer(Path(info.socket), self.lifecycle.profile.token)
                    try:
                        identity = await wait_peer(
                            peer,
                            self.lifecycle.build,
                            timeout=3,
                            instance=info.worker_id,
                            profile=self.lifecycle.profile.config.profile_id,
                        )
                        if (
                            identity.role != "worker"
                            or identity.fingerprint != self.lifecycle.build
                            or identity.host_epoch != self.lifecycle.fence.host_epoch
                            or (identity.state == "stopping")
                            or exited(info.process_lease)
                        ):
                            raise BackendError("worker_identity_mismatch", status=503)
                    except BaseException:
                        await peer.close()
                        self.worker_peers.pop(session, None)
                        raise
                    self.worker_peers[session] = (info.worker_id, peer)
                    return ReadPeer(peer)
                failures = health.session_errors.get(session, [])
                if "worker_restart_budget_exhausted" in failures:
                    raise BackendError("worker_restart_budget_exhausted", status=503)
                if failures or health.blocked or health.identity.state == "blocked":
                    raise BackendError("diagnostic_worker_unavailable", status=503)
            if active:
                raise BackendError("update_frozen", status=503)
        return ReadPeer(await self.worker(session))

    async def worker(
        self, session: str, *, maintenance: bool = False, validation_probe: bool = False, update_id: str = ""
    ) -> Peer:
        self.lifecycle.admit()
        if maintenance and (not update_id) and (not validation_probe):
            return await self.reader(session)
        async with self.worker_locks.setdefault(session, asyncio.Lock()):
            if not validation_probe:
                await self.lifecycle.require_session(session)
            active = await self.lifecycle.store.active_update()
            if active and (not maintenance or update_id != active.update_id):
                raise BackendError("update_frozen", status=503)
            if validation_probe and (active is None or not update_id):
                raise BackendError("validation_requires_update")
            await self.lifecycle.ensure_supervisor()
            active = await self.lifecycle.store.active_update()
            if active and (not maintenance or update_id != active.update_id):
                raise BackendError("update_frozen", status=503)
            purpose = "validation" if active else "business"
            if not active and (not validation_probe):
                health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
                service = await self.lifecycle.store.service()
                if service is None:
                    raise BackendError("supervisor_unavailable", status=503)
                self.lifecycle.check_supervisor(health.identity, service, fenced=True)
                if "worker_restart_budget_exhausted" in health.session_errors.get(session, []):
                    raise BackendError("worker_restart_budget_exhausted", status=503)
                if (
                    health.freeze_id
                    or health.blocked
                    or health.session_errors.get(session)
                    or (health.identity.state != "ready")
                ):
                    raise BackendError("execution_blocked", status=503)
                await self.integrations.sync_plugin_packages(session)
                await self.integrations.sync_mcp_configuration(session)
            info = await self.lifecycle.supervisor.call(
                "POST",
                "/workers/ensure",
                WorkerInfo,
                WorkerSpec(
                    **self.lifecycle.fence.model_dump(),
                    session_id=session,
                    frozen=active is not None,
                    purpose=purpose,
                ),
            )
            if (
                info.session_id != session
                or info.build_id != self.lifecycle.build
                or info.purpose != purpose
                or (info.process_lease is None)
                or exited(info.process_lease)
                or (info.fingerprint not in {"", self.lifecycle.build})
                or (info.state not in {"starting", "ready", "frozen"})
            ):
                raise BackendError("worker_identity_mismatch", status=503)
            cached = self.worker_peers.get(session)
            if cached and cached[0] == info.worker_id:
                return cached[1]
            if cached:
                await cached[1].close()
            peer = Peer(Path(info.socket), self.lifecycle.profile.token)
            try:
                identity = await wait_peer(
                    peer,
                    self.lifecycle.build,
                    timeout=30,
                    instance=info.worker_id,
                    profile=self.lifecycle.profile.config.profile_id,
                )
                if (
                    identity.role != "worker"
                    or identity.fingerprint != self.lifecycle.build
                    or identity.host_epoch != self.lifecycle.fence.host_epoch
                ):
                    raise BackendError("worker_identity_mismatch", status=503)
                if active:
                    await self.lifecycle.update_health(
                        active, await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
                    )
            except BaseException:
                await peer.close()
                raise
            self.worker_peers[session] = (info.worker_id, peer)
            return peer

    @asynccontextmanager
    async def maintenance(
        self, session: str, *, closing: bool = False, allow_business: bool = False
    ) -> AsyncGenerator[SessionRelay]:
        async with self.worker_locks.setdefault(session, asyncio.Lock()):
            if not closing:
                self.lifecycle.admit()
                if await self.lifecycle.store.active_update():
                    raise BackendError("update_frozen", status=503)
                await self.lifecycle.ensure_supervisor()
            else:
                await self.lifecycle.ensure_supervisor(for_shutdown=True)
            service = await self.lifecycle.store.service()
            if service is None or service.state != "running" or exited(service.process_lease):
                raise BackendError("supervisor_unavailable", status=503)
            health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
            self.lifecycle.check_supervisor(health.identity, service, fenced=True)
            owners = [w for w in health.workers if w.session_id == session and w.state != "stopped"]
            if len(owners) > 1:
                raise BackendError("participant_identity_mismatch", status=503)
            info = (
                owners[0]
                if owners
                else await self.lifecycle.supervisor.call(
                    "POST",
                    "/workers/ensure",
                    WorkerInfo,
                    WorkerSpec(
                        **self.lifecycle.fence.model_dump(),
                        session_id=session,
                        frozen=False,
                        purpose="validation",
                    ),
                )
            )
            if (
                info.process_lease is None
                or exited(info.process_lease)
                or info.state not in {"starting", "ready", "frozen"}
            ):
                raise BackendError("worker_identity_mismatch", status=503)
            if not closing and not allow_business and info.purpose != "validation":
                raise BackendError("worker_identity_conflict", status=503)
            peer = Peer(Path(info.socket), self.lifecycle.profile.token)
            try:
                identity = await wait_peer(
                    peer,
                    self.lifecycle.build,
                    timeout=30,
                    instance=info.worker_id,
                    profile=self.lifecycle.profile.config.profile_id,
                )
                if (
                    identity.role != "worker"
                    or identity.host_epoch != self.lifecycle.fence.host_epoch
                    or identity.fingerprint != self.lifecycle.build
                ):
                    raise BackendError("worker_identity_mismatch", status=503)
                yield SessionRelay(peer)
            finally:
                await peer.close()
                if info.purpose == "validation":
                    current = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
                    self.lifecycle.check_supervisor(current.identity, service, fenced=True)
                    owner = next((w for w in current.workers if w.worker_id == info.worker_id), None)
                    if owner is None or owner.process_lease != info.process_lease:
                        raise BackendError("participant_identity_mismatch", status=503)
                    if owner.state != "stopped":
                        proof = await self.lifecycle.supervisor.call(
                            "POST",
                            "/workers/stop",
                            Cleanup,
                            StopWorker(
                                **self.lifecycle.fence.model_dump(),
                                session_id=session,
                                worker_id=owner.worker_id,
                                execution_epoch=owner.execution_epoch,
                                reason="update",
                            ),
                        )
                        if (
                            proof.state != "clean"
                            or not proof.proof_id
                            or proof.session_id != session
                            or (proof.execution_epoch != owner.execution_epoch)
                        ):
                            raise BackendError("execution_cleanup_pending", status=503)
                    await wait_exited(info.process_lease)
                    cached = self.worker_peers.pop(session, None)
                    if cached:
                        await cached[1].close()
