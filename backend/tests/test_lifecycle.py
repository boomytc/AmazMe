"""Host acceptance and update barriers backed by the actual metadata database."""
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from amazme_backend.contracts import (
    Attachment,
    BackendError,
    CompleteUpdate,
    CreateSession,
    HostFence,
    PrepareUpdate,
    ProcessLease,
    Receipt,
    Submit,
    TaskActivity,
    WorkerActivity,
)
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.host.service import Host
from amazme_backend.host.store import HostStore
from amazme_backend.interfaces.http.application import application
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.profile import Profile


@pytest.fixture
def lease(tmp_path):
    return ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                        path=str(tmp_path / "lease"), device=1, inode=1)


@pytest.fixture
async def store(tmp_path, lease):
    value = HostStore(tmp_path / "host.sqlite")
    await value.initialize("host", "a" * 64, lease)
    await value.create_session("a" * 32, CreateSession())
    try:
        yield value
    finally:
        await value.db.close()


async def test_delivery_survives_host_crash_before_adoption(store, tmp_path, lease):
    session = "a" * 32
    value = Submit(request_id="stable", text="hello")
    pending = await store.enqueue(session, "submit", value.request_id, value)
    await store.db.close()
    reopened = HostStore(tmp_path / "host.sqlite", require_existing=True)
    try:
        await reopened.initialize("replacement", "a" * 64, lease)
        assert (await reopened.pending())[0].delivery_id == pending.delivery_id
        # Lost response is retried with exactly the same business identity.
        duplicates = await asyncio.gather(*(reopened.enqueue(session, "submit", value.request_id, value) for _ in range(12)))
        assert {d.delivery_id for d in duplicates} == {pending.delivery_id}
        receipt = Receipt(request_id="stable", text="hello", status="queued", accepted_revision="7")
        await reopened.delivered(pending.delivery_id, receipt)
        assert not await reopened.pending()
        assert (await reopened.enqueue(session, "submit", value.request_id, value)).receipt == receipt
        with pytest.raises(BackendError, match="request_conflict"):
            await reopened.enqueue(session, "submit", value.request_id, value.model_copy(update={"text": "different"}))
    finally:
        await reopened.db.close()


async def test_freeze_and_completion_are_durable_distinct_facts(store, tmp_path, lease):
    value = PrepareUpdate(update_id="upgrade", target_build="b" * 64)
    frozen = await store.begin_update(value, "a" * 64)
    with pytest.raises(BackendError, match="update_frozen"):
        await store.enqueue("a" * 32, "submit", "denied", Submit(request_id="denied", text="task"))
    with pytest.raises(BackendError, match="update_frozen"):
        await store.create_session("b" * 32, CreateSession())
    frozen.phase = "completed"
    saved = await store.save_update(frozen)
    await store.db.close()
    reopened = HostStore(tmp_path / "host.sqlite", require_existing=True)
    try:
        await reopened.initialize("replacement", "b" * 64, lease)
        active = await reopened.active_update()
        assert active and active.phase == "completed" and not active.activated
        saved.activated = True
        await reopened.save_update(saved)
        assert await reopened.active_update() is None
        assert (await reopened.update("upgrade")).activated
    finally:
        await reopened.db.close()


async def test_restart_budget_persists_until_explicit_recovery(store):
    for _ in range(3):
        await store.allow_restart()
    with pytest.raises(BackendError, match="supervisor_restart_budget"):
        await store.allow_restart()
    assert await store.blocked() == "supervisor_restart_budget"
    with pytest.raises(BackendError, match="supervisor_restart_budget"):
        await store.allow_restart()
    await store.allow_restart(explicit=True)
    assert not await store.blocked()


async def test_scheduled_demand_does_not_spin_until_deadline(store):
    await store.activity("a" * 32, WorkerActivity(pending=1, runnable=False, next_wake_ms=253402300799000, state="ready"))
    assert not await store.due()
    await store.demand("a" * 32)
    assert await store.due() == ["a" * 32]


