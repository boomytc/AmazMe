"""Execution fault tests; no VM, Docker daemon, network listener, or credentials."""

import asyncio
import contextlib
import hashlib
import json
import os
import sqlite3
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from pydantic import ValidationError

from amazme_backend.common import Profile, lock, private_write
from amazme_backend.contracts import (
    BackendError,
    EffectResolution,
    FreezeSupervisor,
    HostFence,
    Identity,
    Lease,
    Recovery,
    ResolveEffect,
    RetireSupervisor,
    RunTool,
    StopWorker,
    ToolLookup,
    ToolResult,
    WorkerInfo,
    WorkerRequest,
    WorkerSpec,
)
from amazme_backend.docker_channel import GateChannel
from amazme_backend.processes import ProcessReservation, exited
from amazme_backend.supervisor import ExecutionDB, Supervisor, retirement_proof
from amazme_backend.vm import VM, Container, Machine, ResourceManifest, VMStopProof


class FakeVM:
    def __init__(self, profile):
        self.profile = profile
        self.vm_id, self.image_id = "vm-owned", "sha256:image"
        self.socket = profile.path / "fake-docker.sock"
        self.containers = {}
        self.stops = 0
        self.starts = 0
        self.fail_stop = False
        self.fail_clean = False
        self.boot = "boot-one"
        self.barrier = False
        self.on_clean = None
        self.created_binds = []
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(self.request), base_url="http://docker")

    def request(self, request):
        path = request.url.path
        if path == "/containers/create":
            spec = json.loads(request.content)
            cid = hashlib.sha256(request.url.params["name"].encode()).hexdigest()
            self.created_binds.append(spec["HostConfig"]["Binds"])
            item = Container.model_validate({"Id": cid, "Config": spec,
                "State": {"Running": False, "Pid": 0, "ExitCode": 0, "Status": "created"}})
            self.containers[cid] = item
            self.containers[request.url.params["name"]] = item
            return httpx.Response(201, json={"Id": cid})
        cid = path.split("/")[2]
        if path.endswith("/start"):
            self.containers[cid].State.Running = True
            self.containers[cid].State.Pid = 99
            return httpx.Response(204)
        if path.endswith("/wait"):
            self.containers[cid].State.Running = False
            return httpx.Response(200, json={"StatusCode": 0})
        raise AssertionError(path)

    async def start(self):
        self.starts += 1
        return self.boot

    async def guest(self, *args):
        assert args == ("cat", "/proc/sys/kernel/random/boot_id")
        return self.boot

    async def inspect(self, identity):
        return self.containers.get(identity)

    async def cgroup(self, container):
        return "/sys/fs/cgroup/" + container.Id

    async def kill_and_prove(self, cid, cgroup, boot):
        if self.on_clean:
            await self.on_clean()
        if self.fail_clean or boot != self.boot:
            raise BackendError("vm_boot_changed")
        if cid in self.containers:
            self.containers[cid].State.Running = False

    @contextlib.asynccontextmanager
    async def stopped(self):
        self.stops += 1
        if self.fail_stop:
            raise BackendError("vm_stop_unproven")
        self.barrier = True
        self.containers.clear()
        try:
            yield VMStopProof(vm_id=self.vm_id, receipt_id="stopped-proof", instance_dir="owned")
        finally:
            self.barrier = False

    async def close(self):
        await self.http.aclose()


class FakeChannel:
    def __init__(self):
        self.permits = []
        self.closed = False
        self.error = None
        self.wait = None
        self.collected = asyncio.Event()

    async def permit(self, command, uid, gid):
        self.permits.append(command)

    async def collect(self):
        self.collected.set()
        if self.wait:
            await self.wait.wait()
        if self.error:
            raise self.error
        return "captured", "", False

    async def close(self):
        self.closed = True


