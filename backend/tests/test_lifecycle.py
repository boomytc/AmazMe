"""Host acceptance and update barriers backed by the actual metadata database."""
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from amazme_backend.common import Profile, private_write
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
    WorkerActivity,
)
from amazme_backend.host import Host, application
from amazme_backend.host_store import HostStore


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
    monkeypatch.setattr("amazme_backend.host.build_id", lambda: "a" * 64)
    value = Host(Profile(tmp_path))
    value.fence = HostFence(host_epoch=await value.store.initialize(value.instance, value.build, lease), build_id=value.build)
    value.origin = "http://127.0.0.1:12345"
    await value.store.create_session("a" * 32, CreateSession())
    try:
        yield value
    finally:
        await value.supervisor.close()
        await value.store.db.close()


async def test_unknown_session_read_never_spawns_worker(owner):
    owner.ensure_supervisor = AsyncMock()
    with pytest.raises(BackendError, match="session_not_found"):
        await owner.worker("b" * 32, maintenance=True)
    owner.ensure_supervisor.assert_not_awaited()


async def test_http_fence_attachment_and_private_update_capability(owner):
    owner.deliver = AsyncMock(return_value=Receipt(request_id="r", text="hello", status="queued"))
    app = application(owner)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin,
            headers={"Authorization": "Bearer web-only"}) as client:
        path = "/api/v1/sessions/" + "a" * 32 + "/submissions"
        assert (await client.post(path, json={"request_id": "r", "text": "hello"})).status_code == 409
        client.headers.update({"x-amazme-build": owner.build, "x-amazme-epoch": str(owner.fence.host_epoch)})
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
    assert owner.deliver.await_count == 1


async def test_host_database_failure_closes_every_admission(owner, monkeypatch):
    await owner.store.db.call(lambda db: db.execute("DROP TABLE sessions"))
    with pytest.raises(BackendError) as failure:
        await owner.sessions()
    assert failure.value.code == "storage_failure"
    assert owner.storage_failed
    owner.ensure_supervisor = AsyncMock()
    for action in (
        lambda: owner.create_session(CreateSession()),
        lambda: owner.worker("a" * 32),
        lambda: owner.deliver("a" * 32, "submit", "r", Submit(request_id="r", text="task")),
        lambda: owner.prepare_update(PrepareUpdate(update_id="u", target_build=owner.build)),
        lambda: owner.resume_update("u"),
        lambda: owner.complete_update(CompleteUpdate(update_id="u", expected_revision="1")),
    ):
        with pytest.raises(BackendError, match="storage_blocked"):
            await action()
    owner.ensure_supervisor.assert_not_awaited()
    assert (await owner.health()).errors == ["storage_failed"]


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
    from amazme_backend.storage import SessionStore
    worker_store = SessionStore(owner.profile.path / "session.sqlite", "a" * 32, build=owner.build)
    await worker_store.initialize()
    await worker_store.fence(owner.fence)
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
    owner.worker = AsyncMock(return_value=peer)
    value = Submit(request_id="stable", text="hello")
    try:
        with pytest.raises(httpx.ReadError):
            await owner.deliver("a" * 32, "submit", "stable", value)
        assert len(await owner.store.pending()) == 1
        first = await worker_store.get("stable")
        retried = await owner.deliver("a" * 32, "submit", "stable", value)
        assert retried.accepted_revision == first.accepted_revision
        assert len((await worker_store.snapshot()).requests) == 1
        assert not await owner.store.pending()
    finally:
        await worker_store.db.close()


@pytest.mark.parametrize("failure", ["worker_identity_conflict", "execution_cleanup_pending", "storage_failure", "stale_host_epoch"])
async def test_runtime_failure_never_permanently_rejects_outbox(owner, failure):
    owner.worker = AsyncMock(side_effect=BackendError(failure))
    value = Submit(request_id="retry", text="task")
    with pytest.raises(BackendError, match=failure):
        await owner.deliver("a" * 32, "submit", "retry", value)
    assert (await owner.store.pending())[0].state == "pending"
    peer = AsyncMock()
    peer.call.side_effect = BackendError(failure)
    owner.worker = AsyncMock(return_value=peer)
    with pytest.raises(BackendError, match=failure):
        await owner.deliver("a" * 32, "submit", "retry", value)
    assert (await owner.store.pending())[0].state == "pending"