@pytest.fixture
async def owner(tmp_path, monkeypatch, lease):
    private_write(tmp_path / "config.json", json.dumps({"profile_id": "test", "workspace": str(tmp_path),
                  "resources": "unused", "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    monkeypatch.setattr("amazme_backend.host.lifecycle.build_id", lambda: "a" * 64)
    value = Host(Profile(tmp_path))
    value.lifecycle.fence = HostFence(host_epoch=await value.lifecycle.store.initialize(value.lifecycle.instance, value.lifecycle.build, lease), build_id=value.lifecycle.build)
    value.lifecycle.initialized = True
    value.lifecycle._spawn_supervisor = AsyncMock(side_effect=AssertionError("unit fixture cannot start a supervisor"))
    value.origin = "http://127.0.0.1:12345"
    await value.lifecycle.store.create_session("a" * 32, CreateSession())
    try:
        yield value
    finally:
        if value.lifecycle.storage_failed:
            with pytest.raises(BackendError, match="storage_blocked"):
                await value.close()
        elif not value.lifecycle.store.db.closed:
            await value.close()


async def test_unknown_session_read_never_spawns_worker(owner):
    owner.lifecycle.ensure_supervisor = AsyncMock()
    with pytest.raises(BackendError, match="session_not_found"):
        await owner.access.worker("b" * 32, maintenance=True)
    owner.lifecycle.ensure_supervisor.assert_not_awaited()


async def test_http_fence_attachment_and_private_update_capability(owner):
    owner.sessions.deliver = AsyncMock(return_value=Receipt(request_id="r", text="hello", status="queued"))
    app = application(owner)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin,
            headers={"Authorization": "Bearer web-only"}) as client:
        path = "/api/v1/sessions/" + "a" * 32 + "/submissions"
        assert (await client.post(path, json={"request_id": "r", "text": "hello"})).status_code == 409
        client.headers.update({"x-amazme-build": owner.lifecycle.build, "x-amazme-epoch": str(owner.lifecycle.fence.host_epoch)})
        assert (await client.post(path, json={"request_id": "r", "text": "hello"})).status_code == 409
        attached = await client.post("/api/v1/sessions/" + "a" * 32 + "/attachments")
        assert attached.status_code == 201
        attachment = Attachment.model_validate(attached.json())
        client.headers["x-amazme-attachment"] = attachment.attachment_id
        assert (await client.post(path, json={"request_id": "r", "text": "hello"})).status_code == 202
        assert (await client.post(path.replace("a" * 32, "b" * 32), json={"request_id": "r", "text": "hello"})).status_code == 409
        assert (await client.post("/control/updates/complete", json=CompleteUpdate(update_id="u", expected_revision="1").model_dump())).status_code == 401
        await client.delete("/api/v1/sessions/" + "a" * 32 + "/attachments/" + attachment.attachment_id)
        assert (await client.post(path, json={"request_id": "r", "text": "hello"})).status_code == 409
    assert owner.sessions.deliver.await_count == 1


async def test_host_database_failure_closes_every_admission(owner, monkeypatch):
    await owner.lifecycle.store.db.call(lambda db: db.execute("DROP TABLE sessions"))
    with pytest.raises(BackendError) as failure:
        await owner.sessions.sessions()
    assert failure.value.code == "storage_failure"
    assert owner.lifecycle.storage_failed
    owner.lifecycle.ensure_supervisor = AsyncMock()
    for action in (
        lambda: owner.sessions.create_session(CreateSession()),
        lambda: owner.access.worker("a" * 32),
        lambda: owner.sessions.deliver("a" * 32, "submit", "r", Submit(request_id="r", text="task")),
        lambda: owner.updates.prepare_update(PrepareUpdate(update_id="u", target_build=owner.lifecycle.build)),
        lambda: owner.updates.resume_update("u"),
        lambda: owner.updates.complete_update(CompleteUpdate(update_id="u", expected_revision="1")),
    ):
        with pytest.raises(BackendError, match="storage_blocked"):
            await action()
    owner.lifecycle.ensure_supervisor.assert_not_awaited()
    assert (await owner.lifecycle.health()).errors == ["storage_failed"]


async def test_host_store_missing_table_is_not_recreated(store, tmp_path, lease):
    await store.db.call(lambda db: db.execute("DROP TABLE services"))
    await store.db.close()
    reopened = HostStore(tmp_path / "host.sqlite", require_existing=True)
    try:
        with pytest.raises(BackendError, match="storage_incomplete"):
            await reopened.initialize("next", "a" * 64, lease)
        assert reopened.failed
    finally:
        await reopened.db.close()
    import sqlite3
    with sqlite3.connect(tmp_path / "host.sqlite") as db:
        assert db.execute("SELECT name FROM sqlite_master WHERE name='services'").fetchone() is None
        assert db.execute("SELECT count(*) FROM hosts").fetchone()[0] == 1


async def test_dispatch_lost_ack_retries_worker_acceptance_without_duplication(owner):
    from amazme_backend.sessions.service import SessionStore
    worker_store = SessionStore(owner.lifecycle.profile.path / "session.sqlite", "a" * 32, build=owner.lifecycle.build)
    await worker_store.initialize()
    await worker_store.fence(owner.lifecycle.fence)
    calls = 0

    async def call(method, path, response, body=None):
        nonlocal calls
        assert path == "/submissions"
        receipt = await worker_store.accept(body.value, body)
        calls += 1
        if calls == 1:
            raise httpx.ReadError("lost acceptance ACK")
        return receipt

    peer = AsyncMock()
    peer.call.side_effect = call
    owner.access.worker = AsyncMock(return_value=peer)
    value = Submit(request_id="stable", text="hello")
    try:
        with pytest.raises(httpx.ReadError):
            await owner.sessions.deliver("a" * 32, "submit", "stable", value)
        assert len(await owner.lifecycle.store.pending()) == 1
        first = await worker_store.get("stable")
        retried = await owner.sessions.deliver("a" * 32, "submit", "stable", value)
        assert retried.accepted_revision == first.accepted_revision
        assert len((await worker_store.snapshot()).requests) == 1
        assert not await owner.lifecycle.store.pending()
    finally:
        await worker_store.close()


@pytest.mark.parametrize("failure", ["worker_identity_conflict", "execution_cleanup_pending", "storage_failure", "stale_host_epoch"])
async def test_runtime_failure_never_permanently_rejects_outbox(owner, failure):
    owner.access.worker = AsyncMock(side_effect=BackendError(failure))
    value = Submit(request_id="retry", text="task")
    with pytest.raises(BackendError, match=failure):
        await owner.sessions.deliver("a" * 32, "submit", "retry", value)
    assert (await owner.lifecycle.store.pending())[0].state == "pending"
    peer = AsyncMock()
    peer.call.side_effect = BackendError(failure)
    owner.access.worker = AsyncMock(return_value=peer)
    with pytest.raises(BackendError, match=failure):
        await owner.sessions.deliver("a" * 32, "submit", "retry", value)
    assert (await owner.lifecycle.store.pending())[0].state == "pending"


async def test_acceptance_ack_does_not_depend_on_activity_rpc(owner):
    receipt = Receipt(request_id="accepted", text="task", status="queued", accepted_revision="1")
    peer = AsyncMock()

    async def call(method, path, response, body=None):
        if path == "/activity":
            raise httpx.ReadError("activity unavailable")
        return receipt

    peer.call.side_effect = call
    owner.access.worker = AsyncMock(return_value=peer)
    assert await owner.sessions.deliver("a" * 32, "submit", "accepted", Submit(request_id="accepted", text="task")) == receipt
    assert not await owner.lifecycle.store.pending()


async def test_nine_sessions_progress_while_first_eight_are_stalled(owner):
    sessions = [f"{i:032x}" for i in range(9)]
    for session in sessions:
        await owner.lifecycle.store.create_session(session, CreateSession())
        await owner.lifecycle.store.enqueue(session, "submit", session, Submit(request_id=session, text="task"))
    owner.lifecycle.ensure_supervisor = AsyncMock()
    blocked = asyncio.Event()
    done = asyncio.Event()

    async def dispatch(delivery):
        if delivery.session_id != sessions[-1]:
            await blocked.wait()
        else:
            done.set()
        return delivery

    owner.sessions.dispatch = dispatch
    owner.access.worker = AsyncMock(side_effect=BackendError("worker_unavailable"))
    task = asyncio.create_task(owner.dispatcher())
    try:
        await asyncio.wait_for(done.wait(), 2)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


class UpdateRuntime:
    """In-memory IPC/process proofs; Host orchestration and its SQLite journal are real."""

    def __init__(self, owner, monkeypatch):
        self.owner = owner
        self.workers = {}
        self.alive = set()
        self.calls = []
        self.freeze_id = ""
        self.revision = 0
        self.service = None
        self.epoch = owner.lifecycle.fence.host_epoch
        self.drop_retire = False
        self.lose_thaw = False
        self.epochs = []
        self.blocked = []
        for module in ("lifecycle", "session_access", "updates", "sessions", "service"):
            monkeypatch.setattr(f"amazme_backend.host.{module}.exited", lambda lease: lease.instance_id not in self.alive)
        for module in ("lifecycle", "session_access", "updates"):
            monkeypatch.setattr(f"amazme_backend.host.{module}.wait_exited", self.wait_exited)
        for module in ("session_access", "updates"):
            monkeypatch.setattr(f"amazme_backend.host.{module}.wait_peer", self.wait_peer)
            monkeypatch.setattr(f"amazme_backend.host.{module}.Peer", self.peer)
        monkeypatch.setattr("amazme_backend.host.lifecycle.SupervisorClient", self.peer)
        owner.lifecycle._spawn_supervisor = self.spawn
        owner.lifecycle._await_service = self.await_service
        owner.lifecycle.supervisor = self

    def lease(self, role, instance):
        return ProcessLease(instance_id=instance, role=role, profile_path=str(self.owner.lifecycle.profile.path),
                            path=str(self.owner.lifecycle.profile.path / instance), device=1, inode=len(instance))

    async def install(self, build, state="running", alive=True):
        from amazme_backend.host.store import ServiceRecord
        service = ServiceRecord(instance_id="svc" + str(len(await self.owner.lifecycle.store.services())),
            build_id=build, process_lease=self.lease("supervisor", "svc" + str(len(await self.owner.lifecycle.store.services()))), state=state)
        await self.owner.lifecycle.store.save_service(service)
        self.service = service
        if alive:
            self.alive.add(self.service.instance_id)
        return self.service

    async def spawn(self):
        self.owner.lifecycle.supervisor = self
        self.calls.append(("spawn", self.owner.lifecycle.build))
        return await self.install(self.owner.lifecycle.build, "starting")

    def identity(self):
        from amazme_backend.contracts import Identity
        # A per-session restart budget is reported in the blocked list. It does not by itself
        # mean the supervisor lost its VM or fence, matching Supervisor.identity.
        execution_blocked = any(not str(item).startswith("worker_restart_budget_exhausted:") for item in self.blocked)
        return Identity(profile_id=self.owner.lifecycle.profile.config.profile_id, instance_id=self.service.instance_id,
                        build_id=self.service.build_id, fingerprint=self.service.build_id, pid=1,
                        role="supervisor", host_epoch=self.epoch,
                        state="blocked" if execution_blocked else "frozen" if self.freeze_id else "ready")

    def health(self):
        from amazme_backend.contracts import SupervisorHealth
        return SupervisorHealth(identity=self.identity(), registry_revision=str(self.revision), freeze_id=self.freeze_id,
                                workers=[w.model_copy(deep=True) for w in self.workers.values()], epochs=self.epochs,
                                blocked=[v for v in self.blocked if not v.startswith("worker_restart_budget_exhausted:")],
                                session_errors={v.split(":", 1)[1]: ["worker_restart_budget_exhausted"]
                                                for v in self.blocked if v.startswith("worker_restart_budget_exhausted:")})

    async def await_service(self, service):
        assert self.service.instance_id == service.instance_id
        return self.identity()

    async def wait_exited(self, lease, timeout=5):
        if lease.instance_id in self.alive:
            raise BackendError("process_exit_unproven", status=503)

    async def wait_peer(self, peer, build, **kwargs):
        return await peer.call("GET", "/identity", None)

    def peer(self, path, token):
        if str(path) in {w.socket for w in self.workers.values()}:
            worker = next(w for w in self.workers.values() if w.socket == str(path) and w.state != "stopped")
            return self.worker_peer(worker)
        return self

    def add_worker(self, session, *, build=None, purpose="business", state="ready"):
        from amazme_backend.contracts import Cleanup, EpochHealth, WorkerInfo
        identity = "worker" + str(len(self.workers))
        build = build or self.service.build_id
        info = WorkerInfo(session_id=session, worker_id=identity, build_id=build, fingerprint=build,
                          pid=1, socket="/fake/" + identity, process_lease=self.lease("worker", identity),
                          state=state, purpose=purpose, host_epoch=self.epoch)
        if purpose == "validation":
            info.execution_epoch = 1 + max((e.execution_epoch for e in self.epochs if e.session_id == session), default=0)
            self.epochs.append(EpochHealth(session_id=session, worker_id=identity, execution_epoch=info.execution_epoch,
                state="clean", cleanup=Cleanup(session_id=session, execution_epoch=info.execution_epoch,
                state="clean", resources=[], proof_id="probe-" + identity)))
        self.workers[identity] = info
        if state != "stopped":
            self.alive.add(identity)
        return info

    def worker_peer(self, worker):
        from amazme_backend.contracts import Identity, Snapshot
        peer = AsyncMock()

        async def call(method, path, response, body=None):
            self.calls.append((worker.worker_id, path))
            if path == "/identity":
                return Identity(profile_id=self.owner.lifecycle.profile.config.profile_id, instance_id=worker.worker_id,
                    build_id=worker.build_id, fingerprint=worker.build_id, pid=1, role="worker", host_epoch=self.epoch)
            if path == "/freeze":
                worker.state = "frozen"
            if path == "/thaw":
                assert worker.purpose == "validation", "a business driver was thawed before activation"
                worker.state = "ready"
            return Snapshot(session_id=worker.session_id, stream_id="stream", seq="0", state="frozen",
                            requests=[], events=[])

        peer.call.side_effect = call
        return peer

    async def close(self):
        pass

    async def call(self, method, path, response, body=None):
        from amazme_backend.contracts import Cleanup
        self.calls.append(("supervisor", path))
        if path == "/identity":
            return self.identity()
        if path == "/takeover":
            self.epoch = body.host_epoch
            return self.identity()
        if path == "/freeze":
            self.freeze_id = body.freeze_id
        if path == "/workers/ensure":
            if self.blocked:
                raise BackendError("execution_blocked", status=503)
            assert self.freeze_id or body.purpose == "business"
            live = [w for w in self.workers.values() if w.session_id == body.session_id and w.state != "stopped"]
            if live:
                if live[0].purpose != body.purpose:
                    raise BackendError("worker_identity_conflict")
                return live[0].model_copy(deep=True)
            return self.add_worker(body.session_id, purpose=body.purpose, state="frozen" if body.frozen else "ready").model_copy(deep=True)
        if path == "/workers/stop":
            worker = self.workers[body.worker_id]
            worker.state = "stopped"
            self.alive.discard(worker.worker_id)
            self.revision += 1
            return Cleanup(session_id=worker.session_id, execution_epoch=worker.execution_epoch,
                           state="clean", proof_id="proof", resources=[])
        if path == "/retire":
            self.epoch = body.host_epoch
            self.freeze_id = body.freeze_id
            for worker in self.workers.values():
                worker.state = "stopped"
                self.alive.discard(worker.worker_id)
            self.alive.discard(self.service.instance_id)
            health = self.health()
            if self.drop_retire:
                health.workers = []
            return health
        if path == "/shutdown":
            for worker in self.workers.values():
                worker.state = "stopped"
                self.alive.discard(worker.worker_id)
            self.alive.discard(self.service.instance_id)
            return self.identity()
        if path == "/thaw":
            assert all(w.state == "stopped" for w in self.workers.values())
            self.freeze_id = ""
            if self.lose_thaw:
                self.lose_thaw = False
                raise httpx.ReadError("thaw committed, ACK lost")
        return self.health()


@pytest.fixture
async def runtime(owner, monkeypatch):
    await owner.lifecycle.supervisor.close()
    return UpdateRuntime(owner, monkeypatch)


@pytest.mark.parametrize("alive", [True, False])
async def test_old_service_replacement_always_creates_update_freeze(owner, runtime, alive):
    await runtime.install("b" * 64, alive=alive)
    if alive:
        runtime.add_worker("a" * 32, build="b" * 64)
    await owner.lifecycle.ensure_supervisor()
    active = await owner.lifecycle.store.active_update()
    assert active and active.target_build == owner.lifecycle.build and active.source_build == "b" * 64
    assert runtime.freeze_id == active.update_id
    assert len(await owner.lifecycle.store.services()) == 2
    with pytest.raises(BackendError, match="update_frozen"):
        await owner.access.worker("a" * 32)


async def test_stopping_service_is_retired_without_business_takeover(owner, runtime):
    old = await runtime.install(owner.lifecycle.build, state="stopping")
    await owner.lifecycle.ensure_supervisor()
    assert old.instance_id not in runtime.alive
    assert runtime.calls.index(("supervisor", "/retire")) < runtime.calls.index(("supervisor", "/takeover"))
    assert (await owner.lifecycle.store.services())[0].state == "stopped"
    assert await owner.lifecycle.store.active_update()


async def test_stopped_but_live_service_blocks_replacement(owner, runtime):
    await runtime.install(owner.lifecycle.build, state="stopped", alive=True)
    with pytest.raises(BackendError, match="supervisor_exit_unproven"):
        await owner.lifecycle.ensure_supervisor()
    assert not runtime.calls


async def test_service_registry_cannot_overwrite_identity_or_resurrect(owner, runtime):
    service = await runtime.install(owner.lifecycle.build, state="stopping")
    with pytest.raises(BackendError, match="supervisor_retirement_pending"):
        await owner.lifecycle.store.save_service(service.model_copy(update={"state": "running"}))
    with pytest.raises(BackendError, match="supervisor_identity_mismatch"):
        await owner.lifecycle.store.save_service(service.model_copy(update={"build_id": "b" * 64}))
    with pytest.raises(BackendError, match="supervisor_registry_conflict"):
        await runtime.install(owner.lifecycle.build)


async def test_prepare_freezes_and_stops_each_session_before_retire(owner, runtime):
    await runtime.install(owner.lifecycle.build)
    one = runtime.add_worker("a" * 32)
    await owner.lifecycle.store.create_session("b" * 32, CreateSession())
    prepared = await owner.updates.prepare_update(PrepareUpdate(update_id="upgrade", target_build="b" * 64))
    assert prepared.phase == "prepared" and not prepared.activated
    assert len(prepared.roster) == 2
    assert runtime.calls.index((one.worker_id, "/freeze")) < runtime.calls.index(("supervisor", "/workers/stop"))
    assert all(w.state == "stopped" for w in prepared.roster)
    assert {w.session_id for w in prepared.roster} == {"a" * 32, "b" * 32}
    assert runtime.calls[-1] == ("supervisor", "/retire")
    with pytest.raises(BackendError, match="update_prepared"):
        await owner.lifecycle.ensure_supervisor()


async def test_retire_receipt_cannot_drop_participant(owner, runtime):
    await runtime.install("b" * 64)
    worker = runtime.add_worker("a" * 32)
    runtime.drop_retire = True
    with pytest.raises(BackendError) as failure:
        await owner.lifecycle.ensure_supervisor()
    assert failure.value.code == "participant_missing"
    active = await owner.lifecycle.store.active_update()
    assert [w.worker_id for w in active.roster] == [worker.worker_id]
    assert not active.activated
    assert (await owner.lifecycle.store.services())[0].state == "stopping"
    assert not any(call[0] == "spawn" for call in runtime.calls)


@pytest.mark.parametrize("phase", ["freezing", "retiring", "prepared", "validating", "completed"])
async def test_target_replays_every_phase_without_implicit_activation(owner, runtime, phase):
    await runtime.install(owner.lifecycle.build)
    source = runtime.add_worker("a" * 32, build="b" * 64, state="stopped")
    active = await owner.lifecycle.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.lifecycle.build), "b" * 64)
    active.roster, active.phase = [source], phase
    await owner.lifecycle.store.save_update(active)
    # An orphan from an interrupted validation must be retired, never used as a probe.
    business = runtime.add_worker("a" * 32)
    resumed = await owner.updates.resume_update("upgrade")
    assert not resumed.activated
    assert runtime.freeze_id == "upgrade"
    assert resumed.phase == ("completed" if phase == "completed" else "validating")
    assert resumed.validation.purpose == "validation"
    assert business.worker_id not in {w.worker_id for w in [resumed.validation]}
    assert all(w.state == "stopped" for w in resumed.roster)
    assert not any(call[1] == "/thaw" for call in runtime.calls)
    completed = await owner.updates.complete_update(CompleteUpdate(update_id="upgrade", expected_revision=resumed.revision))
    assert completed.activated and await owner.lifecycle.store.active_update() is None
    assert not runtime.freeze_id
    previous_calls = len(runtime.calls)
    assert (await owner.updates.complete_update(CompleteUpdate(update_id="upgrade", expected_revision="old"))).activated
    assert len(runtime.calls) == previous_calls