@pytest.fixture
def profile(tmp_path, monkeypatch):
    private_write(tmp_path / "config.json", json.dumps({"format": 2, "profile_id": "p2-test",
        "workspace": str(tmp_path), "resources": "unused", "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "test-token")
    monkeypatch.setattr("amazme_backend.supervisor.build_id", lambda: "build-one")
    monkeypatch.setattr("amazme_backend.supervisor.VM", FakeVM)
    return Profile(tmp_path)


@pytest_asyncio.fixture
async def owner(profile, monkeypatch):
    owner = Supervisor(profile, "supervisor-one")
    await owner.initialize()
    owner.monitor_task.cancel()
    await asyncio.gather(owner.monitor_task, return_exceptions=True)
    owner.reservations = []
    owner.fake_channels = []

    async def attach(*_):
        channel = FakeChannel()
        owner.fake_channels.append(channel)
        return channel
    monkeypatch.setattr("amazme_backend.supervisor.GateChannel.attach", attach)
    try:
        yield owner
    finally:
        await owner._cancel_jobs()
        for reservation in owner.reservations:
            reservation.close()
        await owner.vm.close()
        await owner.db.close()


async def worker(owner, session="a" * 32, purpose="business", build=None):
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


async def test_result_is_durable_before_cleanup_and_duplicate_never_replays(owner):
    info, _ = await worker(owner)
    value = await call(owner, info)

    async def check_capture():
        stored = await owner._scope(value.call_id)
        assert stored["outcome"] == "completed"
        assert ToolResult.model_validate_json(stored["result"]).stdout == "captured"
        assert not stored["clean"]
    owner.vm.on_clean = check_capture
    result = await owner.run_tool(value)
    assert result.stdout == "captured"
    assert (await owner._scope(value.call_id))["clean"]
    assert await owner.run_tool(value) == result
    assert len(owner.fake_channels) == 1
    assert owner.fake_channels[0].closed


async def test_unknown_write_blocks_mutation_but_read_mount_is_enforced(owner):
    info, _ = await worker(owner)
    value = await call(owner, info)
    async def crash(point, **_):
        if point == "permitted":
            raise RuntimeError("lost outcome")
    owner.faults.hit = crash
    with pytest.raises(RuntimeError):
        await owner.run_tool(value)
    owner.faults.hit = AsyncMock()
    clean = await owner.cleanup(info.session_id, Lease(**value.model_dump(include=Lease.model_fields.keys())))
    assert clean.state == "clean"
    next_value = await call(owner, info, "write-two")
    with pytest.raises(BackendError, match="unknown_effect_conflict"):
        await owner.run_tool(next_value)
    diagnostic = next_value.model_copy(update={"call_id": "diagnostic", "effect": "read"})
    assert (await owner.run_tool(diagnostic)).stdout == "captured"
    assert owner.vm.created_binds[-1] == ["/workspace:/workspace:ro"]
    holds = await owner._holds()
    assert len(holds) == 1 and holds[0].resource_clean and not holds[0].reconciled
    resolution = ResolveEffect(**request(info).model_dump(), resolution=EffectResolution(
        resolution_id="resolve", call_id=value.call_id, outcome="applied", evidence="inspected workspace content"))
    assert (await owner.resolve_effect(resolution)).reconciled
    assert await owner.resolve_effect(resolution) == await owner.resolve_effect(resolution)
    assert (await owner.lookup_tool(ToolLookup(**request(info).model_dump(), call_id=value.call_id))).state == "unknown"
    assert (await owner.run_tool(next_value)).stdout == "captured"


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


@pytest.mark.parametrize("point", ["create_intent", "create_accepted", "created", "registered", "start_accepted",
                                  "started", "before_permit", "permit_sent", "permitted", "result", "cleanup_proven"])
async def test_every_fault_window_preserves_scope_and_never_reexecutes(owner, point):
    info, _ = await worker(owner)
    value = await call(owner, info)
    async def crash(here, **_):
        if here == point:
            raise RuntimeError("fault")
    owner.faults.hit = crash
    with pytest.raises(RuntimeError):
        await owner.run_tool(value)
    stored = await owner._scope(value.call_id)
    assert stored["outcome"] == ("completed" if point in {"result", "cleanup_proven"} else "unknown")
    owner.faults.hit = AsyncMock()
    lease = Lease(**value.model_dump(include=Lease.model_fields.keys()))
    cleanup = await owner.cleanup(info.session_id, lease)
    assert cleanup.state == "clean" and cleanup.proof_id
    count = len(owner.fake_channels)
    with pytest.raises(BackendError, match="execution_epoch_closed"):
        await owner.run_tool(value)
    assert len(owner.fake_channels) == count
    assert (await owner.lookup_tool(ToolLookup(**request(info).model_dump(), call_id=value.call_id))).resource_clean


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


async def test_scoped_cleanup_keeps_sibling_execution(owner):
    one, _ = await worker(owner)
    two, _ = await worker(owner, "b" * 32)
    first, second = await call(owner, one), await call(owner, two, "second")
    await owner.run_tool(first)
    await owner.run_tool(second)
    await owner.cleanup(one.session_id)
    await owner.check_lease(second)
    assert owner.vm.stops == 0


async def test_boot_change_never_counts_as_clean_without_vm_stop(owner):
    info, _ = await worker(owner)
    value = await call(owner, info)
    async def crash(point, **_):
        if point == "permitted":
            raise RuntimeError()
    owner.faults.hit = crash
    with pytest.raises(RuntimeError):
        await owner.run_tool(value)
    owner.vm.boot = "different-boot"
    owner.vm.fail_stop = True
    receipt = await owner.cleanup(info.session_id)
    assert receipt.state == "blocked" and receipt.reason == "vm_stop_unproven"
    assert not (await owner._scope(value.call_id))["clean"]
    owner.vm.fail_stop = False
    receipt = await owner.cleanup(info.session_id)
    assert receipt.state == "clean" and receipt.proof_id == "stopped-proof"


async def test_supervisor_recovery_stops_vm_and_seals_inside_barrier(owner, monkeypatch):
    info, reservation = await worker(owner)
    value = await call(owner, info)
    async def crash(point, **_):
        if point == "create_intent":
            raise RuntimeError()
    owner.faults.hit = crash
    with pytest.raises(RuntimeError):
        await owner.run_tool(value)
    reservation.close()
    await owner.db.close()
    next_owner = Supervisor(owner.profile, "supervisor-two")
    original_call = next_owner.db.call
    observed = []
    async def checked(operation, *, write=False):
        if write and next_owner.vm.barrier:
            observed.append(True)
        return await original_call(operation, write=write)
    next_owner.db.call = checked
    try:
        await next_owner.initialize()
        assert next_owner.vm.stops == 1 and observed
        assert (await next_owner._scope(value.call_id))["clean"]
        assert (await next_owner._worker(info.worker_id)).state == "stopped"
        assert (await next_owner._holds())[0].reason == "tool_outcome_unknown"
    finally:
        next_owner.monitor_task.cancel()
        await asyncio.gather(next_owner.monitor_task, return_exceptions=True)
        await next_owner.vm.close()
        await next_owner.db.close()
        owner.db = ExecutionDB(owner.profile.path / "execution.sqlite")


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


async def test_budget_persists_and_recovery_cannot_reset_until_proven(owner):
    for _ in range(4):
        info, reservation = await worker(owner)
        reservation.close()
        await owner._retire_worker(info, "recovery", failed=True)
    with pytest.raises(BackendError, match="worker_restart_budget_exhausted"):
        await owner.ensure_worker(WorkerSpec(build_id=owner.build, host_epoch=0, session_id=info.session_id))
    owner.vm.fail_stop = True
    recovery = Recovery(build_id=owner.build, host_epoch=0, recovery_id="repair")
    with pytest.raises(BackendError, match="vm_stop_unproven"):
        await owner.recover(recovery)
    assert (await owner.db.call(lambda db: db.execute("SELECT attempts FROM budgets").fetchone()))[0] == 4
    owner.vm.fail_stop = False
    await owner.recover(recovery)
    assert (await owner.db.call(lambda db: db.execute("SELECT attempts FROM budgets").fetchone()))[0] == 0


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


class Writer:
    def __init__(self):
        self.data = bytearray()
        self.closed = False
    def write(self, data):
        self.data.extend(data)
    async def drain(self):
        pass
    def close(self):
        self.closed = True
    async def wait_closed(self):
        pass


def frame(kind, data):
    return bytes([kind, 0, 0, 0]) + len(data).to_bytes(4, "big") + data


async def test_raw_hijack_demultiplexes_bounded_output_and_single_permit(monkeypatch, tmp_path):
    reader, writer = asyncio.StreamReader(), Writer()
    reader.feed_data(b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
    reader.feed_data(frame(1, b"x" * 70000) + frame(2, b"error"))
    reader.feed_eof()
    monkeypatch.setattr(asyncio, "open_unix_connection", AsyncMock(return_value=(reader, writer)))
    channel = await GateChannel.attach(tmp_path / "unused.sock", "a" * 64)
    await channel.permit("true", 501, 20)
    with pytest.raises(BackendError, match="permit_already_sent"):
        await channel.permit("false", 501, 20)
    out, err, truncated = await channel.collect()
    assert len(out) == 65536 and err == "error" and truncated
    await channel.close()
    assert writer.closed and b"/attach?stream=1" in writer.data


async def test_partial_docker_frame_is_unknown():
    reader, writer = asyncio.StreamReader(), Writer()
    reader.feed_data(b"\x01\x00")
    reader.feed_eof()
    with pytest.raises(BackendError, match="docker_truncated_frame"):
        await GateChannel(reader, writer).collect()


async def test_vm_stop_retains_operation_lock_through_caller_commit(tmp_path):
    vm = object.__new__(VM)
    vm.home, vm.name, vm.vm_id = tmp_path, "execution", "owned"
    vm.lima = tmp_path / "limactl"
    vm.machine = AsyncMock(return_value=Machine(name="execution", status="Stopped", dir=str(tmp_path / "execution")))
    vm.command = AsyncMock()
    async with vm.stopped() as proof:
        assert proof.vm_id == "owned"
        with pytest.raises(BlockingIOError):
            with lock(tmp_path / "operation.lock"):
                pass
    with lock(tmp_path / "operation.lock"):
        pass
    vm.command.assert_not_called()


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
        await successor.vm.close()
        await successor.db.close()
        owner.db = ExecutionDB(owner.profile.path / "execution.sqlite")


async def test_readiness_cannot_hide_disconnected_registered_worker(owner):
    info, _ = await worker(owner)
    owner._peer_identity = no_peer
    health = await owner.health()
    assert health.workers[0].worker_id == info.worker_id
    assert health.workers[0].state == "unknown"
    assert health.blocked == ["worker_retirement_pending:" + info.worker_id]


async def test_known_result_with_failed_cleanup_keeps_mutation_barrier(owner):
    info, _ = await worker(owner)
    value = await call(owner, info)
    owner.vm.fail_clean = True
    with pytest.raises(BackendError):
        await owner.run_tool(value)
    assert (await owner._scope(value.call_id))["outcome"] == "completed"
    other, _ = await worker(owner, "b" * 32)
    second = await call(owner, other, "second")
    with pytest.raises(BackendError, match="unknown_effect_conflict"):
        await owner.run_tool(second)
    owner.vm.fail_clean = False
    assert (await owner.cleanup(info.session_id)).state == "clean"
    assert (await owner.run_tool(second)).stdout == "captured"


async def test_cancelled_epoch_cannot_late_release_next_generation(owner, monkeypatch):
    info, _ = await worker(owner)
    value = await call(owner, info)
    channel = FakeChannel()
    channel.wait = asyncio.Event()
    monkeypatch.setattr("amazme_backend.supervisor.GateChannel.attach", AsyncMock(return_value=channel))
    task = asyncio.create_task(owner.run_tool(value))
    await channel.collected.wait()
    assert (await owner.cleanup(info.session_id)).state == "clean"
    with pytest.raises(asyncio.CancelledError):
        await task
    successor = await owner.open_epoch(request(info))
    channel.wait.set()
    assert (await owner._scope(value.call_id))["outcome"] == "unknown"
    await owner.check_lease(successor)
    assert await owner._write_conflict()


async def test_lost_create_and_start_replies_force_owned_vm_reconciliation(owner, monkeypatch):
    info, _ = await worker(owner)
    value = await call(owner, info)
    real_request = owner.vm.request
    def lost(request):
        response = real_request(request)
        if request.url.path.endswith("/start"):
            raise httpx.ReadTimeout("accepted start, lost response")
        return response
    await owner.vm.http.aclose()
    owner.vm.http = httpx.AsyncClient(transport=httpx.MockTransport(lost), base_url="http://docker")
    with pytest.raises(httpx.ReadTimeout):
        await owner.run_tool(value)
    assert (await owner._scope(value.call_id))["phase"] == "starting"
    assert not owner.fake_channels[0].permits
    assert (await owner.cleanup(info.session_id)).proof_id == "stopped-proof"
    assert owner.vm.stops == 1


async def test_resource_fingerprint_change_stops_then_recreates_owned_vm(tmp_path):
    vm = object.__new__(VM)
    vm.home, vm.name, vm.vm_id = tmp_path, "execution", "owned"
    vm.resources = tmp_path
    vm.socket = tmp_path / "docker.sock"
    vm.lima, vm.docker = tmp_path / "limactl", tmp_path / "docker"
    vm.profile = SimpleNamespace(config=SimpleNamespace(workspace=str(tmp_path / "workspace")))
    vm.resource_fingerprint, vm.image_id = "new-runtime", "sha256:image"
    vm.manifest = SimpleNamespace(files={"base.img.gz": "digest"})
    vm.verify_resources = AsyncMock()
    vm.guest = AsyncMock(return_value="new-boot")
    private_write(tmp_path / "resource-stamp.json", json.dumps({"fingerprint": "old-runtime", "vm_id": "owned"}))
    current = Machine(name="execution", status="Running", dir=str(tmp_path / "execution"), hostAgentPID=1)
    vm.machine = AsyncMock(side_effect=[current, current,
        Machine(name="execution", status="Stopped", dir=str(tmp_path / "execution")), None])
    commands = []
    async def command(args, **kwargs):
        commands.append(args[1])
        assert kwargs["operation"].fileno() >= 0
        with pytest.raises(BlockingIOError):
            with lock(tmp_path / "operation.lock"):
                pass
        return ""
    vm.command = command
    vm.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={})),
                                base_url="http://docker")
    try:
        assert await vm.start() == "new-boot"
        assert commands == ["stop", "delete", "start"]
        assert json.loads((tmp_path / "resource-stamp.json").read_text())["fingerprint"] == "new-runtime"
    finally:
        await vm.http.aclose()


async def test_vm_operation_inode_replacement_is_not_adopted(tmp_path):
    vm = object.__new__(VM)
    vm.home, vm.vm_id = tmp_path, "owned"
    async with vm.operation():
        pass
    (tmp_path / "operation.lock").rename(tmp_path / "old.lock")
    with pytest.raises(BackendError, match="vm_operation_lease_replaced"):
        async with vm.operation():
            pytest.fail("replaced operation lock accepted")


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


async def test_database_marker_precedes_vm_initialization_and_first_ack(profile, monkeypatch):
    instances = []
    def vm(profile):
        assert (profile.path / "execution.initialized").read_text() == "2"
        instance = FakeVM(profile)
        instances.append(instance)
        return instance
    monkeypatch.setattr("amazme_backend.supervisor.VM", vm)
    first = Supervisor(profile, "first")
    await first.initialize()
    await first.close()
    (profile.path / "execution.sqlite").unlink()
    second = Supervisor(profile, "second")
    try:
        with pytest.raises(BackendError, match="execution_store_missing"):
            await second.initialize()
        assert not (profile.path / "execution.sqlite").exists()
        assert len(instances) == 1
    finally:
        await second.close()


async def test_storage_ready_heartbeat_racing_epoch_open_is_monotonic(owner):
    info, _ = await worker(owner)
    async def start():
        await owner.heartbeat(request(info).model_copy(update={"storage_ready": True}))
        owner.boot = "boot-one"
    owner._start_vm = start
    await owner.open_epoch(request(info))
    assert (await owner._worker(info.worker_id)).storage_ready


async def test_wrong_vm_stop_proof_cannot_clean_historical_resources(owner):
    info, _ = await worker(owner)
    value = await call(owner, info)
    async def crash(point, **_):
        if point == "create_intent":
            raise RuntimeError()
    owner.faults.hit = crash
    with pytest.raises(RuntimeError):
        await owner.run_tool(value)
    owner.faults.hit = AsyncMock()
    @contextlib.asynccontextmanager
    async def wrong_proof():
        yield VMStopProof(vm_id="unrelated-vm", receipt_id="false", instance_dir="unrelated")
    owner.vm.stopped = wrong_proof
    result = await owner.cleanup(info.session_id)
    assert result.state == "blocked" and result.reason == "vm_proof_identity_mismatch"
    assert not (await owner._scope(value.call_id))["clean"]


async def test_vm_owner_loss_cannot_replace_original_locator(tmp_path, monkeypatch):
    short_home = tempfile.TemporaryDirectory(prefix="am", dir="/tmp")
    home, resources, profile_dir = Path(short_home.name), tmp_path / "resources", tmp_path / "profile"
    resources.mkdir()
    profile_dir.mkdir()
    (resources / "manifest.json").write_text(json.dumps({"format": 1, "lima_version": "test",
        "lima_lease_protocol": "amazme-mutation-startup/1",
        "container_image": "python@sha256:test", "files": {}}))
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setattr("amazme_backend.vm.resource_root", lambda: resources)
    profile = SimpleNamespace(path=profile_dir, config=SimpleNamespace(profile_id="profile"))
    first = VM(profile)
    try:
        locator = (profile_dir / "vm.json").read_bytes()
        (first.home / "owner.json").unlink()
        with pytest.raises(BackendError, match="vm_owner_missing"):
            VM(profile)
        assert (profile_dir / "vm.json").read_bytes() == locator
    finally:
        await first.close()
        short_home.cleanup()


async def test_channel_rejects_oversized_permit_before_writing():
    reader, writer = asyncio.StreamReader(), Writer()
    channel = GateChannel(reader, writer)
    with pytest.raises(BackendError, match="permit_too_large"):
        await channel.permit("界" * 65536, 501, 20)
    assert not writer.data and not channel.sent


@pytest.mark.parametrize("payload", [b"{}\n", b"[]\n", b"x" * 262145,
    b'{"command":"true","uid":501,"gid":20}\nextra',
    b'{"command":"true","uid":true,"gid":20}\n'])
def test_gate_rejects_invalid_permit_before_fork(payload, monkeypatch):
    from amazme_backend import gate
    chunks = [payload, b""]
    monkeypatch.setattr(gate.os, "read", lambda *_: chunks.pop(0))
    monkeypatch.setattr(gate.os, "fork", lambda: pytest.fail("invalid permit forked"))
    assert gate.main() == 125


@pytest.mark.parametrize("point", ["create_intent", "create_accepted", "created", "registered", "start_accepted",
                                  "started", "before_permit", "permit_sent", "permitted", "result", "cleanup_proven"])
async def test_double_death_recovers_every_persisted_window(owner, point):
    info, reservation = await worker(owner)
    value = await call(owner, info)
    async def crash(here, **_):
        if here == point:
            raise RuntimeError("lost ACK")
    owner.faults.hit = crash
    with pytest.raises(RuntimeError):
        await owner.run_tool(value)
    reservation.close()
    await owner.db.close()
    successor = Supervisor(owner.profile, "supervisor-two")
    try:
        await successor.initialize()
        stored = await successor._scope(value.call_id)
        assert stored["clean"]
        assert stored["outcome"] == ("completed" if point in {"result", "cleanup_proven"} else "unknown")
        if stored["result"]:
            assert ToolResult.model_validate_json(stored["result"]).stdout == "captured"
        health = await successor.health()
        assert health.workers[0].state == "stopped"
        assert all(e.state == "clean" and e.cleanup.proof_id for e in health.epochs)
        assert successor.vm.stops == 1 and successor.vm.starts == 0
        assert not successor.vm.containers
    finally:
        await successor.close()
        owner.db = ExecutionDB(owner.profile.path / "execution.sqlite", require_existing=True)


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


async def test_vm_stop_lost_ack_is_not_proof_until_retry(tmp_path):
    vm = object.__new__(VM)
    vm.home, vm.name, vm.vm_id = tmp_path, "execution", "owned"
    vm.lima = tmp_path / "limactl"
    current = Machine(name="execution", status="Running", dir=str(tmp_path / "execution"), hostAgentPID=1)
    async def machine():
        return current
    vm.machine = machine
    async def stop_command(*_args, **_kwargs):
        current.status, current.hostAgentPID = "Stopped", 0
        raise TimeoutError("stop reply lost")
    vm.command = stop_command
    with pytest.raises(TimeoutError):
        await vm.stop()
    assert not (tmp_path / "last-stop.json").exists()
    assert (await vm.stop()).vm_id == "owned"
    assert (tmp_path / "last-stop.json").exists()


async def test_lima_absent_vm_first_start_and_delete_use_unfiltered_inventory(tmp_path):
    vm = object.__new__(VM)
    vm.home, vm.name, vm.vm_id = tmp_path, "execution", "owned"
    vm.resources, vm.socket = tmp_path, tmp_path / "docker.sock"
    vm.lima, vm.docker = tmp_path / "limactl", tmp_path / "docker"
    vm.profile = SimpleNamespace(config=SimpleNamespace(workspace=str(tmp_path / "workspace")))
    vm.resource_fingerprint, vm.image_id = "runtime", "sha256:image"
    vm.manifest = SimpleNamespace(files={"base.img.gz": "digest"})
    vm.verify_resources = AsyncMock()
    vm.guest = AsyncMock(return_value="boot")
    commands = []
    async def command(args, **_kwargs):
        commands.append(args[1:])
        if args[1:] == ["list", "--json"]:
            return ""
        if args[1:2] == ["list"] or args[1:2] == ["delete"]:
            raise BackendError("vm_command_failed", "No instance matching execution found. unmatched instances", 503)
        assert args[1] == "start"
        return ""
    vm.command = command
    vm.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={})),
                                base_url="http://docker")
    try:
        assert await vm.start() == "boot"
        assert any(args[0] == "start" for args in commands)
        assert (await vm.stop()).state == "Absent"
        assert (await vm.delete()).state == "Absent"
        assert (await vm.delete()).state == "Absent"
        assert not any(args[0] == "delete" for args in commands)
    finally:
        await vm.close()


