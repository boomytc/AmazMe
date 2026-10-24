"""A model file write is prepared durably before the local file process can replace bytes."""

import hashlib
import json
import os
import shutil
from unittest.mock import AsyncMock

import httpx
import pytest
from native_file_fixture import run_file

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import (
    BackendError,
    EpochHealth,
    HostFence,
    HostReady,
    Identity,
    Lease,
    PrepareFileWrite,
    SupervisorHealth,
    ToolCall,
    WorkerInfo,
    WorkspaceGrantRequest,
    WriteFile,
)
from amazme_backend.host import Host, application
from amazme_backend.host_store import ServiceRecord
from amazme_backend.processes import ProcessReservation
from amazme_backend.session_domain import ToolInvocation
from amazme_backend.worker import Worker
from amazme_backend.workspace_files import capture_text


@pytest.fixture
async def context(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    profile = tmp_path / "profile"
    profile.mkdir()
    private_write(profile / "config.json", json.dumps({
        "format": 2, "profile_id": "checkpoint-test", "workspace": str(root), "resources": "unused",
        "provider": {"provider": "faux"}, "approval_policy": "auto"}))
    private_write(profile / "control.token", "private")
    private_write(profile / "web.token", "web")
    host = Host(Profile(profile))
    with (ProcessReservation(profile, "host", "host") as hl,
          ProcessReservation(profile, "supervisor", "supervisor") as sl,
          ProcessReservation(profile, "worker", "worker") as wl):
        epoch = await host.store.initialize(host.instance, host.build, hl.lease)
        await host.store.transaction(lambda db: db.execute(
            "INSERT INTO sessions(id,title,workspace) VALUES('s','checkpoint','primary')"))
        host.fence = HostFence(build_id=host.build, host_epoch=epoch)
        host.origin = "http://127.0.0.1:12345"
        await host.store.save_service(ServiceRecord(instance_id="supervisor", build_id=host.build,
                                                    process_lease=sl.lease, state="running", pid=os.getpid()))
        identity = Identity(build_id=host.build, profile_id=host.profile.config.profile_id,
                            instance_id="supervisor", pid=os.getpid(), host_epoch=epoch,
                            role="supervisor", fingerprint=host.build)
        health = SupervisorHealth(identity=identity, registry_revision="1",
            workers=[WorkerInfo(session_id="s", worker_id="worker", pid=os.getpid(), socket="unused",
                build_id=host.build, process_lease=wl.lease, state="ready", execution_epoch=1,
                fingerprint=host.build, host_epoch=epoch)],
            epochs=[EpochHealth(session_id="s", worker_id="worker", execution_epoch=1, state="open")])
        host.supervisor.call = AsyncMock(return_value=health)
        request = PrepareFileWrite(session_id="s", worker_id="worker", execution_epoch=1,
            supervisor_id="supervisor", build_id=host.build, host_epoch=epoch, call_id="write-1",
            write=WriteFile(path="note.txt", content="after\n"))
        try:
            yield host, root, request, health
        finally:
            await host.supervisor.close()
            await host.store.db.close()




async def test_prepare_is_private_durable_and_idempotent_before_any_write(context):
    host, root, request, _ = context
    (root / "note.txt").write_text("before\n")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin) as client:
        denied = await client.post("/control/file-writes/prepare", json=request.model_dump(),
                                  headers={"Authorization": "Bearer web"})
        assert denied.status_code == 401
        response = await client.post("/control/file-writes/prepare", json=request.model_dump(),
                                     headers={"Authorization": "Bearer private"})
    assert response.status_code == 200, response.text
    prepared = response.json()
    assert (root / "note.txt").read_text() == "before\n"
    saved = await host.store.checkpoint(prepared["checkpoint_id"])
    assert saved[-1] == "before\n"
    call = ToolCall(id="call", name="write_file", arguments=request.write.model_dump_json())
    result = run_file(root, call, prepared["expected_digest"])
    assert result.returncode == 0, result.stderr
    assert (root / "note.txt").read_text() == "after\n"
    repeated = await host.prepare_tool_write(request)
    assert repeated.model_dump() == prepared
    rows = await host.store.checkpoints_for("primary", "note.txt")
    assert len(rows) == 1 and rows[0][3] == hashlib.sha256(b"before\n").hexdigest()
    conflict = request.model_copy(update={"write": WriteFile(path="note.txt", content="other")})
    with pytest.raises(BackendError, match="call_conflict"):
        await host.prepare_tool_write(conflict)