async def test_acceptance_ack_does_not_depend_on_activity_rpc(owner):
    receipt = Receipt(request_id="accepted", text="task", status="queued", accepted_revision="1")
    peer = AsyncMock()

    async def call(method, path, response, body=None):
        if path == "/activity":
            raise httpx.ReadError("activity unavailable")
        return receipt

    peer.call.side_effect = call
    owner.worker = AsyncMock(return_value=peer)
    assert await owner.deliver("a" * 32, "submit", "accepted", Submit(request_id="accepted", text="task")) == receipt
    assert not await owner.store.pending()


async def test_nine_sessions_progress_while_first_eight_are_stalled(owner):
    sessions = [f"{i:032x}" for i in range(9)]
    for session in sessions:
        await owner.store.create_session(session, CreateSession())
        await owner.store.enqueue(session, "submit", session, Submit(request_id=session, text="task"))
    owner.ensure_supervisor = AsyncMock()
    blocked = asyncio.Event()
    done = asyncio.Event()

    async def dispatch(delivery):
        if delivery.session_id != sessions[-1]:
            await blocked.wait()
        else:
            done.set()
        return delivery

    owner._dispatch = dispatch
    owner.worker = AsyncMock(side_effect=BackendError("worker_unavailable"))
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
        self.epoch = owner.fence.host_epoch
        self.drop_retire = False
        self.lose_thaw = False
        self.epochs = []
        self.blocked = []
        monkeypatch.setattr("amazme_backend.host.exited", lambda lease: lease.instance_id not in self.alive)
        monkeypatch.setattr("amazme_backend.host.wait_exited", self.wait_exited)
        monkeypatch.setattr("amazme_backend.host.wait_peer", self.wait_peer)
        monkeypatch.setattr("amazme_backend.host.Peer", self.peer)
        owner._spawn_supervisor = self.spawn
        owner._await_service = self.await_service
        owner.supervisor = self

    def lease(self, role, instance):
        return ProcessLease(instance_id=instance, role=role, profile_path=str(self.owner.profile.path),
                            path=str(self.owner.profile.path / instance), device=1, inode=len(instance))

    async def install(self, build, state="running", alive=True):
        from amazme_backend.host_store import ServiceRecord
        self.service = ServiceRecord(instance_id="svc" + str(len(await self.owner.store.services())),
            build_id=build, process_lease=self.lease("supervisor", "svc" + str(len(await self.owner.store.services()))), state=state)
        await self.owner.store.save_service(self.service)
        if alive:
            self.alive.add(self.service.instance_id)
        return self.service

    async def spawn(self):
        self.owner.supervisor = self
        self.calls.append(("spawn", self.owner.build))
        return await self.install(self.owner.build, "starting")

    def identity(self):
        from amazme_backend.contracts import Identity
        # A per-session restart budget is reported in the blocked list. It does not by itself
        # mean the supervisor lost its VM or fence, matching Supervisor.identity.
        execution_blocked = any(not str(item).startswith("worker_restart_budget_exhausted:") for item in self.blocked)
        return Identity(profile_id=self.owner.profile.config.profile_id, instance_id=self.service.instance_id,
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
                return Identity(profile_id=self.owner.profile.config.profile_id, instance_id=worker.worker_id,
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
        if path == "/thaw":
            assert all(w.state == "stopped" for w in self.workers.values())
            self.freeze_id = ""
            if self.lose_thaw:
                self.lose_thaw = False
                raise httpx.ReadError("thaw committed, ACK lost")
        return self.health()


@pytest.fixture
async def runtime(owner, monkeypatch):
    await owner.supervisor.close()
    return UpdateRuntime(owner, monkeypatch)


@pytest.mark.parametrize("alive", [True, False])
async def test_old_service_replacement_always_creates_update_freeze(owner, runtime, alive):
    await runtime.install("b" * 64, alive=alive)
    if alive:
        runtime.add_worker("a" * 32, build="b" * 64)
    await owner.ensure_supervisor()
    active = await owner.store.active_update()
    assert active and active.target_build == owner.build and active.source_build == "b" * 64
    assert runtime.freeze_id == active.update_id
    assert len(await owner.store.services()) == 2
    with pytest.raises(BackendError, match="update_frozen"):
        await owner.worker("a" * 32)


async def test_stopping_service_is_retired_without_business_takeover(owner, runtime):
    old = await runtime.install(owner.build, state="stopping")
    await owner.ensure_supervisor()
    assert old.instance_id not in runtime.alive
    assert runtime.calls.index(("supervisor", "/retire")) < runtime.calls.index(("supervisor", "/takeover"))
    assert (await owner.store.services())[0].state == "stopped"
    assert await owner.store.active_update()


async def test_stopped_but_live_service_blocks_replacement(owner, runtime):
    await runtime.install(owner.build, state="stopped", alive=True)
    with pytest.raises(BackendError, match="supervisor_exit_unproven"):
        await owner.ensure_supervisor()
    assert not runtime.calls


async def test_service_registry_cannot_overwrite_identity_or_resurrect(owner, runtime):
    service = await runtime.install(owner.build, state="stopping")
    with pytest.raises(BackendError, match="supervisor_retirement_pending"):
        await owner.store.save_service(service.model_copy(update={"state": "running"}))
    with pytest.raises(BackendError, match="supervisor_identity_mismatch"):
        await owner.store.save_service(service.model_copy(update={"build_id": "b" * 64}))
    with pytest.raises(BackendError, match="supervisor_registry_conflict"):
        await runtime.install(owner.build)


async def test_prepare_freezes_and_stops_each_session_before_retire(owner, runtime):
    await runtime.install(owner.build)
    one = runtime.add_worker("a" * 32)
    await owner.store.create_session("b" * 32, CreateSession())
    prepared = await owner.prepare_update(PrepareUpdate(update_id="upgrade", target_build="b" * 64))
    assert prepared.phase == "prepared" and not prepared.activated
    assert len(prepared.roster) == 2
    assert runtime.calls.index((one.worker_id, "/freeze")) < runtime.calls.index(("supervisor", "/workers/stop"))
    assert all(w.state == "stopped" for w in prepared.roster)
    assert {w.session_id for w in prepared.roster} == {"a" * 32, "b" * 32}
    assert runtime.calls[-1] == ("supervisor", "/retire")
    with pytest.raises(BackendError, match="update_prepared"):
        await owner.ensure_supervisor()


async def test_retire_receipt_cannot_drop_participant(owner, runtime):
    await runtime.install("b" * 64)
    worker = runtime.add_worker("a" * 32)
    runtime.drop_retire = True
    with pytest.raises(BackendError) as failure:
        await owner.ensure_supervisor()
    assert failure.value.code == "participant_missing"
    active = await owner.store.active_update()
    assert [w.worker_id for w in active.roster] == [worker.worker_id]
    assert not active.activated
    assert (await owner.store.services())[0].state == "stopping"
    assert not any(call[0] == "spawn" for call in runtime.calls)


@pytest.mark.parametrize("phase", ["freezing", "retiring", "prepared", "validating", "completed"])
async def test_target_replays_every_phase_without_implicit_activation(owner, runtime, phase):
    await runtime.install(owner.build)
    source = runtime.add_worker("a" * 32, build="b" * 64, state="stopped")
    active = await owner.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.build), "b" * 64)
    active.roster, active.phase = [source], phase
    await owner.store.save_update(active)
    # An orphan from an interrupted validation must be retired, never used as a probe.
    business = runtime.add_worker("a" * 32)
    resumed = await owner.resume_update("upgrade")
    assert not resumed.activated
    assert runtime.freeze_id == "upgrade"
    assert resumed.phase == ("completed" if phase == "completed" else "validating")
    assert resumed.validation.purpose == "validation"
    assert business.worker_id not in {w.worker_id for w in [resumed.validation]}
    assert all(w.state == "stopped" for w in resumed.roster)
    assert not any(call[1] == "/thaw" for call in runtime.calls)
    completed = await owner.complete_update(CompleteUpdate(update_id="upgrade", expected_revision=resumed.revision))
    assert completed.activated and await owner.store.active_update() is None
    assert not runtime.freeze_id
    previous_calls = len(runtime.calls)
    assert (await owner.complete_update(CompleteUpdate(update_id="upgrade", expected_revision="old"))).activated
    assert len(runtime.calls) == previous_calls