@pytest.mark.parametrize("scenario", ["exact", "absent", "wrong-dir", "duplicate", "command-error"])
async def test_lima_json_lines_match_only_exact_owned_instance(tmp_path, scenario):
    vm = object.__new__(VM)
    vm.home, vm.name, vm.lima = tmp_path, "execution", tmp_path / "limactl"
    exact = Machine(name="execution", status="Stopped", dir=str(tmp_path / "execution"))
    nearby = exact.model_copy(update={"name": "execution-old", "dir": str(tmp_path / "execution-old")})
    entries = [nearby, exact]
    if scenario == "absent":
        entries = [nearby]
    elif scenario == "wrong-dir":
        entries = [exact.model_copy(update={"dir": str(tmp_path / "unrelated")})]
    elif scenario == "duplicate":
        entries.append(exact)
    async def command(args, **_kwargs):
        assert args == [str(vm.lima), "list", "--json"]
        if scenario == "command-error":
            raise BackendError("vm_command_failed", "unmatched instances", 503)
        return "\n".join(entry.model_dump_json() for entry in entries) + "\n"
    vm.command = command
    if scenario == "command-error":
        with pytest.raises(BackendError, match="unmatched instances"):
            await vm.machine()
    elif scenario in {"wrong-dir", "duplicate"}:
        with pytest.raises(BackendError, match="vm_identity_mismatch"):
            await vm.machine()
    else:
        assert await vm.machine() == (exact if scenario == "exact" else None)