async def test_prepare_and_worker_bind_a_relative_path_to_the_session_workspace(context):
    host, root, request, _ = context
    grant = host.profile.path.parent / f"grant-{host.profile.path.name}"
    grant.mkdir()
    session = "a" * 32
    try:
        (root / "note.txt").write_text("primary\n")
        (grant / "note.txt").write_text("granted\n")
        await host.add_workspace(WorkspaceGrantRequest(name="docs", host_path=str(grant)))
        await host.store.transaction(lambda db: db.execute(
            "UPDATE sessions SET title='host', workspace='docs' WHERE id='s'"))
        await host.store.transaction(lambda db: db.execute(
            "INSERT INTO sessions(id,title,workspace) VALUES(?, 'worker','docs')", (session,)))
        prepared = await host.prepare_tool_write(request)
        assert prepared.path == "grant/docs/note.txt"
        assert prepared.expected_digest == hashlib.sha256(b"granted\n").hexdigest()
        assert (root / "note.txt").read_text() == "primary\n"
        assert (grant / "note.txt").read_text() == "granted\n"
        saved = await host.store.checkpoint(prepared.checkpoint_id)
        assert saved is not None and saved[1] == "docs" and saved[2] == "grant/docs/note.txt"
        worker = Worker(host.profile, session, "worker")
        worker.store.db.path.parent.mkdir(parents=True, mode=0o700)
        await worker.store.initialize()
        await worker.store.fence(HostFence(host_epoch=request.host_epoch, build_id=host.build))
        private_write(host.profile.path / "ready.json", HostReady(
            build_id=host.build, profile_id=host.profile.config.profile_id, instance_id=host.instance,
            pid=os.getpid(), host_epoch=request.host_epoch, role="host", fingerprint=host.build,
            url="http://127.0.0.1:9").model_dump_json())
        action = ToolInvocation(step_id=request.call_id, request_id="r", generation=1,
            call=ToolCall(id="call", name="write_file", arguments=request.write.model_dump_json()),
            lease=Lease(session_id=session, worker_id="worker", execution_epoch=1,
                        build_id=host.build, supervisor_id="supervisor"))

        class FakeResponse:
            def __init__(self, payload: bytes) -> None:
                self.content, self.is_error, self.status_code = payload, False, 200

        class FakeClient:
            payload = b""

            def __init__(self, *args: object, **kwargs: object) -> None:
                pass

            async def __aenter__(self) -> "FakeClient":
                return self

            async def __aexit__(self, *exc: object) -> None:
                return None

            async def post(self, url: str, json: object, headers: dict[str, str]) -> FakeResponse:
                return FakeResponse(FakeClient.payload)

        original_client = httpx.AsyncClient
        httpx.AsyncClient = FakeClient  # type: ignore[misc,assignment]
        try:
            FakeClient.payload = prepared.model_dump_json().encode()
            accepted = await worker.prepare_file_write(action)
            assert accepted.path == "grant/docs/note.txt"
            FakeClient.payload = prepared.model_copy(update={"path": "note.txt"}).model_dump_json().encode()
            with pytest.raises(BackendError, match="file_preparation_mismatch"):
                await worker.prepare_file_write(action)
        finally:
            httpx.AsyncClient = original_client  # type: ignore[misc,assignment]
            await worker.store.db.close()
            await worker.supervisor.close()
    finally:
        shutil.rmtree(grant, ignore_errors=True)


async def test_local_write_rejects_change_after_checkpoint_and_created_file_conflict(context):
    host, root, request, _ = context
    (root / "note.txt").write_text("before")
    prepared = await host.prepare_tool_write(request)
    (root / "note.txt").write_text("someone else's edit")
    call = ToolCall(id="call", name="write_file", arguments=request.write.model_dump_json())
    result = run_file(root, call, prepared.expected_digest)
    assert result.returncode != 0 and "file_conflict" in result.stderr
    assert (root / "note.txt").read_text() == "someone else's edit"
    new = request.model_copy(update={"call_id": "new", "write": WriteFile(path="new.txt", content="after")})
    prepared_new = await host.prepare_tool_write(new)
    assert prepared_new.expected_digest == prepared_new.checkpoint_id == ""
    (root / "new.txt").write_text("created meanwhile")
    result = run_file(root, ToolCall(id="new", name="write_file", arguments=new.write.model_dump_json()), "")
    assert result.returncode != 0 and "file_conflict" in result.stderr
    assert (root / "new.txt").read_text() == "created meanwhile"