async def test_lost_thaw_ack_refreezes_revalidates_then_activates(owner, runtime):
    await runtime.install(owner.lifecycle.build)
    await owner.lifecycle.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.lifecycle.build), "b" * 64)
    record = await owner.updates.resume_update("upgrade")
    runtime.lose_thaw = True
    with pytest.raises(httpx.ReadError):
        await owner.updates.complete_update(CompleteUpdate(update_id="upgrade", expected_revision=record.revision))
    active = await owner.lifecycle.store.active_update()
    assert active.phase == "completed" and not active.activated
    assert runtime.freeze_id == ""
    cut = len(runtime.calls)
    resumed = await owner.updates.resume_update("upgrade")
    assert runtime.freeze_id == "upgrade" and not resumed.activated
    calls = runtime.calls[cut:]
    assert calls.index(("supervisor", "/freeze")) < calls.index(("supervisor", "/workers/ensure"))
    assert (await owner.updates.complete_update(CompleteUpdate(update_id="upgrade", expected_revision=resumed.revision))).activated


async def test_update_roster_never_shrinks_or_changes_lifetime_identity(owner, runtime):
    await runtime.install(owner.lifecycle.build)
    worker = runtime.add_worker("a" * 32, state="stopped")
    active = await owner.lifecycle.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.lifecycle.build), "b" * 64)
    active = await owner.lifecycle.store.source_roster(active.update_id, [worker])
    with pytest.raises(BackendError) as failure:
        await owner.lifecycle.store.source_roster(active.update_id, [])
    assert failure.value.code == "participant_missing"
    changed = worker.model_copy(update={"process_lease": runtime.lease("worker", "different")})
    with pytest.raises(BackendError) as failure:
        await owner.lifecycle.store.source_roster(active.update_id, [changed])
    assert failure.value.code == "participant_identity_mismatch"
    assert (await owner.lifecycle.store.update(active.update_id)).roster == [worker]