async def test_boot_change_blocks_new_permits_before_any_user_effect(owner):
    info, _ = await worker(owner)
    value = await call(owner, info)
    owner.vm.boot = "different-boot"
    with pytest.raises(BackendError, match="vm_boot_changed"):
        await owner.run_tool(value)
    assert not owner.vm.containers and not owner.fake_channels
    assert owner.identity().state == "blocked"
    owner.vm.fail_stop = True
    assert (await owner.cleanup(info.session_id)).state == "clean"  # Empty epoch has no runtime requests.
    with pytest.raises(BackendError) as error:
        await owner.open_epoch(request(info))
    assert error.value.code == "execution_blocked"


async def test_boot_change_between_registration_and_permit_never_releases_gate(owner):
    info, _ = await worker(owner)
    value = await call(owner, info)
    async def reboot(point, **_):
        if point == "before_permit":
            owner.vm.boot = "different-boot"
    owner.faults.hit = reboot
    with pytest.raises(BackendError, match="vm_boot_changed"):
        await owner.run_tool(value)
    assert not owner.fake_channels[0].permits


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
    assert health.blocked == ["worker_retirement_pending:" + info.worker_id]


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


@pytest.fixture
def protocol_vm(tmp_path, monkeypatch):
    vm = object.__new__(VM)
    vm.home, vm.name, vm.vm_id = tmp_path, "execution", "owned"
    vm.resources = tmp_path / "resources"
    vm.lima = vm.resources / "lima/bin/limactl"
    vm.lima.parent.mkdir(parents=True)
    vm.lima.write_bytes(b"pinned-test-lima")
    vm.manifest = ResourceManifest(format=1, lima_version="2.2.1", container_image="python@sha256:test",
        lima_lease_protocol="amazme-mutation-startup/1",
        files={"lima/bin/limactl": hashlib.sha256(vm.lima.read_bytes()).hexdigest()})
    vm._lease_protocol_verified = False
    vm.profile = SimpleNamespace(path=tmp_path)
    vm.env = {"LIMA_HOME": str(tmp_path), "AMAZME_MUTATION_LEASE_FD": "9999",
              "AMAZME_STARTUP_LEASE_FD": "8888", "AMAZME_LEASE_PROTOCOL_PROBE": "1"}
    calls = []
    vm.probe_output = b"amazme-mutation-startup/1\n"
    vm.probe_exit = 0
    async def spawn(*args, **kwargs):
        calls.append((args, kwargs))
        probe = kwargs["env"].get("AMAZME_LEASE_PROTOCOL_PROBE") == "1"
        if not probe and kwargs["pass_fds"]:
            assert kwargs["env"]["AMAZME_MUTATION_LEASE_FD"] == str(kwargs["pass_fds"][0])
            with pytest.raises(BlockingIOError):
                with lock(tmp_path / "operation.lock"):
                    pass
        return SimpleNamespace(returncode=vm.probe_exit if probe else 0,
                               communicate=AsyncMock(return_value=(vm.probe_output if probe else b"ok\n",
                                                                   b"unpatched" if vm.probe_exit else b"")))
    monkeypatch.setattr("amazme_backend.vm.asyncio.create_subprocess_exec", spawn)
    return vm, calls