@pytest.mark.parametrize("defect", ["host_epoch", "worker", "epoch", "supervisor", "validation", "fingerprint", "worker_epoch", "frozen"])
async def test_stale_or_frozen_ownership_never_creates_checkpoint(context, defect):
    host, root, request, health = context
    (root / "note.txt").write_text("keep")
    if defect == "host_epoch":
        request.host_epoch += 1
    elif defect == "worker":
        health.workers[0].worker_id = "other"
    elif defect == "epoch":
        health.epochs[0].state = "closed"
    elif defect == "supervisor":
        request.supervisor_id = "other"
    elif defect == "validation":
        health.workers[0].purpose = "validation"
    elif defect == "fingerprint":
        health.workers[0].fingerprint = "other"
    elif defect == "worker_epoch":
        health.workers[0].execution_epoch += 1
    else:
        health.freeze_id = "update"
    with pytest.raises(BackendError):
        await host.prepare_tool_write(request)
    assert not await host.store.checkpoints_for("primary", "note.txt")
    assert (root / "note.txt").read_text() == "keep"


async def test_checkpoint_storage_refusal_prevents_preparation(context):
    host, root, request, _ = context
    (root / "note.txt").write_text("keep")
    await host.store.transaction(lambda db: db.executemany("INSERT INTO file_checkpoints(id,workspace,path,digest,content) VALUES(?,?,?,?,?)",
        [(str(n), "primary", str(n), "digest", "text") for n in range(200)]))
    with pytest.raises(BackendError, match="checkpoint_capacity"):
        await host.prepare_tool_write(request)
    assert await host.store.file_write_preparation(request.session_id, request.call_id, request.write) is None
    assert (root / "note.txt").read_text() == "keep"


async def test_worker_never_sends_tool_before_preparation_succeeds(context):
    host, _root, request, _ = context
    worker = Worker(host.profile, "a" * 32, "worker")
    worker.prepare_file_write = AsyncMock(side_effect=BackendError("storage_failure"))
    worker.supervisor.call = AsyncMock()
    action = ToolInvocation(step_id="step", request_id="r", generation=1,
        call=ToolCall(id="call", name="write_file", arguments=request.write.model_dump_json()),
        lease=Lease(**request.model_dump(include={"session_id", "worker_id", "execution_epoch", "supervisor_id", "build_id"})))
    try:
        with pytest.raises(BackendError, match="storage_failure"):
            await worker.perform(action)
        worker.supervisor.call.assert_not_called()
    finally:
        await worker.supervisor.close()
        await worker.store.db.close()


def test_file_capture_preserves_full_utf8_and_refuses_nonrestorable_bytes(tmp_path):
    content = "界" * 20000
    (tmp_path / "big.txt").write_text(content)
    digest, saved = capture_text(tmp_path, "big.txt")
    assert saved == content and digest == hashlib.sha256(content.encode()).hexdigest()
    (tmp_path / "binary").write_bytes(b"\xff")
    with pytest.raises(BackendError, match="file_not_text"):
        capture_text(tmp_path, "binary")
    (tmp_path / "oversize").write_bytes(b"x" * 1048577)
    with pytest.raises(BackendError, match="checkpoint_unavailable"):
        capture_text(tmp_path, "oversize")
    (tmp_path / "link").symlink_to(tmp_path / "big.txt")
    with pytest.raises(BackendError):
        capture_text(tmp_path, "link")
    os.link(tmp_path / "big.txt", tmp_path / "hard")
    with pytest.raises(BackendError, match="workspace_hardlink_write"):
        capture_text(tmp_path, "hard")


def test_unprepared_write_is_refused_before_any_effect(tmp_path):
    result = run_file(tmp_path, ToolCall(id="call", name="write_file", arguments='{"path":"a","content":"b"}'), None)
    assert result.returncode != 0 and result.stderr == "file_write_unprepared"
    assert not (tmp_path / "a").exists()