@pytest.mark.parametrize("problem", ["missing_worker", "live_worker", "unclean_epoch", "missing_cleanup", "blocked"])
async def test_target_health_failure_retains_freeze(owner, runtime, problem):
    from amazme_backend.contracts import EpochHealth
    await runtime.install(owner.lifecycle.build)
    worker = runtime.add_worker("a" * 32, build="b" * 64, state="stopped")
    active = await owner.lifecycle.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.lifecycle.build), "b" * 64)
    active.roster, active.phase = [worker], "prepared"
    await owner.lifecycle.store.save_update(active)
    if problem == "missing_worker":
        runtime.workers.clear()
    elif problem == "live_worker":
        runtime.alive.add(worker.worker_id)
    elif problem in {"unclean_epoch", "missing_cleanup"}:
        runtime.epochs.append(EpochHealth(session_id=worker.session_id, worker_id=worker.worker_id,
            execution_epoch=1, state="clean" if problem == "missing_cleanup" else "closing"))
    else:
        runtime.blocked.append("cleanup_blocked")
    with pytest.raises(BackendError):
        await owner.updates.resume_update("upgrade")
    assert not (await owner.lifecycle.store.active_update()).activated
    assert not any(call[1] == "/thaw" for call in runtime.calls)


@pytest.mark.parametrize("errors", [
    ["worker_restart_budget_exhausted"],
    ["worker_restart_budget_exhausted", "worker_retirement_pending:worker"],
    ["mcp_stop_unconfirmed:server"],
])
def test_update_cleanup_distinguishes_restart_budget_from_unclean_resources(errors):
    from amazme_backend.contracts import Identity, SupervisorHealth
    health = SupervisorHealth(identity=Identity(profile_id="profile", instance_id="supervisor",
        build_id="a" * 64, pid=1, state="frozen"), registry_revision="1", workers=[], epochs=[],
        session_errors={"a" * 32: errors})
    if errors == ["worker_restart_budget_exhausted"]:
        HostLifecycle.verify_clean(health)
    else:
        with pytest.raises(BackendError, match="update_health_blocked"):
            HostLifecycle.verify_clean(health)