@pytest.mark.parametrize("protocol", [None, "amazme-fd-cloexec/1", "amazme-mutation-startup/2"])
def test_manifest_requires_exact_startup_lease_protocol(protocol):
    data = {"format": 1, "lima_version": "2.2.1", "container_image": "python@sha256:test", "files": {}}
    if protocol is not None:
        data["lima_lease_protocol"] = protocol
    with pytest.raises(ValidationError):
        ResourceManifest.model_validate(data)


async def test_vm_command_scrubs_ambient_protocol_and_only_passes_owned_lease(protocol_vm):
    vm, calls = protocol_vm
    original_env = dict(vm.env)
    assert await vm.command([str(vm.lima), "list", "--json"]) == "ok"
    _, read = calls.pop()
    assert not read["pass_fds"]
    assert read["env"] == {"LIMA_HOME": str(vm.home)}
    assert await vm.command([str(vm.lima), "stop", "--tty=false", vm.name]) == "ok"
    (_, probe), (_, mutation) = calls
    assert probe["env"] == {"LIMA_HOME": str(vm.home), "AMAZME_LEASE_PROTOCOL_PROBE": "1"}
    assert probe["pass_fds"] == ()
    assert mutation["env"] == {"LIMA_HOME": str(vm.home),
                               "AMAZME_MUTATION_LEASE_FD": str(mutation["pass_fds"][0])}
    assert vm._lease_protocol_verified and vm.env == original_env
    with lock(vm.home / "operation.lock"):
        pass


