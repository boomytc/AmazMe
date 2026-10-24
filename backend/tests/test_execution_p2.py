"""Execution fault tests; no VM, Docker daemon, network listener, or credentials."""

import asyncio
import json
import os
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio

from amazme_backend.common import Profile, lock, private_write
from amazme_backend.contracts import (
    BackendError,
    EffectResolution,
    FreezeSupervisor,
    HostFence,
    Identity,
    OpenCode,
    PluginCallEnvelope,
    PluginResult,
    ResolveEffect,
    RetireSupervisor,
    RunTool,
    StopWorker,
    ToolLookup,
    WorkerInfo,
    WorkerRequest,
    WorkerSpec,
)
from amazme_backend.processes import ProcessReservation, exited
from amazme_backend.supervisor import ExecutionDB, Supervisor, retirement_proof


@pytest.fixture
def profile(tmp_path, monkeypatch):
    private_write(tmp_path / "config.json", json.dumps({"format": 2, "profile_id": "native-test",
        "workspace": str(tmp_path), "resources": "unused", "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "test-token")
    monkeypatch.setattr("amazme_backend.supervisor.build_id", lambda: "build-one")
    return Profile(tmp_path)


@pytest_asyncio.fixture
async def owner(profile):
    owner = Supervisor(profile, "supervisor-one")
    await owner.initialize()
    owner.monitor_task.cancel()
    await asyncio.gather(owner.monitor_task, return_exceptions=True)
    owner.reservations = []
    try:
        yield owner
    finally:
        await owner._cancel_jobs()
        for reservation in owner.reservations:
            reservation.close()
        await owner.close()


def seed_session(profile: Path, session_id: str, workspace: str = "primary") -> None:
    connection = sqlite3.connect(profile / "host.sqlite")
    try:
        connection.execute("CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL)")
        connection.execute(
            "INSERT INTO sessions(id, workspace) VALUES(?, ?) "
            "ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace",
            (session_id, workspace))
        connection.commit()
    finally:
        connection.close()


async def worker(owner, session="a" * 32, purpose="business", build=None):
    seed_session(owner.profile.path, session)
    instance = os.urandom(16).hex()
    directory = owner.profile.path / "sessions" / session
    directory.mkdir(parents=True, exist_ok=True)
    reservation = ProcessReservation(owner.profile.path, "worker", instance)
    owner.reservations.append(reservation)
    info = WorkerInfo(session_id=session, worker_id=instance, pid=123,
        socket=str(owner.profile.worker_socket(session)), build_id=build or owner.build,
        process_lease=reservation.lease, state="ready", purpose=purpose,
        host_epoch=owner.host_epoch, fingerprint=build or owner.build)
    await owner.db.call(lambda db: db.execute("INSERT INTO workers(worker,session,info) VALUES(?,?,?)",
        (instance, session, info.model_dump_json())), write=True)
    return info, reservation


def request(info):
    return WorkerRequest(session_id=info.session_id, worker_id=info.worker_id, build_id=info.build_id)


async def call(owner, info, identity="call", effect="write"):
    epoch = await owner.open_epoch(request(info))
    return RunTool(**epoch.model_dump(), call_id=identity, request_id="request", command="echo ok", effect=effect)


async def no_peer(*_):
    raise httpx.ConnectError("not listening")


async def test_resolution_cannot_waive_cleanup_or_change_scope(owner):
    info, _ = await worker(owner)
    value = await call(owner, info)
    async def crash(point, **_):
        if point == "permitted":
            raise RuntimeError()
    owner.faults.hit = crash
    with pytest.raises(RuntimeError):
        await owner.run_tool(value)
    resolution = EffectResolution(resolution_id="r", call_id=value.call_id, outcome="not_applied", evidence="checked")
    with pytest.raises(BackendError, match="execution_cleanup_pending"):
        await owner.resolve_effect(ResolveEffect(**request(info).model_dump(), resolution=resolution))
    other, _ = await worker(owner, "b" * 32)
    with pytest.raises(BackendError, match="effect_scope_mismatch"):
        await owner.resolve_effect(ResolveEffect(**request(other).model_dump(), resolution=resolution))


async def test_stale_close_cannot_close_new_epoch(owner):
    info, _ = await worker(owner)
    old = await owner.open_epoch(request(info))
    proof = await owner.cleanup(info.session_id, old)
    fresh = await owner.open_epoch(request(info))
    assert await owner.cleanup(info.session_id, old) == proof
    await owner.check_lease(fresh)
    assert fresh.execution_epoch > old.execution_epoch
    forged = old.model_copy(update={"supervisor_id": "other"})
    with pytest.raises(BackendError, match="stale_execution_epoch"):
        await owner.cleanup(info.session_id, forged)


async def test_process_exit_and_writer_release_are_both_required(owner):
    info, reservation = await worker(owner)
    with pytest.raises(BackendError, match="worker_retirement_unproven"):
        with retirement_proof(owner.profile, info):
            pass
    reservation.close()
    with lock(owner.profile.path / "sessions" / info.session_id / "writer.lock"):
        with pytest.raises(BackendError, match="worker_retirement_unproven"):
            with retirement_proof(owner.profile, info):
                pass
    with retirement_proof(owner.profile, info):
        assert not exited(info.process_lease)
    assert exited(info.process_lease)
    Path(info.process_lease.path).unlink()
    Path(info.process_lease.path).write_text(info.process_lease.model_dump_json())
    with pytest.raises(BackendError):
        with retirement_proof(owner.profile, info):
            pass


async def test_unknown_old_worker_never_overwritten(owner, monkeypatch):
    info, _ = await worker(owner)
    info.state = "unknown"
    await owner._save_worker(info)
    spawn = AsyncMock()
    monkeypatch.setattr("amazme_backend.supervisor.asyncio.create_subprocess_exec", spawn)
    with pytest.raises(BackendError, match="worker_retirement_pending"):
        await owner.ensure_worker(WorkerSpec(session_id=info.session_id, build_id=owner.build, host_epoch=0))
    assert [w.worker_id for w in await owner._workers()] == [info.worker_id]
    spawn.assert_not_called()


async def test_spawn_registration_precedes_native_spawn_and_parent_only_closes_copy(owner, monkeypatch):
    child_fds = []
    async def spawn(*args, **kwargs):
        workers = await owner._workers()
        assert len(workers) == 1 and workers[0].pid == 0
        assert workers[0].process_lease is not None and not exited(workers[0].process_lease)
        assert "--lifetime-fd" in args and "--frozen" in args
        child_fds.append(os.dup(kwargs["pass_fds"][0]))
        return SimpleNamespace(pid=1234, returncode=None, wait=AsyncMock())
    monkeypatch.setattr("amazme_backend.supervisor.asyncio.create_subprocess_exec", spawn)
    try:
        value = WorkerSpec(session_id="a" * 32, build_id=owner.build, host_epoch=0, frozen=True)
        workers = await asyncio.gather(*(owner.ensure_worker(value) for _ in range(8)))
        assert len({w.worker_id for w in workers}) == 1
        assert not exited(workers[0].process_lease)
        assert len(child_fds) == 1
    finally:
        for fd in child_fds:
            os.close(fd)


async def test_takeover_requires_every_live_worker_ack(owner):
    first, _ = await worker(owner)
    second, _ = await worker(owner, "b" * 32)
    seen = []
    async def peer(info, *args):
        seen.append(info.worker_id)
        if info.worker_id == second.worker_id:
            raise httpx.ConnectError("paused")
        return Identity(build_id=owner.build, profile_id=owner.profile.config.profile_id, instance_id=info.worker_id,
                        pid=1, role="worker", host_epoch=7, fingerprint=owner.build)
    owner._peer_identity = peer
    fence = HostFence(build_id=owner.build, host_epoch=7)
    with pytest.raises(BackendError) as error:
        await owner.takeover(fence)
    assert error.value.code == "worker_fence_pending"
    assert seen == [first.worker_id, second.worker_id] and owner.host_epoch == 7
    with pytest.raises(BackendError, match="worker_fence_pending"):
        await owner.open_epoch(request(first))
    with pytest.raises(BackendError, match="stale_host_epoch"):
        await owner.takeover(fence.model_copy(update={"host_epoch": 6}))


async def test_freeze_blocks_a_new_shell_and_returns_the_finished_one(owner):
    info, _ = await worker(owner)

    async def ready(worker, method="GET", path="/identity", body=None):
        return Identity(build_id=owner.build, profile_id=owner.profile.config.profile_id,
                        instance_id=worker.worker_id, pid=123, role="worker", host_epoch=owner.host_epoch,
                        fingerprint=owner.build, state="ready")

    owner._peer_identity = ready
    done = await call(owner, info, identity="done")
    assert (await owner.run_tool(done)).stdout == "ok\n"
    epoch = await owner.open_epoch(request(info))
    await owner.freeze(FreezeSupervisor(build_id=owner.build, host_epoch=owner.host_epoch, freeze_id="hold"))
    blocked = RunTool(**epoch.model_dump(), call_id="during", request_id="request",
                      command="printf z > frozen-shell.txt", effect="write")
    with pytest.raises(BackendError, match="supervisor_frozen"):
        await owner.run_tool(blocked)
    assert not (owner.profile.path / "frozen-shell.txt").exists()
    assert (await owner.run_tool(done)).stdout == "ok\n"


async def test_freeze_returns_finished_code_and_plugin_calls(owner):
    session = "a" * 32
    run_id = "b" * 32
    plugin_id = "c" * 32
    call_id = "d" * 32
    await owner.db.call(lambda db: db.execute(
        "INSERT INTO code_runs(id,session,source,phase,value,committed) VALUES(?,?,?,'success','3',1)",
        (run_id, session, "1+2")), write=True)
    await owner.db.call(lambda db: db.execute("INSERT INTO code_results VALUES(?,?)",
        (run_id,json.dumps({"run_id":run_id,"phase":"success","value":"3"}))),write=True)
    await owner.db.call(lambda db: db.execute(
        "INSERT INTO plugins(id,name,session,capabilities,config,fingerprint) VALUES(?,?,?,?,?,?)",
        (plugin_id, "greeting", session, "[]", "{}", "fp")), write=True)
    fence = {"build_id": owner.build, "host_epoch": owner.host_epoch}
    request = PluginCallEnvelope(**fence,session_id=session,plugin_id=plugin_id,call_id=call_id,name="hello",arguments={"name":"Bob"})
    result = PluginResult(content=[{"type":"text","text":"hi"}])
    await owner.db.call(lambda db: db.execute(
        "INSERT INTO plugin_calls(id,plugin,session,text,phase,result) VALUES(?,?,?,?,'done',?)",
        (call_id, plugin_id, session, request.intent_payload(),result.model_dump_json())), write=True)
    await owner.freeze(FreezeSupervisor(**fence, freeze_id="hold"))
    code = await owner.run_code(OpenCode(**fence, session_id=session, run_id=run_id, source="1+2"))
    assert code.phase == "success" and code.value == "3"
    plugin = await owner.call_plugin(request)
    assert plugin.phase == "done" and plugin.result == result
    with pytest.raises(BackendError, match="supervisor_frozen"):
        await owner.run_code(OpenCode(**fence, session_id=session, run_id="e" * 32, source="1"))
    with pytest.raises(BackendError, match="supervisor_frozen"):
        await owner.call_plugin(PluginCallEnvelope(
            **fence, session_id=session, plugin_id=plugin_id, call_id="f" * 32, name="hello", arguments={"name":"new"}))
    assert await owner.db.call(lambda db: db.execute("SELECT count(*) FROM code_runs").fetchone()[0]) == 1
    assert await owner.db.call(lambda db: db.execute("SELECT count(*) FROM plugin_calls").fetchone()[0]) == 1


async def test_frozen_validation_cannot_execute_tools_and_revision_is_checked(owner):
    freeze = FreezeSupervisor(build_id=owner.build, host_epoch=0, freeze_id="update")
    frozen = await owner.freeze(freeze)
    info, reservation = await worker(owner, purpose="validation")
    value = await call(owner, info)
    with pytest.raises(BackendError, match="validation_tools_forbidden"):
        await owner.run_tool(value)
    with pytest.raises(BackendError, match="registry_revision_mismatch"):
        await owner.thaw(freeze.model_copy(update={"expected_revision": frozen.registry_revision}))
    reservation.close()
    await owner.stop_worker(StopWorker(build_id=owner.build, host_epoch=0, session_id=info.session_id,
                                      worker_id=info.worker_id, execution_epoch=value.execution_epoch))
    health = await owner.health()
    assert not (await owner.thaw(freeze.model_copy(update={"expected_revision": health.registry_revision})) ).freeze_id


async def test_historical_lookup_by_replacement_never_replays(owner):
    info, reservation = await worker(owner)
    value = await call(owner, info)
    result = await owner.run_tool(value)
    reservation.close()
    await owner._retire_worker(info, "recovery")
    replacement, _ = await worker(owner)
    observation = await owner.lookup_tool(ToolLookup(**request(replacement).model_dump(), call_id=value.call_id))
    assert observation.result == result and observation.resource_clean
    assert len(await owner._workers()) == 2


async def test_source_build_stop_uses_recorded_worker_build(owner):
    info, reservation = await worker(owner, build="source-build")
    received = []
    async def peer(worker, method, path, body):
        received.append((path, body.build_id))
        if path == "/stop":
            reservation.close()
        return Identity(build_id=info.build_id, profile_id=owner.profile.config.profile_id,
                        instance_id=info.worker_id, pid=1, role="worker", host_epoch=owner.host_epoch,
                        fingerprint=info.build_id)
    owner._peer_identity = peer
    assert (await owner._retire_worker(info, "update")).state == "clean"
    assert received == [("/fence", "source-build"), ("/stop", "source-build")]


async def test_old_format_is_rejected_without_database_mutation(tmp_path):
    path = tmp_path / "execution.sqlite"
    db = sqlite3.connect(path)
    db.executescript("CREATE TABLE old(value); PRAGMA user_version=1;")
    db.close()
    before = path.read_bytes()
    owner = ExecutionDB(path)
    try:
        with pytest.raises(BackendError, match="unsupported_storage_format"):
            await owner.call(lambda db: db.execute("SELECT 1"))
        assert path.read_bytes() == before
        assert not path.with_name(path.name + "-wal").exists()
    finally:
        await owner.close()


async def test_sqlite_full_rolls_back_and_closes_admission(owner):
    def fill(db):
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        pages = db.execute("PRAGMA page_count").fetchone()[0]
        db.execute(f"PRAGMA max_page_count={pages}")
    await owner.db.call(fill)
    before = await owner.db.call(lambda db: db.execute("SELECT epoch FROM control").fetchone()[0])
    def failed(db):
        db.execute("UPDATE control SET epoch=99")
        db.execute("INSERT INTO recoveries VALUES('huge',?,'pending')", ("x" * 1000000,))
    with pytest.raises(BackendError) as error:
        await owner.db.call(failed, write=True)
    assert error.value.code == "execution_storage_blocked"
    assert await owner.db.call(lambda db: db.execute("SELECT epoch FROM control").fetchone()[0]) == before
    assert owner.identity().state == "blocked"


@pytest.mark.parametrize("contents", [None, b"", "version-zero"])
async def test_required_execution_store_is_never_recreated(tmp_path, contents):
    path = tmp_path / "execution.sqlite"
    if contents == "version-zero":
        connection = sqlite3.connect(path)
        connection.execute("PRAGMA user_version=0")
        connection.close()
    elif contents is not None:
        path.write_bytes(contents)
    before = path.read_bytes() if path.exists() else None
    db = ExecutionDB(path, require_existing=True)
    try:
        with pytest.raises(BackendError):
            await db.call(lambda connection: connection.execute("SELECT 1"))
        assert (path.read_bytes() if path.exists() else None) == before
    finally:
        await db.close()


async def test_storage_ack_is_monotonic_and_inherited_on_replacement(owner, monkeypatch):
    info, reservation = await worker(owner)
    await owner.heartbeat(request(info).model_copy(update={"storage_ready": True}))
    stale = info.model_copy(update={"state": "frozen"})
    await owner._save_worker(stale)
    assert (await owner._worker(info.worker_id)).storage_ready
    reservation.close()
    await owner._retire_worker(info, "recovery")
    child_fds = []
    async def spawn(*args, **kwargs):
        assert "--require-existing-store" in args
        child_fds.append(os.dup(kwargs["pass_fds"][0]))
        return SimpleNamespace(pid=99, returncode=None, wait=AsyncMock())
    monkeypatch.setattr("amazme_backend.supervisor.asyncio.create_subprocess_exec", spawn)
    try:
        await owner.ensure_worker(WorkerSpec(build_id=owner.build, host_epoch=0, session_id=info.session_id))
    finally:
        for fd in child_fds:
            os.close(fd)


async def test_initialized_execution_store_disappearance_closes_admission(owner):
    owner.db.path.unlink()
    with pytest.raises(BackendError):
        await owner.db.call(lambda db: db.execute("SELECT 1"))
    assert owner.db.failed and owner.identity().state == "blocked"


async def test_freeze_survives_restart_and_normal_shutdown_does_not_invent_update(owner):
    frozen = FreezeSupervisor(build_id=owner.build, host_epoch=0, freeze_id="update")
    await owner.freeze(frozen)
    await owner.shutdown(HostFence(build_id=owner.build, host_epoch=0))
    await owner.db.close()
    successor = Supervisor(owner.profile, "supervisor-two", require_existing=True)
    try:
        await successor.initialize()
        assert successor.freeze_id == "update"
        await successor.thaw(frozen)
        await successor.shutdown(HostFence(build_id=owner.build, host_epoch=0))
        saved = await successor.db.call(lambda db: db.execute("SELECT freeze FROM control").fetchone()[0])
        assert saved == ""
    finally:
        successor.monitor_task.cancel()
        await asyncio.gather(successor.monitor_task, return_exceptions=True)
        await successor.db.close()
        owner.db = ExecutionDB(owner.profile.path / "execution.sqlite")


async def test_readiness_cannot_hide_disconnected_registered_worker(owner):
    info, _ = await worker(owner)
    owner._peer_identity = no_peer
    health = await owner.health()
    assert health.workers[0].worker_id == info.worker_id
    assert health.workers[0].state == "unknown"
    assert health.session_errors[info.session_id] == ["worker_retirement_pending:" + info.worker_id]
    assert not health.blocked


async def test_validation_spawn_heartbeat_empty_epoch_and_stop_during_freeze(owner, monkeypatch):
    await owner.freeze(FreezeSupervisor(build_id=owner.build, host_epoch=0, freeze_id="update"))
    descriptors = []
    async def spawn(*args, **kwargs):
        assert "--validation" in args and "--frozen" in args
        descriptors.append(os.dup(kwargs["pass_fds"][0]))
        return SimpleNamespace(pid=123, returncode=None, wait=AsyncMock())
    monkeypatch.setattr("amazme_backend.supervisor.asyncio.create_subprocess_exec", spawn)
    try:
        spec = WorkerSpec(build_id=owner.build, host_epoch=0, session_id="a" * 32, purpose="validation")
        info = await owner.ensure_worker(spec)
        assert (await owner.heartbeat(request(info))).state == "frozen"
        lease = await owner.open_epoch(request(info))
        assert (await owner.cleanup(info.session_id, lease)).state == "clean"
        os.close(descriptors.pop())
        stopped = await owner.stop_worker(StopWorker(**spec.model_dump(), worker_id=info.worker_id,
                                                    execution_epoch=lease.execution_epoch))
        assert stopped.state == "clean"
        assert (await owner.health()).workers[0].state == "stopped"
    finally:
        for fd in descriptors:
            os.close(fd)


async def test_epoch_open_lost_ack_returns_original_lease(owner):
    info, _ = await worker(owner)
    async def lost_ack(point, **_):
        if point == "epoch_opened":
            raise RuntimeError("lost epoch ACK")
    owner.faults.hit = lost_ack
    with pytest.raises(RuntimeError):
        await owner.open_epoch(request(info))
    owner.faults.hit = AsyncMock()
    lease = await owner.open_epoch(request(info))
    assert lease.execution_epoch == 1
    assert len(await owner._unclean_epochs()) == 1
    await owner.check_lease(lease)


async def test_stop_zero_epoch_cannot_stop_new_generation(owner):
    info, _ = await worker(owner)
    lease = await owner.open_epoch(request(info))
    with pytest.raises(BackendError, match="stale_execution_epoch"):
        await owner.stop_worker(StopWorker(build_id=owner.build, host_epoch=0, session_id=info.session_id,
                                          worker_id=info.worker_id, execution_epoch=0))
    await owner.check_lease(lease)


async def test_ensure_inspects_every_instance_even_after_a_ready_one(owner):
    first, _ = await worker(owner)
    second, _ = await worker(owner)
    second.state = "unknown"
    await owner._save_worker(second)
    with pytest.raises(BackendError, match="worker_retirement_pending"):
        await owner.ensure_worker(WorkerSpec(build_id=owner.build, host_epoch=0, session_id=first.session_id))
    assert len(await owner._workers()) == 2


async def test_spawn_lost_pid_ack_keeps_inherited_lease_registered(owner, monkeypatch):
    child_fds = []
    async def spawn(*_args, **kwargs):
        child_fds.append(os.dup(kwargs["pass_fds"][0]))
        raise asyncio.CancelledError()
    monkeypatch.setattr("amazme_backend.supervisor.asyncio.create_subprocess_exec", spawn)
    spec = WorkerSpec(build_id=owner.build, host_epoch=0, session_id="a" * 32)
    try:
        with pytest.raises(asyncio.CancelledError):
            await owner.ensure_worker(spec)
        original = (await owner._workers())[0]
        assert original.pid == 0 and not exited(original.process_lease)
        assert (await owner.ensure_worker(spec)).worker_id == original.worker_id
        assert len(child_fds) == 1
    finally:
        for fd in child_fds:
            os.close(fd)


async def test_takeover_cannot_adopt_a_stopping_worker(owner):
    info, reservation = await worker(owner)
    info.state = "stopping"
    await owner._save_worker(info)
    paths = []
    async def peer(current, _method, path, body):
        paths.append(path)
        if path == "/stop":
            reservation.close()
        return Identity(build_id=owner.build, profile_id=owner.profile.config.profile_id,
                        instance_id=current.worker_id, pid=1, role="worker", host_epoch=body.host_epoch,
                        fingerprint=owner.build)
    owner._peer_identity = peer
    assert (await owner.takeover(HostFence(build_id=owner.build, host_epoch=8))).host_epoch == 8
    assert paths == ["/fence", "/stop"]
    assert (await owner._worker(info.worker_id)).state == "stopped"


async def test_thaw_ack_is_idempotent_with_historical_registry_and_restart(owner):
    info, reservation = await worker(owner, build="old-build")
    reservation.close()
    await owner._retire_worker(info, "update")
    freeze = FreezeSupervisor(build_id=owner.build, host_epoch=0, freeze_id="update")
    health = await owner.freeze(freeze)
    release = freeze.model_copy(update={"expected_revision": health.registry_revision})
    assert not (await owner.thaw(release)).freeze_id
    assert not (await owner.thaw(release)).freeze_id
    assert len((await owner.health()).workers) == 1
    await owner.db.close()
    successor = Supervisor(owner.profile, "supervisor-two")
    try:
        await successor.initialize()
        assert not (await successor.thaw(release)).freeze_id
        await successor.freeze(freeze.model_copy(update={"freeze_id": "new-update"}))
        with pytest.raises(BackendError, match="freeze_identity_mismatch"):
            await successor.thaw(release)
    finally:
        await successor.close()
        owner.db = ExecutionDB(owner.profile.path / "execution.sqlite", require_existing=True)


async def test_thaw_refuses_even_frozen_live_business_worker(owner):
    info, _ = await worker(owner)
    async def peer(*_args):
        return Identity(build_id=owner.build, profile_id=owner.profile.config.profile_id,
                        instance_id=info.worker_id, pid=1, role="worker", state="frozen", fingerprint=owner.build)
    owner._peer_identity = peer
    freeze = FreezeSupervisor(build_id=owner.build, host_epoch=0, freeze_id="update")
    await owner.freeze(freeze)
    with pytest.raises(BackendError, match="update_health_unproven"):
        await owner.thaw(freeze)


async def test_retire_requires_explicit_matching_freeze_and_source_build(owner):
    freeze = FreezeSupervisor(build_id=owner.build, host_epoch=0, freeze_id="update")
    await owner.freeze(freeze)
    retire = RetireSupervisor(build_id=owner.build, host_epoch=9, freeze_id="another-update")
    with pytest.raises(BackendError, match="freeze_identity_mismatch"):
        await owner.retire(retire)
    assert not owner.draining and owner.host_epoch == 0
    with pytest.raises(BackendError, match="retire_fence_mismatch"):
        await owner.retire(retire.model_copy(update={"build_id": "target-build", "freeze_id": "update"}))
    result = await owner.retire(retire.model_copy(update={"freeze_id": "update"}))
    assert result.freeze_id == "update" and result.identity.host_epoch == 9
    assert result.identity.state == "stopping"


async def test_retire_binds_auto_build_update_id_durably(owner):
    result = await owner.retire(RetireSupervisor(build_id=owner.build, host_epoch=1, freeze_id="auto-build"))
    assert result.freeze_id == "auto-build"
    assert await owner.db.call(lambda db: db.execute("SELECT freeze FROM control").fetchone()[0]) == "auto-build"


async def test_lost_worker_stop_ack_still_requires_lease_exit(owner):
    info, reservation = await worker(owner)
    async def peer(current, _method, path, body):
        if path == "/stop":
            reservation.close()
            raise httpx.ReadTimeout("stop accepted and ACK lost")
        return Identity(build_id=owner.build, profile_id=owner.profile.config.profile_id,
                        instance_id=current.worker_id, pid=1, role="worker", host_epoch=body.host_epoch,
                        fingerprint=owner.build)
    owner._peer_identity = peer
    stop = StopWorker(build_id=owner.build, host_epoch=0, session_id=info.session_id, worker_id=info.worker_id)
    result = await owner.stop_worker(stop)
    assert result.state == "clean" and exited(info.process_lease)
    assert await owner.stop_worker(stop) == result


async def test_lost_cleanup_ack_reuses_durable_proof(owner):
    info, _ = await worker(owner)
    lease = await owner.open_epoch(request(info))
    async def lost(here, **_):
        if here == "closed":
            raise RuntimeError("cleanup ACK lost")
    owner.faults.hit = lost
    with pytest.raises(RuntimeError):
        await owner.cleanup(info.session_id, lease)
    owner.faults.hit = AsyncMock()
    first = await owner.cleanup(info.session_id, lease)
    assert await owner.cleanup(info.session_id, lease) == first
    assert first.state == "clean" and first.proof_id


async def test_birth_reservations_count_toward_capacity(owner, monkeypatch):
    for i in range(8):
        info, _ = await worker(owner, f"{i:032x}")
        info.state = "starting"
        await owner._save_worker(info)
    spawn = AsyncMock()
    monkeypatch.setattr("amazme_backend.supervisor.asyncio.create_subprocess_exec", spawn)
    with pytest.raises(BackendError, match="worker_capacity"):
        await owner.ensure_worker(WorkerSpec(build_id=owner.build, host_epoch=0, session_id="f" * 32))
    spawn.assert_not_called()


async def test_full_health_remains_readable_after_write_storage_failure(owner):
    info, _ = await worker(owner)
    owner.db.failed = "SQLITE_FULL"
    owner._peer_identity = no_peer
    health = await owner.health()
    assert "SQLITE_FULL" in health.blocked
    assert health.workers[0].worker_id == info.worker_id and health.workers[0].state == "unknown"
    assert health.identity.state == "blocked"


async def test_takeover_ack_does_not_promote_recovering_worker_to_ready(owner):
    info, _ = await worker(owner)
    info.state = "starting"
    await owner._save_worker(info)
    async def peer(*_args):
        return Identity(build_id=owner.build, profile_id=owner.profile.config.profile_id,
                        instance_id=info.worker_id, pid=1, role="worker", state="recovering",
                        host_epoch=5, fingerprint=owner.build)
    owner._peer_identity = peer
    await owner.takeover(HostFence(build_id=owner.build, host_epoch=5))
    assert (await owner._worker(info.worker_id)).state == "starting"


async def test_full_health_keeps_mismatched_registered_peer_visible(owner):
    info, _ = await worker(owner)
    async def mismatch(*_args):
        raise BackendError("worker_identity_mismatch")
    owner._peer_identity = mismatch
    health = await owner.health()
    assert health.workers[0].worker_id == info.worker_id and health.workers[0].state == "unknown"
    assert health.session_errors[info.session_id] == ["worker_retirement_pending:" + info.worker_id]
    assert not health.blocked


async def test_validation_worker_cannot_resolve_business_effects(owner):
    info, reservation = await worker(owner)
    value = await call(owner, info)
    async def lost(point, **_):
        if point == "permitted":
            raise RuntimeError("outcome lost")
    owner.faults.hit = lost
    with pytest.raises(RuntimeError):
        await owner.run_tool(value)
    owner.faults.hit = AsyncMock()
    reservation.close()
    await owner._retire_worker(info, "update")
    validator, _ = await worker(owner, purpose="validation")
    resolution = EffectResolution(resolution_id="validation-resolution", call_id=value.call_id,
                                  outcome="applied", evidence="not authorized business work")
    with pytest.raises(BackendError, match="validation_effects_forbidden"):
        await owner.resolve_effect(ResolveEffect(**request(validator).model_dump(), resolution=resolution))
    assert not (await owner._holds())[0].reconciled


async def test_shutdown_releases_control_before_waiting_for_a_worker(owner, monkeypatch):
    info, reservation = await worker(owner)
    observed: list[bool] = []

    async def peer(worker_info, method, path, body):
        return Identity(build_id=owner.build, profile_id=owner.profile.config.profile_id,
                        instance_id=worker_info.worker_id, pid=info.pid, role="worker",
                        host_epoch=owner.host_epoch, fingerprint=owner.build)

    async def wait(lease, timeout=5):
        observed.append(owner.control.locked())
        if not reservation.stream.closed:
            owner.reservations.remove(reservation)
            reservation.close()

    monkeypatch.setattr(owner, "_peer_identity", peer)
    monkeypatch.setattr("amazme_backend.supervisor.wait_exited", wait)
    result = await owner.shutdown(HostFence(build_id=owner.build, host_epoch=owner.host_epoch))
    assert observed and observed[0] is False
    assert result.role == "supervisor" and result.state != "blocked"



@pytest.mark.parametrize("point", ["create_intent", "registered", "before_permit", "permit_sent", "permitted", "result", "cleanup_proven"])
async def test_native_fault_windows_preserve_call_identity_and_never_repeat(owner, point):
    info, _ = await worker(owner)
    value = await call(owner, info, identity="native-window")
    value.command = "printf x >> once.txt"
    once = owner.profile.path / "once.txt"

    async def fail(here, **_):
        if here == point:
            raise RuntimeError("injected " + point)

    owner.faults.hit = fail
    with pytest.raises(RuntimeError, match="injected"):
        await owner.run_tool(value)
    content = once.read_text() if once.exists() else ""
    if point in {"create_intent", "registered", "before_permit"}:
        assert content == ""
    assert content in {"", "x"}

    async def no_fault(*_, **__):
        return None

    owner.faults.hit = no_fault
    observed = await owner.lookup_tool(ToolLookup(**request(info).model_dump(), call_id=value.call_id))
    if observed.state == "completed":
        assert (await owner.run_tool(value)).stdout == observed.result.stdout
    else:
        with pytest.raises(BackendError, match="tool_outcome_unknown"):
            await owner.run_tool(value)
    proof = await owner.cleanup(info.session_id)
    assert proof.state == "clean" and proof.observation == "registered_processes"
    assert (once.read_text() if once.exists() else "") == content


async def test_native_unknown_effect_is_scoped_and_readonly_diagnostics_remain_available(owner):
    first, _ = await worker(owner)
    second, _ = await worker(owner, session="b" * 32)
    value = await call(owner, first, identity="first")

    async def fail(point, **_):
        if point == "registered":
            raise RuntimeError("lost permit reply")

    owner.faults.hit = fail
    with pytest.raises(RuntimeError):
        await owner.run_tool(value)

    async def no_fault(*_, **__):
        return None

    owner.faults.hit = no_fault
    await owner.cleanup(first.session_id)
    blocked = await call(owner, first, identity="blocked")
    with pytest.raises(BackendError, match="unknown_effect_conflict"):
        await owner.run_tool(blocked)
    other = await call(owner, second, identity="other")
    assert (await owner.run_tool(other)).stdout == "ok\n"
    diagnostic = await call(owner, first, identity="diagnostic", effect="read")
    assert (await owner.run_tool(diagnostic)).stdout == "ok\n"
    assert (await owner.lookup_tool(ToolLookup(**request(first).model_dump(), call_id="first"))).state == "unknown"