async def test_blocked_session_diagnostics_reuse_verified_owner_without_mutations(owner, runtime):
    from amazme_backend.contracts import Cancel, Snapshot
    await runtime.install(owner.lifecycle.build)
    worker = runtime.add_worker("a" * 32, state="blocked")
    runtime.blocked = ["cleanup_blocked"]
    reader = await owner.access.reader(worker.session_id)
    assert (await reader.call("GET", "/snapshot", Snapshot)).session_id == worker.session_id
    assert not any(path in {"/takeover", "/workers/ensure", "/freeze"} for _, path in runtime.calls)
    with pytest.raises(BackendError, match="read_only_peer"):
        await reader.call("POST", "/requests/r/cancel", Receipt, Cancel(**owner.lifecycle.fence.model_dump(), request_id="r"))
    with pytest.raises(BackendError, match="execution_blocked"):
        await owner.sessions.deliver(worker.session_id, "cancel", "r", Cancel(host_epoch=0, build_id="", request_id="r"))
    assert not any(path.endswith("/cancel") for _, path in runtime.calls)
    assert len(await owner.lifecycle.store.pending()) == 1
    # The unchanged stream API also receives only the read capability.
    stream_peer = await owner.access.worker(worker.session_id, maintenance=True)
    with pytest.raises(BackendError, match="read_only_peer"):
        await stream_peer.call("POST", "/anything", Receipt)


@pytest.mark.parametrize("mismatch", ["build", "epoch", "fingerprint", "exited", "stopping", "peer_epoch"])
async def test_diagnostic_owner_requires_current_identity_and_lifetime(owner, runtime, mismatch):
    await runtime.install(owner.lifecycle.build)
    worker = runtime.add_worker("a" * 32)
    runtime.blocked = ["cleanup_blocked"]
    if mismatch == "build":
        worker.build_id = "b" * 64
    elif mismatch == "epoch":
        worker.host_epoch += 1
    elif mismatch == "fingerprint":
        worker.fingerprint = "b" * 64
    elif mismatch == "exited":
        runtime.alive.discard(worker.worker_id)
    elif mismatch == "stopping":
        worker.state = "stopping"
    else:
        async def stale_peer(peer, build, **kwargs):
            identity = await peer.call("GET", "/identity", None)
            return identity.model_copy(update={"host_epoch": identity.host_epoch - 1})
        runtime.wait_peer = stale_peer
        # The fake protocol method is patched globally, as production calls wait_peer directly.
        from unittest.mock import patch
        with patch("amazme_backend.host.session_access.wait_peer", stale_peer):
            with pytest.raises(BackendError, match="worker_identity_mismatch"):
                await owner.access.reader(worker.session_id)
        return
    with pytest.raises(BackendError, match="worker_identity_mismatch"):
        await owner.access.reader(worker.session_id)
    assert not any(path == "/workers/ensure" for _, path in runtime.calls)