@pytest.mark.parametrize("reply", [b"", b"limactl version 2.2.1\n", b"amazme-fd-cloexec/1\n",
                                    b"amazme-mutation-startup/1\nextra\n"])
async def test_unpatched_or_wrong_protocol_never_reaches_mutator(protocol_vm, reply):
    vm, calls = protocol_vm
    vm.probe_output = reply
    with pytest.raises(BackendError, match="lima_lease_protocol_mismatch"):
        await vm.command([str(vm.lima), "stop", "--tty=false", vm.name])
    assert len(calls) == 1 and calls[0][0] == (str(vm.lima), "--version")
    assert not vm._lease_protocol_verified


async def test_protocol_probe_exit_error_is_not_accepted(protocol_vm):
    vm, calls = protocol_vm
    vm.probe_exit = 1
    with pytest.raises(BackendError) as error:
        await vm.command([str(vm.lima), "delete", "--force", vm.name])
    assert error.value.code == "vm_command_failed"
    assert len(calls) == 1 and not vm._lease_protocol_verified


async def test_protocol_probe_runs_only_after_digest_verification(protocol_vm):
    vm, calls = protocol_vm
    vm.lima.write_bytes(b"replaced-binary")
    with pytest.raises(BackendError) as error:
        await vm.command([str(vm.lima), "start", vm.name])
    assert error.value.code == "runtime_resource_mismatch"
    assert calls == [] and not vm._lease_protocol_verified