async def test_lost_thaw_ack_refreezes_revalidates_then_activates(owner, runtime):
    await runtime.install(owner.build)
    await owner.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.build), "b" * 64)
    record = await owner.resume_update("upgrade")
    runtime.lose_thaw = True
    with pytest.raises(httpx.ReadError):
        await owner.complete_update(CompleteUpdate(update_id="upgrade", expected_revision=record.revision))
    active = await owner.store.active_update()
    assert active.phase == "completed" and not active.activated
    assert runtime.freeze_id == ""
    cut = len(runtime.calls)
    resumed = await owner.resume_update("upgrade")
    assert runtime.freeze_id == "upgrade" and not resumed.activated
    calls = runtime.calls[cut:]
    assert calls.index(("supervisor", "/freeze")) < calls.index(("supervisor", "/workers/ensure"))
    assert (await owner.complete_update(CompleteUpdate(update_id="upgrade", expected_revision=resumed.revision))).activated


async def test_update_roster_never_shrinks_or_changes_lifetime_identity(owner, runtime):
    await runtime.install(owner.build)
    worker = runtime.add_worker("a" * 32, state="stopped")
    active = await owner.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.build), "b" * 64)
    active = await owner.store.source_roster(active.update_id, [worker])
    with pytest.raises(BackendError) as failure:
        await owner.store.source_roster(active.update_id, [])
    assert failure.value.code == "participant_missing"
    changed = worker.model_copy(update={"process_lease": runtime.lease("worker", "different")})
    with pytest.raises(BackendError) as failure:
        await owner.store.source_roster(active.update_id, [changed])
    assert failure.value.code == "participant_identity_mismatch"
    assert (await owner.store.update(active.update_id)).roster == [worker]


