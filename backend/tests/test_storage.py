import asyncio
import sqlite3
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio

from amazme_backend.contracts import BackendError, HostFence, Submit
from amazme_backend.storage import Database, SessionStore

FENCE = HostFence(host_epoch=1, build_id="test-build")


@pytest_asyncio.fixture
async def store(tmp_path: Path) -> AsyncIterator[SessionStore]:
    value = SessionStore(tmp_path / "session.sqlite", "session")
    await value.initialize()
    await value.fence(FENCE)
    try:
        yield value
    finally:
        await value.db.close()


async def test_concurrent_acceptance_is_one_durable_receipt(store: SessionStore) -> None:
    value = Submit(request_id="same", text="内容")
    receipts = await asyncio.gather(*(store.accept(value, FENCE) for _ in range(16)))
    assert all(r == receipts[0] for r in receipts)
    with pytest.raises(BackendError, match="request_conflict"):
        await store.accept(value.model_copy(update={"text": "不同内容"}), FENCE)
    snapshot = await store.snapshot()
    assert len(snapshot.requests) == 1
    replay = await store.events(int(receipts[0].accepted_revision) - 1)
    assert len(replay.batches) == 1 and len(replay.batches[0].events) == 1
    await store.db.close()
    reopened = SessionStore(store.db.path, "session", require_existing=True)
    await reopened.initialize()
    try:
        assert await reopened.accept(value, FENCE) == receipts[0]
        assert (await reopened.snapshot()).stream_id == snapshot.stream_id
    finally:
        await reopened.db.close()


async def test_tombstone_survives_restart_and_unrelated_queue(store: SessionStore) -> None:
    cancelled = await store.cancel("late", FENCE)
    assert await store.cancel("late", FENCE) == cancelled
    assert (await store.snapshot()).requests == [cancelled]
    await store.db.close()
    reopened = SessionStore(store.db.path, "session", require_existing=True)
    await reopened.initialize()
    try:
        await reopened.accept(Submit(request_id="other", text="continue"), FENCE)
        receipt = await reopened.accept(Submit(request_id="late", text="never execute", mode="reject_busy"), FENCE)
        assert receipt.status == "cancelled" and receipt.cancel_requested
        assert (await reopened.get("other")).status == "queued"
    finally:
        await reopened.db.close()


async def test_host_fence_is_monotonic_and_checked_inside_acceptance(store: SessionStore) -> None:
    await store.fence(HostFence(host_epoch=2, build_id=FENCE.build_id))
    with pytest.raises(BackendError, match="stale_host_epoch"):
        await store.accept(Submit(request_id="stale", text="no"), FENCE)
    with pytest.raises(BackendError, match="stale_host_epoch"):
        await store.fence(FENCE)
    assert (await store.snapshot()).requests == []


@pytest.mark.parametrize("version", [1, 99])
@pytest.mark.parametrize("wal", [False, True])
async def test_unsupported_format_preflight_preserves_all_files(tmp_path: Path, version: int, wal: bool) -> None:
    path = tmp_path / "store.sqlite"
    source = sqlite3.connect(path)
    if wal:
        source.execute("PRAGMA journal_mode=WAL")
    source.execute(f"PRAGMA user_version={version}")
    source.execute("CREATE TABLE evidence(value)")
    source.commit()
    before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns, p.stat().st_size) for p in tmp_path.iterdir()}
    database = Database(path)
    try:
        with pytest.raises(BackendError, match="unsupported_storage_format"):
            await database.call(lambda db: db.execute("CREATE TABLE unexpected(x)"))
        assert {p.name: (p.read_bytes(), p.stat().st_mtime_ns, p.stat().st_size) for p in tmp_path.iterdir()} == before
    finally:
        await database.close()
        source.close()


async def test_corrupt_preflight_is_readonly(tmp_path: Path) -> None:
    path = tmp_path / "broken.sqlite"
    path.write_bytes(b"broken database" * 1024)
    before = path.read_bytes(), path.stat().st_mtime_ns
    database = Database(path)
    try:
        with pytest.raises(BackendError) as caught:
            await database.call(lambda db: db.execute("CREATE TABLE unexpected(x)"))
        assert caught.value.code == "storage_failure"
        assert (path.read_bytes(), path.stat().st_mtime_ns) == before
        assert list(tmp_path.iterdir()) == [path]
    finally:
        await database.close()


@pytest.mark.parametrize("kind", ["missing", "empty", "partial"])
async def test_require_existing_never_recreates_missing_state(tmp_path: Path, kind: str) -> None:
    path = tmp_path / "session.sqlite"
    if kind == "empty":
        path.touch()
    elif kind == "partial":
        with sqlite3.connect(path) as db:
            db.execute("PRAGMA user_version=2")
            db.execute("CREATE TABLE metadata(key,value)")
    before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in tmp_path.iterdir()}
    value = SessionStore(path, "session", require_existing=True)
    try:
        with pytest.raises(BackendError):
            await value.initialize()
        assert {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in tmp_path.iterdir()} == before
    finally:
        await value.db.close()