@pytest.fixture
def vm_path_profile(tmp_path, monkeypatch):
    resources, profile_dir = tmp_path / "resources", tmp_path / "profile"
    resources.mkdir()
    profile_dir.mkdir()
    (resources / "manifest.json").write_text(json.dumps({"format": 1, "lima_version": "2.2.1",
        "lima_lease_protocol": "amazme-mutation-startup/1",
        "container_image": "python@sha256:test", "files": {}}))
    monkeypatch.setattr("amazme_backend.vm.resource_root", lambda: resources)
    return SimpleNamespace(path=profile_dir, config=SimpleNamespace(profile_id="path-budget"))


async def test_vm_persistent_home_uses_short_owned_profile_directory(vm_path_profile, monkeypatch):
    with tempfile.TemporaryDirectory(prefix="am2-", dir="/private/tmp") as root:
        home = Path(root) / "h"
        home.mkdir()
        monkeypatch.setattr(Path, "home", lambda: home)
        vm = VM(vm_path_profile)
        try:
            expected = home / ".amazme-vm" / hashlib.sha256(str(vm_path_profile.path).encode()).hexdigest()[:24]
            assert vm.home == expected
            assert json.loads((vm_path_profile.path / "vm.json").read_text())["home"] == str(expected)
            assert json.loads((expected / "owner.json").read_text())["profile_id"] == "path-budget"
            assert len(os.fsencode(expected / "execution/ssh.sock.1234567890123456")) < 104
        finally:
            await vm.close()