async def test_full_checkpoint_can_preview_restore_and_become_latest_again(context):
    from amazme_backend.contracts import CheckpointRestore
    from amazme_backend.workspace_files import FileWrite

    host, root, request, _ = context
    before = "界" * 20000 + "\n"
    (root / "note.txt").write_text(before)
    prepared = await host.prepare_tool_write(request)
    result = run_file(root, ToolCall(id="call", name="write_file", arguments=request.write.model_dump_json()),
                     prepared.expected_digest)
    assert result.returncode == 0, result.stderr
    preview = await host.preview_checkpoint(prepared.checkpoint_id)
    assert preview.content == before and preview.current_digest == hashlib.sha256(b"after\n").hexdigest()
    await host.restore_checkpoint(prepared.checkpoint_id, CheckpointRestore(expected_digest=preview.current_digest))
    assert (root / "note.txt").read_text() == before
    # A second use of the same bytes becomes latest without making duplicate checkpoints.
    later = request.model_copy(update={"call_id": "write-2"})
    assert (await host.prepare_tool_write(later)).checkpoint_id == prepared.checkpoint_id
    rows = await host.store.checkpoints_for("primary", "note.txt")
    assert len(rows) == 2 and rows[-1][0] == prepared.checkpoint_id
    # Replaying the older preparation does not reorder history or capture different bytes.
    await host.write_workspace(FileWrite(path="note.txt", content="latest\n", expected_digest=prepared.expected_digest))
    assert (await host.prepare_tool_write(request)) == prepared
    assert (root / "note.txt").read_text() == "latest\n"


async def test_preparation_and_backup_rollback_together_and_survive_reopen(context):
    from amazme_backend.host_store import HostStore

    host, root, request, _ = context
    (root / "note.txt").write_text("keep")
    await host.store.transaction(lambda db: db.execute("""
        CREATE TRIGGER refuse_preparation BEFORE INSERT ON file_write_preparations
        BEGIN SELECT RAISE(ABORT, 'injected write failure'); END
    """))
    with pytest.raises(BackendError) as failed:
        await host.prepare_tool_write(request)
    assert failed.value.code == "storage_failure"
    assert (root / "note.txt").read_text() == "keep"
    await host.store.db.close()
    host.store = HostStore(host.profile.path / "host.sqlite")
    assert not await host.store.checkpoints_for("primary", "note.txt")
    assert await host.store.file_write_preparation(request.session_id, request.call_id, request.write) is None
    await host.store.transaction(lambda db: db.execute("DROP TRIGGER refuse_preparation"))
    prepared = await host.prepare_tool_write(request)
    await host.store.db.close()
    host.store = HostStore(host.profile.path / "host.sqlite")
    (root / "note.txt").write_text("changed after restart")
    assert await host.prepare_tool_write(request) == prepared
    assert (await host.store.checkpoint(prepared.checkpoint_id))[-1] == "keep"


async def test_model_write_checkpoint_is_bound_to_granted_workspace(context, tmp_path):
    host, root, request, _ = context
    extra = tmp_path / "extra"
    extra.mkdir()
    (extra / "note.txt").write_text("extra before")
    (root / "note.txt").write_text("primary")
    await host.store.add_workspace_grant("docs", str(extra))
    request.write.path = "grant/docs/note.txt"
    prepared = await host.prepare_tool_write(request)
    checkpoint = await host.store.checkpoint(prepared.checkpoint_id)
    assert checkpoint[1:3] == ("docs", "grant/docs/note.txt")
    assert checkpoint[-1] == "extra before"
    assert (root / "note.txt").read_text() == "primary"


def test_restore_write_refuses_busy_file_and_replaced_parent(tmp_path, monkeypatch):
    import fcntl

    from amazme_backend.workspace_files import FileWrite, write_file

    child = tmp_path / "sub"
    child.mkdir()
    target = child / "note"
    target.write_text("before")
    digest = hashlib.sha256(b"before").hexdigest()
    value = FileWrite(path="sub/note", content="after", expected_digest=digest)
    with target.open("r+") as file:
        fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(BackendError, match="file_conflict"):
            write_file(tmp_path, value)
    assert target.read_text() == "before"
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "note").write_text("before")
    real_open = os.open

    def swapping_open(path, flags, *args, **kwargs):
        if path == "sub":
            child.rename(tmp_path / "original")
            child.symlink_to(outside, target_is_directory=True)
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", swapping_open)
    with pytest.raises(BackendError):
        write_file(tmp_path, value)
    assert (outside / "note").read_text() == "before"
    assert (tmp_path / "original/note").read_text() == "before"