async def test_blocked_profile_without_owner_does_not_spawn_diagnostic_worker(owner, runtime):
    await runtime.install(owner.lifecycle.build)
    runtime.blocked = ["cleanup_blocked"]
    with pytest.raises(BackendError, match="diagnostic_worker_unavailable"):
        await owner.access.reader("a" * 32)
    assert not any(path == "/workers/ensure" for _, path in runtime.calls)


async def test_exhausted_session_budget_is_reported_without_spawning(owner, runtime):
    await runtime.install(owner.lifecycle.build)
    runtime.blocked = ["worker_restart_budget_exhausted:" + "a" * 32]
    with pytest.raises(BackendError, match="worker_restart_budget_exhausted"):
        await owner.access.reader("a" * 32)
    assert not any(path == "/workers/ensure" for _, path in runtime.calls)


async def test_old_page_cannot_detach_current_binding(owner):
    app = application(owner)
    headers = {"Authorization": "Bearer web-only", "x-amazme-build": owner.lifecycle.build,
               "x-amazme-epoch": str(owner.lifecycle.fence.host_epoch)}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin, headers=headers) as client:
        path = "/api/v1/sessions/" + "a" * 32 + "/attachments"
        attachment = (await client.post(path)).json()["attachment_id"]
        assert (await client.delete(path + "/" + attachment)).status_code == 409
        assert attachment in owner.sessions.attachments
        client.headers["x-amazme-attachment"] = attachment
        client.headers["x-amazme-epoch"] = "0"
        assert (await client.delete(path + "/" + attachment)).status_code == 409
        assert attachment in owner.sessions.attachments


async def test_validation_cancel_work_settles_started_run_only_after_cleanup_proof(owner, monkeypatch):
    from amazme_backend.bootstrap.worker import create_worker
    from amazme_backend.contracts import Cleanup, FreezeWorker, Identity, Lease
    from amazme_backend.execution.client import SupervisorClient
    from amazme_backend.sessions.service import SessionStore
    from amazme_backend.sessions.types import Continue, ModelInvocation

    session = "a" * 32
    directory = owner.lifecycle.profile.path / "sessions" / session
    directory.mkdir(parents=True)
    source = SessionStore(directory / "session.sqlite", session, build=owner.lifecycle.build)
    await source.initialize()
    await source.fence(owner.lifecycle.fence)
    await source.accept(Submit(request_id="started", text="task"), owner.lifecycle.fence)
    for _ in range(5):
        action = await source.advance()
        if not isinstance(action, Continue):
            break
    assert isinstance(action, ModelInvocation)  # Persisted intent only; no model is invoked.
    await source.accept(Submit(request_id="queued", text="later"), owner.lifecycle.fence)
    await source.close()

    monkeypatch.setattr("amazme_backend.bootstrap.worker.build_id", lambda: owner.lifecycle.build)
    worker = create_worker(owner.lifecycle.profile, session, "validation", frozen=True, validation=True, require_existing=True)
    await worker.supervisor.close()
    worker.supervisor = SupervisorClient(owner.lifecycle.profile.socket("supervisor"), owner.lifecycle.profile.token)
    async def private_call(method, path, response, value):
        if path == "/workers/heartbeat":
            return Identity(profile_id=owner.lifecycle.profile.config.profile_id, instance_id="sup",
                build_id=owner.lifecycle.build, fingerprint=owner.lifecycle.build, role="supervisor", host_epoch=owner.lifecycle.fence.host_epoch, pid=1)
        if path == "/epochs/open":
            return Lease(session_id=session, worker_id="validation", execution_epoch=1,
                         supervisor_id="sup", build_id=owner.lifecycle.build)
        assert path == "/epochs/close"
        return Cleanup(session_id=session, execution_epoch=value.execution_epoch, state="clean", resources=[], proof_id="verified")
    worker.supervisor.call = AsyncMock(side_effect=private_call)
    try:
        await worker.initialize()
        freeze = FreezeWorker(**owner.lifecycle.fence.model_dump(), freeze_id="upgrade", cancel_work=True)
        snapshot = await worker.freeze(freeze)
        receipts = {r.request_id: r for r in snapshot.requests}
        assert receipts["queued"].status == "cancelled"
        assert receipts["started"].status == "unknown" and receipts["started"].cancel_requested
        assert snapshot.pending == 0
        assert worker.loop_task is None and worker.run_task is None
        assert all(call.args[1] in {"/workers/heartbeat", "/epochs/open", "/epochs/close"}
                   for call in worker.supervisor.call.await_args_list)
        record = await owner.lifecycle.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.lifecycle.build,
                                                              cancel_work=True), "b" * 64)
        owner.lifecycle.verify_frozen(snapshot, session, record)
        assert not (await owner.lifecycle.store.active_update()).activated
        # Clearing metadata freeze alone must not execute the deferred cancellation or any model/tool work.
        await worker.thaw(freeze)
        assert worker.loop_task is None
        assert (await worker.store.get("started")).status == "unknown"
    finally:
        await worker.shutdown()


@pytest.mark.parametrize("phase", ["freezing", "retiring", "prepared", "validating", "completed"])
async def test_host_restart_preserves_each_update_barrier(owner, runtime, phase):
    await runtime.install(owner.lifecycle.build)
    source = runtime.add_worker("a" * 32, build="b" * 64, state="stopped")
    active = await owner.lifecycle.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.lifecycle.build), "b" * 64)
    active.roster, active.phase = [source], phase
    await owner.lifecycle.store.save_update(active)
    await owner.lifecycle.store.db.close()
    private_write(owner.lifecycle.profile.path / "initialized", "2\n")
    owner.lifecycle.initialized = False
    replacement = Host(owner.lifecycle.profile, "replacement", runtime.lease("host", "replacement"))
    await replacement.lifecycle.supervisor.close()
    runtime.owner = replacement
    replacement.lifecycle.supervisor = runtime
    replacement.lifecycle._spawn_supervisor = runtime.spawn
    replacement.lifecycle._await_service = runtime.await_service
    try:
        await replacement.initialize()
        assert replacement.lifecycle.fence.host_epoch == owner.lifecycle.fence.host_epoch + 1
        restored = await replacement.lifecycle.store.active_update()
        assert restored.phase == phase and not restored.activated
        assert restored.roster[0].worker_id == source.worker_id
        assert runtime.freeze_id == "upgrade"
        assert not any(path == "/thaw" for _, path in runtime.calls)
        validated = await replacement.updates.resume_update("upgrade")
        assert not validated.activated
        assert all(w.state == "stopped" for w in validated.roster)
    finally:
        await replacement.close()