@pytest.mark.parametrize("total,unicode_home", [(103, False), (104, False), (111, False), (104, True)])
async def test_vm_checks_longest_ssh_socket_byte_budget_before_writes(vm_path_profile, monkeypatch,
                                                                     total, unicode_home):
    with tempfile.TemporaryDirectory(prefix="am", dir="/tmp") as root:
        tail = Path(".amazme-vm") / ("a" * 24) / "execution/ssh.sock.1234567890123456"
        home_bytes = total - len(os.fsencode(tail)) - 1
        leaf_bytes = home_bytes - len(os.fsencode(root)) - 1
        leaf = "界" + "h" * (leaf_bytes - 3) if unicode_home else "h" * leaf_bytes
        home = Path(root) / leaf
        home.mkdir()
        monkeypatch.setattr(Path, "home", lambda: home)
        if total < 104:
            vm = VM(vm_path_profile)
            try:
                assert len(os.fsencode(vm.home / "execution/ssh.sock.1234567890123456")) == total
            finally:
                await vm.close()
        else:
            with pytest.raises(BackendError) as error:
                VM(vm_path_profile)
            assert error.value.code == "vm_socket_path_too_long"
            assert "ssh.sock.1234567890123456" in error.value.message
            assert f"{total} bytes" in error.value.message and "< 104" in error.value.message
            assert not (home / ".amazme-vm").exists()
            assert not (vm_path_profile.path / "vm.json").exists()