@pytest.mark.parametrize("problem", ["missing_worker", "live_worker", "unclean_epoch", "missing_cleanup", "blocked"])
async def test_target_health_failure_retains_freeze(owner, runtime, problem):
    from amazme_backend.contracts import EpochHealth
    await runtime.install(owner.build)
    worker = runtime.add_worker("a" * 32, build="b" * 64, state="stopped")
    active = await owner.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.build), "b" * 64)
    active.roster, active.phase = [worker], "prepared"
    await owner.store.save_update(active)
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
        await owner.resume_update("upgrade")
    assert not (await owner.store.active_update()).activated
    assert not any(call[1] == "/thaw" for call in runtime.calls)


async def test_blocked_session_diagnostics_reuse_verified_owner_without_mutations(owner, runtime):
    from amazme_backend.contracts import Cancel, Snapshot
    await runtime.install(owner.build)
    worker = runtime.add_worker("a" * 32, state="blocked")
    runtime.blocked = ["cleanup_blocked"]
    reader = await owner.reader(worker.session_id)
    assert (await reader.call("GET", "/snapshot", Snapshot)).session_id == worker.session_id
    assert not any(path in {"/takeover", "/workers/ensure", "/freeze"} for _, path in runtime.calls)
    with pytest.raises(BackendError, match="read_only_peer"):
        await reader.call("POST", "/requests/r/cancel", Receipt, Cancel(**owner.fence.model_dump(), request_id="r"))
    with pytest.raises(BackendError, match="execution_blocked"):
        await owner.deliver(worker.session_id, "cancel", "r", Cancel(host_epoch=0, build_id="", request_id="r"))
    assert not any(path.endswith("/cancel") for _, path in runtime.calls)
    assert len(await owner.store.pending()) == 1
    # The unchanged stream API also receives only the read capability.
    stream_peer = await owner.worker(worker.session_id, maintenance=True)
    with pytest.raises(BackendError, match="read_only_peer"):
        await stream_peer.call("POST", "/anything", Receipt)


@pytest.mark.parametrize("mismatch", ["build", "epoch", "fingerprint", "exited", "stopping", "peer_epoch"])
async def test_diagnostic_owner_requires_current_identity_and_lifetime(owner, runtime, mismatch):
    await runtime.install(owner.build)
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
        with patch("amazme_backend.host.wait_peer", stale_peer):
            with pytest.raises(BackendError, match="worker_identity_mismatch"):
                await owner.reader(worker.session_id)
        return
    with pytest.raises(BackendError, match="worker_identity_mismatch"):
        await owner.reader(worker.session_id)
    assert not any(path == "/workers/ensure" for _, path in runtime.calls)