async def test_fully_activated_restart_is_not_a_pending_update(owner, runtime):
    await runtime.install(owner.lifecycle.build)
    await owner.lifecycle.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.lifecycle.build), "b" * 64)
    validated = await owner.updates.resume_update("upgrade")
    await owner.updates.complete_update(CompleteUpdate(update_id="upgrade", expected_revision=validated.revision))
    cut = len(runtime.calls)
    owner.lifecycle.attached = ""  # Force the same-build reconnect path after activation.
    await owner.lifecycle.ensure_supervisor()
    assert await owner.lifecycle.store.active_update() is None
    assert not any(path == "/freeze" for _, path in runtime.calls[cut:])


async def test_wrong_request_ack_keeps_outbox_pending(owner):
    peer = AsyncMock()
    peer.call.return_value = Receipt(request_id="other", text="task", status="queued")
    owner.access.worker = AsyncMock(return_value=peer)
    with pytest.raises(BackendError, match="receipt_identity_mismatch"):
        await owner.sessions.deliver("a" * 32, "submit", "stable", Submit(request_id="stable", text="task"))
    assert (await owner.lifecycle.store.pending())[0].state == "pending"


async def test_corrupt_outbox_payload_closes_admission_before_worker_access(owner):
    await owner.lifecycle.store.enqueue("a" * 32, "submit", "stable", Submit(request_id="stable", text="task"))
    await owner.lifecycle.store.db.call(lambda db: db.execute("UPDATE deliveries SET payload='{}'"))
    with pytest.raises(BackendError, match="storage_failure"):
        await owner.lifecycle.store.pending()
    assert owner.lifecycle.storage_failed
    owner.lifecycle.ensure_supervisor = AsyncMock()
    with pytest.raises(BackendError, match="storage_blocked"):
        await owner.access.worker("a" * 32)
    owner.lifecycle.ensure_supervisor.assert_not_awaited()


async def test_shutdown_waits_for_inflight_service_registration(owner, runtime):
    entered = asyncio.Event()
    release = asyncio.Event()
    real_spawn = runtime.spawn
    real_call = runtime.call

    async def spawn():
        entered.set()
        await release.wait()
        return await real_spawn()

    async def call(method, path, response, body=None):
        if path == "/shutdown":
            runtime.calls.append(("supervisor", path))
            runtime.alive.discard(runtime.service.instance_id)
            return runtime.identity()
        return await real_call(method, path, response, body)

    owner.lifecycle._spawn_supervisor = spawn
    runtime.call = call
    owner.lifecycle.initialized = True
    ensure = asyncio.create_task(owner.lifecycle.ensure_supervisor())
    await entered.wait()
    closing = asyncio.create_task(owner.close())
    try:
        await asyncio.sleep(0)
        assert not closing.done()
        release.set()
        await asyncio.wait_for(asyncio.gather(ensure, closing), 2)
        assert not runtime.alive
        assert runtime.calls[-1] == ("supervisor", "/shutdown")
    finally:
        release.set()
        await asyncio.gather(ensure, closing, return_exceptions=True)


@pytest.mark.parametrize("defect", ["missing", "foreign_session", "nonempty"])
async def test_update_never_activates_without_exact_empty_probe_receipt(owner, runtime, defect):
    await runtime.install(owner.lifecycle.build)
    record = await owner.lifecycle.store.begin_update(PrepareUpdate(update_id="probe", target_build=owner.lifecycle.build), "b" * 64)
    original = runtime.health

    def damaged_health():
        value = original().model_copy(deep=True)
        validation = {w.worker_id for w in value.workers if w.purpose == "validation"}
        if defect == "missing":
            value.epochs = [e for e in value.epochs if e.worker_id not in validation]
        else:
            for epoch in value.epochs:
                if epoch.worker_id in validation:
                    if defect == "foreign_session":
                        epoch.cleanup.session_id = "another-session"
                    else:
                        epoch.cleanup.resources = ["unexpected-user-scope"]
        return value

    runtime.health = damaged_health
    with pytest.raises(BackendError, match="validation_probe"):
        await owner.updates.complete_update(CompleteUpdate(update_id=record.update_id, expected_revision=record.revision))
    assert not (await owner.lifecycle.store.active_update()).activated
    assert not any(path == "/thaw" for _, path in runtime.calls)


async def test_one_session_budget_does_not_block_profile_health(owner, runtime):
    await runtime.install(owner.lifecycle.build)
    owner.lifecycle.attached = runtime.service.instance_id
    runtime.blocked = ["worker_restart_budget_exhausted:" + "a" * 32]
    health = await owner.lifecycle.health()
    assert health.state == "ready" and health.errors == []
    assert health.supervisor.session_errors["a" * 32] == ["worker_restart_budget_exhausted"]


async def test_session_recency_is_persisted_and_retries_do_not_move_it(store, tmp_path, lease, monkeypatch):
    first, second = "a" * 32, "b" * 32
    monkeypatch.setattr("amazme_backend.host.persistence.sessions.time.time_ns", lambda: 200_000_000)
    await store.create_session(second, CreateSession(title="second", workspace="docs"))
    monkeypatch.setattr("amazme_backend.host.persistence.sessions.time.time_ns", lambda: 300_000_000)
    submitted = Submit(request_id="stable-activity", text="later")
    await store.enqueue(first, "submit", submitted.request_id, submitted)
    monkeypatch.setattr("amazme_backend.host.persistence.sessions.time.time_ns", lambda: 400_000_000)
    await store.enqueue(first, "submit", submitted.request_id, submitted)
    sessions = (await store.sessions()).sessions
    # The fixture's first session was created with real wall time; its new activity
    # replaces that value. Replaying a receipt is not new conversation activity.
    assert [value.session_id for value in sessions] == [second, first]
    assert sessions[-1].updated_ms == 300
    await store.db.close()
    reopened = HostStore(tmp_path / "host.sqlite", require_existing=True)
    try:
        await reopened.initialize("replacement", "a" * 64, lease)
        assert (await reopened.sessions()).sessions == sessions
        assert (await reopened.create_session(first, CreateSession())).updated_ms == 300
    finally:
        await reopened.db.close()