@pytest.mark.parametrize("mutation", ["unlink", "replace", "truncate"])
async def test_open_database_identity_loss_latches_admission(store: SessionStore, mutation: str) -> None:
    await store.accept(Submit(request_id="kept", text="original"), FENCE)
    path = store.db.path
    if mutation == "unlink":
        path.unlink()
    elif mutation == "truncate":
        path.write_bytes(b"")
    else:
        replacement = path.with_suffix(".replacement")
        replacement.write_bytes(path.read_bytes())
        replacement.replace(path)
    with pytest.raises(BackendError) as first:
        await store.accept(Submit(request_id="lost", text="must not ACK"), FENCE)
    assert first.value.code == "storage_failure"
    with pytest.raises(BackendError) as second:
        await store.get("kept")
    assert second.value.code == "storage_blocked"


async def test_sqlite_full_rolls_back_receipt_and_batch_and_latches(store: SessionStore) -> None:
    await store.accept(Submit(request_id="kept", text="original"), FENCE)
    snapshot = await store.snapshot()

    def restrict(db: sqlite3.Connection) -> None:
        count = int(db.execute("PRAGMA page_count").fetchone()[0])
        db.execute(f"PRAGMA max_page_count={count}")
    await store.db.call(restrict)
    with pytest.raises(BackendError) as caught:
        await store.accept(Submit(request_id="full", text="x" * 16000), FENCE)
    assert caught.value.code == "storage_failure" and "full" in caught.value.message
    with pytest.raises(BackendError) as blocked:
        await store.accept(Submit(request_id="no-retry", text="small"), FENCE)
    assert blocked.value.code == "storage_blocked"
    await store.db.close()
    reopened = SessionStore(store.db.path, "session", require_existing=True)
    await reopened.initialize()
    try:
        restored = await reopened.snapshot()
        assert restored.seq == snapshot.seq and restored.requests == snapshot.requests
        with pytest.raises(BackendError, match="request_not_found"):
            await reopened.get("full")
    finally:
        await reopened.db.close()


async def test_full_snapshot_and_complete_batch_replay(store: SessionStore) -> None:
    for index in range(40):
        await store.accept(Submit(request_id=str(index), text="queued"), FENCE)
    snapshot = await store.snapshot()
    assert len(snapshot.requests) == snapshot.pending == 40
    cursor = 0
    while cursor < int(snapshot.seq):
        replay = await store.events(cursor, snapshot.stream_id)
        assert not replay.resync and replay.batches
        assert replay.seq == replay.batches[-1].seq
        for batch in replay.batches:
            assert int(batch.base_revision) == cursor
            cursor += 1
            assert batch.revision == batch.seq == str(cursor)
            assert all(event.seq == batch.seq for event in batch.events)
    assert (await store.events(cursor, snapshot.stream_id)).batches == []
    assert (await store.events(cursor, "another-stream")).resync
    assert (await store.events(cursor + 1, snapshot.stream_id)).resync


async def test_snapshot_recent_roots_follow_settlement_not_acceptance(store: SessionStore) -> None:
    await store.accept(Submit(request_id="old-input", text="finishes last"), FENCE)
    for index in range(25):
        identity = f"recent-{index}"
        await store.cancel(identity, FENCE)
        await store.accept(Submit(request_id=identity, text="cancelled before acceptance"), FENCE)
    await store.cancel("old-input", FENCE)
    snapshot = await store.snapshot()
    assert len(snapshot.requests) == 20
    assert any(r.request_id == "old-input" and r.status == "cancelled" for r in snapshot.requests)
    assert not any(r.request_id == "recent-0" for r in snapshot.requests)


async def test_replay_retention_requests_resync_without_losing_dedup(store: SessionStore) -> None:
    request = Submit(request_id="first", text="durable")
    original = await store.accept(request, FENCE)
    for epoch in range(2, 265):
        await store.fence(HostFence(host_epoch=epoch, build_id=FENCE.build_id))
    assert (await store.events(0)).resync
    assert await store.accept(request, HostFence(host_epoch=264, build_id=FENCE.build_id)) == original


async def test_valid_wal_preflight_reads_committed_pages(tmp_path: Path) -> None:
    path = tmp_path / "session.sqlite"
    first = SessionStore(path, "session")
    await first.initialize()
    await first.fence(FENCE)
    await first.accept(Submit(request_id="wal", text="committed"), FENCE)
    reopened = SessionStore(path, "session", require_existing=True)
    try:
        await reopened.initialize()
        assert (await reopened.get("wal")).text == "committed"
    finally:
        await reopened.db.close()
        await first.db.close()


async def test_logical_corruption_is_rejected_before_writable_open(store: SessionStore) -> None:
    await store.accept(Submit(request_id="bad", text="input"), FENCE)
    await store.db.call(lambda db: db.execute("UPDATE runs SET payload='{}'"))
    await store.db.close()
    before = store.db.path.read_bytes(), store.db.path.stat().st_mtime_ns
    reopened = SessionStore(store.db.path, "session", require_existing=True)
    try:
        with pytest.raises(BackendError, match="storage_corrupt"):
            await reopened.initialize()
        assert (store.db.path.read_bytes(), store.db.path.stat().st_mtime_ns) == before
    finally:
        await reopened.db.close()