async def test_blocked_profile_without_owner_does_not_spawn_diagnostic_worker(owner, runtime):
    await runtime.install(owner.build)
    runtime.blocked = ["cleanup_blocked"]
    with pytest.raises(BackendError, match="diagnostic_worker_unavailable"):
        await owner.reader("a" * 32)
    assert not any(path == "/workers/ensure" for _, path in runtime.calls)


async def test_exhausted_session_budget_is_reported_without_spawning(owner, runtime):
    await runtime.install(owner.build)
    runtime.blocked = ["worker_restart_budget_exhausted:" + "a" * 32]
    with pytest.raises(BackendError, match="worker_restart_budget_exhausted"):
        await owner.reader("a" * 32)
    assert not any(path == "/workers/ensure" for _, path in runtime.calls)


async def test_old_page_cannot_detach_current_binding(owner):
    app = application(owner)
    headers = {"Authorization": "Bearer web-only", "x-amazme-build": owner.build,
               "x-amazme-epoch": str(owner.fence.host_epoch)}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin, headers=headers) as client:
        path = "/api/v1/sessions/" + "a" * 32 + "/attachments"
        attachment = (await client.post(path)).json()["attachment_id"]
        assert (await client.delete(path + "/" + attachment)).status_code == 409
        assert attachment in owner.attachments
        client.headers["x-amazme-attachment"] = attachment
        client.headers["x-amazme-epoch"] = "0"
        assert (await client.delete(path + "/" + attachment)).status_code == 409
        assert attachment in owner.attachments


async def test_validation_cancel_work_settles_started_run_only_after_cleanup_proof(owner, monkeypatch):
    from amazme_backend.contracts import Cleanup, FreezeWorker, Identity, Lease
    from amazme_backend.session_domain import Continue, ModelInvocation
    from amazme_backend.storage import SessionStore
    from amazme_backend.worker import Worker

    session = "a" * 32
    directory = owner.profile.path / "sessions" / session
    directory.mkdir(parents=True)
    source = SessionStore(directory / "session.sqlite", session, build=owner.build)
    await source.initialize()
    await source.fence(owner.fence)
    await source.accept(Submit(request_id="started", text="task"), owner.fence)
    for _ in range(5):
        action = await source.advance()
        if not isinstance(action, Continue):
            break
    assert isinstance(action, ModelInvocation)  # Persisted intent only; no model is invoked.
    await source.accept(Submit(request_id="queued", text="later"), owner.fence)
    await source.db.close()

    monkeypatch.setattr("amazme_backend.worker.build_id", lambda: owner.build)
    worker = Worker(owner.profile, session, "validation", frozen=True, validation=True, require_existing=True)
    await worker.supervisor.close()
    worker.supervisor = AsyncMock()
    async def private_call(method, path, response, value):
        if path == "/workers/heartbeat":
            return Identity(profile_id=owner.profile.config.profile_id, instance_id="sup",
                build_id=owner.build, fingerprint=owner.build, role="supervisor", host_epoch=owner.fence.host_epoch, pid=1)
        if path == "/epochs/open":
            return Lease(session_id=session, worker_id="validation", execution_epoch=1,
                         supervisor_id="sup", build_id=owner.build)
        assert path == "/epochs/close"
        return Cleanup(session_id=session, execution_epoch=value.execution_epoch, state="clean", resources=[], proof_id="verified")
    worker.supervisor.call.side_effect = private_call
    try:
        await worker.initialize()
        freeze = FreezeWorker(**owner.fence.model_dump(), freeze_id="upgrade", cancel_work=True)
        snapshot = await worker.freeze(freeze)
        receipts = {r.request_id: r for r in snapshot.requests}
        assert receipts["queued"].status == "cancelled"
        assert receipts["started"].status == "unknown" and receipts["started"].cancel_requested
        assert snapshot.pending == 0
        assert worker.loop_task is None and worker.run_task is None
        assert all(call.args[1] in {"/workers/heartbeat", "/epochs/open", "/epochs/close"}
                   for call in worker.supervisor.call.await_args_list)
        record = await owner.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.build,
                                                              cancel_work=True), "b" * 64)
        owner._verify_frozen(snapshot, session, record)
        assert not (await owner.store.active_update()).activated
        # Clearing metadata freeze alone must not execute the deferred cancellation or any model/tool work.
        await worker.thaw(freeze)
        assert worker.loop_task is None
        assert (await worker.store.get("started")).status == "unknown"
    finally:
        await worker.shutdown()