async def test_delivery_pins_session_model_without_credentials_and_same_id_reuses_original(store):
    from pydantic import SecretStr

    from amazme_backend.contracts import ModelSelection, ProviderConfig, SessionModel

    session = "a" * 32
    config = ProviderConfig(provider="faux",model="faux",api_key=SecretStr("private-key"))
    await store.save_session_model(SessionModel(session_id=session,provider="deepseek",model="deepseek-flash"))
    original = Submit(request_id="pinned-model",text="task")
    delivery = await store.enqueue(session,"submit",original.request_id,original,provider=config)
    assert delivery.provider is not None
    assert (delivery.provider.provider,delivery.provider.model) == ("deepseek","deepseek-flash")
    assert not delivery.provider.api_key.get_secret_value()
    await store.save_session_model(SessionModel(session_id=session,provider="faux",model="faux"))
    replay = await store.enqueue(session,"submit",original.request_id,original,provider=config)
    assert replay.provider == delivery.provider
    pinned = await store.pin_delivery_provider(delivery.delivery_id,config)
    assert pinned.provider == delivery.provider
    explicit = original.model_copy(update={"request_id":"explicit-model", "model_selection":ModelSelection(provider="deepseek",model="deepseek-v4-pro")})
    captured = await store.enqueue(session,"submit",explicit.request_id,explicit,provider=config)
    assert captured.provider is not None and captured.provider.model == "deepseek-v4-pro"
    assert "private-key" not in captured.model_dump_json()


async def test_scheduled_delivery_captures_model_once_before_worker_dispatch(store):
    from amazme_backend.contracts import ProviderConfig, SessionModel

    session = "a" * 32
    value = Submit(request_id="scheduled-model",text="task")
    delivery = await store.enqueue(session,"submit",value.request_id,value)
    await store.save_session_model(SessionModel(session_id=session,provider="deepseek",model="deepseek-flash"))
    captured = await store.pin_delivery_provider(delivery.delivery_id,ProviderConfig(provider="faux",model="faux"))
    await store.save_session_model(SessionModel(session_id=session,provider="faux",model="faux"))
    original = await store.pin_delivery_provider(delivery.delivery_id,ProviderConfig(provider="faux",model="faux"))
    assert original.provider == captured.provider
    assert captured.provider is not None and captured.provider.model == "deepseek-flash"


async def test_quit_fence_rejects_racing_deliveries_and_never_resurrects_outbox(store, tmp_path, lease):
    session = "a" * 32
    await store.enqueue(session, "submit", "before-quit", Submit(request_id="before-quit", text="task"))
    await store.begin_quit()
    assert not await store.pending()
    with pytest.raises(BackendError, match="host_stopping"):
        await store.enqueue(session, "submit", "during-quit", Submit(request_id="during-quit", text="task"))
    await store.db.close()
    reopened = HostStore(tmp_path / "host.sqlite", require_existing=True)
    try:
        await reopened.initialize("after-quit", "a" * 64, lease)
        assert not await reopened.pending()
        await reopened.enqueue(session, "submit", "after-restart", Submit(request_id="after-restart", text="task"))
        assert [delivery.delivery_id for delivery in await reopened.pending()]
    finally:
        await reopened.db.close()


async def test_task_activity_uses_outbox_without_starting_an_idle_worker(owner):
    owner.lifecycle.ensure_supervisor = AsyncMock()
    assert (await owner.task_activity()) == TaskActivity(active=False, tasks=0)
    await owner.lifecycle.store.enqueue("a" * 32, "submit", "queued", Submit(request_id="queued", text="task"))
    assert (await owner.task_activity()).active
    await owner.lifecycle.store.begin_quit()
    assert not (await owner.task_activity()).active
    owner.lifecycle.ensure_supervisor.assert_not_awaited()


async def test_desktop_shutdown_cancels_durable_work_without_a_live_worker(tmp_path):
    from amazme_backend.execution.processes import ProcessReservation
    from amazme_backend.profiles.layout import session_database
    from amazme_backend.sessions.service import SessionStore, read_session

    private_write(tmp_path / "config.json", json.dumps({"profile_id": "shutdown", "workspace": str(tmp_path),
                  "resources": "unused", "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    with ProcessReservation(tmp_path, "host", "shutdown-host") as reservation:
        owner = Host(Profile(tmp_path), "shutdown-host", reservation.lease)
        owner.origin = "http://127.0.0.1:12345"
        try:
            # Initialize the lifecycle without a dispatcher so the queued root stays unstarted.
            await owner.lifecycle.initialize()
            session = "a" * 32
            await owner.sessions.create_session(CreateSession(session_id=session))
            path = session_database(tmp_path, session)
            path.parent.mkdir(parents=True, exist_ok=True)
            store = SessionStore(path, session, build=owner.lifecycle.build)
            try:
                await store.initialize()
                await store.fence(owner.lifecycle.fence)
                await store.accept(Submit(request_id="parked", text="task"), owner.lifecycle.fence)
            finally:
                await store.close()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(owner)),
                                        base_url=owner.origin,
                                        headers={"Authorization": "Bearer private-control"}) as client:
                response = await client.post("/control/shutdown", json=owner.lifecycle.fence.model_dump())
            assert response.status_code == 200
            async with read_session(path, session, build=owner.lifecycle.build) as reopened:
                assert not (await reopened.activity()).pending
        finally:
            await owner.close()


async def test_task_activity_reads_existing_session_and_supervised_work(owner):
    from amazme_backend.sessions.service import SessionStore

    session = "a" * 32
    directory = owner.lifecycle.profile.path / "sessions" / session
    directory.mkdir(parents=True)
    store = SessionStore(directory / "session.sqlite", session, build=owner.lifecycle.build)
    await store.initialize()
    await store.fence(owner.lifecycle.fence)
    await store.accept(Submit(request_id="running", text="task"), owner.lifecycle.fence)
    await store.close()
    try:
        assert (await owner.task_activity()).active
        reader = SessionStore(directory / "session.sqlite", session, build=owner.lifecycle.build, require_existing=True)
        await reader.initialize()
        await reader.cancel("running", owner.lifecycle.fence)
        await reader.close()
        assert not (await owner.task_activity()).active
    finally:
        await store.close()

    owner.lifecycle.attached = "supervisor"
    owner.lifecycle.supervisor = AsyncMock()
    owner.lifecycle.supervisor.call.return_value = TaskActivity(active=True, tasks=2)
    assert (await owner.task_activity()).tasks == 2
    owner.lifecycle.supervisor.call.side_effect = httpx.ReadError("unavailable")
    with pytest.raises(httpx.ReadError):
        await owner.task_activity()