@pytest.mark.parametrize("phase", ["freezing", "retiring", "prepared", "validating", "completed"])
async def test_host_restart_preserves_each_update_barrier(owner, runtime, phase):
    await runtime.install(owner.build)
    source = runtime.add_worker("a" * 32, build="b" * 64, state="stopped")
    active = await owner.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.build), "b" * 64)
    active.roster, active.phase = [source], phase
    await owner.store.save_update(active)
    await owner.store.db.close()
    private_write(owner.profile.path / "initialized", "2\n")
    replacement = Host(owner.profile, "replacement", runtime.lease("host", "replacement"))
    await replacement.supervisor.close()
    runtime.owner = replacement
    replacement.supervisor = runtime
    replacement._spawn_supervisor = runtime.spawn
    replacement._await_service = runtime.await_service
    try:
        await replacement.initialize()
        assert replacement.fence.host_epoch == owner.fence.host_epoch + 1
        restored = await replacement.store.active_update()
        assert restored.phase == phase and not restored.activated
        assert restored.roster[0].worker_id == source.worker_id
        assert runtime.freeze_id == "upgrade"
        assert not any(path == "/thaw" for _, path in runtime.calls)
        validated = await replacement.resume_update("upgrade")
        assert not validated.activated
        assert all(w.state == "stopped" for w in validated.roster)
    finally:
        replacement.stop.set()
        if replacement.background:
            replacement.background.cancel()
            await asyncio.gather(replacement.background, return_exceptions=True)
        for _, peer in replacement.worker_peers.values():
            await peer.close()
        await replacement.store.db.close()


async def test_fully_activated_restart_is_not_a_pending_update(owner, runtime):
    await runtime.install(owner.build)
    await owner.store.begin_update(PrepareUpdate(update_id="upgrade", target_build=owner.build), "b" * 64)
    validated = await owner.resume_update("upgrade")
    await owner.complete_update(CompleteUpdate(update_id="upgrade", expected_revision=validated.revision))
    cut = len(runtime.calls)
    owner.attached = ""  # Force the same-build reconnect path after activation.
    await owner.ensure_supervisor()
    assert await owner.store.active_update() is None
    assert not any(path == "/freeze" for _, path in runtime.calls[cut:])


async def test_wrong_request_ack_keeps_outbox_pending(owner):
    peer = AsyncMock()
    peer.call.return_value = Receipt(request_id="other", text="task", status="queued")
    owner.worker = AsyncMock(return_value=peer)
    with pytest.raises(BackendError, match="receipt_identity_mismatch"):
        await owner.deliver("a" * 32, "submit", "stable", Submit(request_id="stable", text="task"))
    assert (await owner.store.pending())[0].state == "pending"


async def test_corrupt_outbox_payload_closes_admission_before_worker_access(owner):
    await owner.store.enqueue("a" * 32, "submit", "stable", Submit(request_id="stable", text="task"))
    await owner.store.db.call(lambda db: db.execute("UPDATE deliveries SET payload='{}'"))
    with pytest.raises(BackendError, match="storage_failure"):
        await owner.store.pending()
    assert owner.storage_failed
    owner.ensure_supervisor = AsyncMock()
    with pytest.raises(BackendError, match="storage_blocked"):
        await owner.worker("a" * 32)
    owner.ensure_supervisor.assert_not_awaited()


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

    owner._spawn_supervisor = spawn
    runtime.call = call
    owner.initialized = True
    ensure = asyncio.create_task(owner.ensure_supervisor())
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
    await runtime.install(owner.build)
    record = await owner.store.begin_update(PrepareUpdate(update_id="probe", target_build=owner.build), "b" * 64)
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
        await owner.complete_update(CompleteUpdate(update_id=record.update_id, expected_revision=record.revision))
    assert not (await owner.store.active_update()).activated
    assert not any(path == "/thaw" for _, path in runtime.calls)


async def test_one_session_budget_does_not_block_profile_health(owner, runtime):
    await runtime.install(owner.build)
    owner.attached = runtime.service.instance_id
    runtime.blocked = ["worker_restart_budget_exhausted:" + "a" * 32]
    health = await owner.health()
    assert health.state == "ready" and health.errors == []
    assert health.supervisor.session_errors["a" * 32] == ["worker_restart_budget_exhausted"]
