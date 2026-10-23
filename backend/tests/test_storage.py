import asyncio
import sqlite3

import pytest

from amazme_backend.contracts import BackendError, Message, Submit
from amazme_backend.storage import Database, SessionStore


@pytest.mark.asyncio
async def test_concurrent_acceptance_is_one_durable_receipt(tmp_path):
    store = SessionStore(tmp_path / "session.sqlite", "session")
    await store.initialize()
    try:
        request = Submit(request_id="same", text="内容")
        results = await asyncio.gather(*(store.accept(request) for _ in range(16)))
        assert all(result == results[0] for result in results)
        with pytest.raises(BackendError, match="request_conflict"):
            await store.accept(Submit(request_id="same", text="不同内容"))
        assert len((await store.snapshot()).requests) == 1
        assert [event.kind for event in await store.events(0)] == ["accepted"]
    finally:
        await store.db.close()
    reopened = SessionStore(tmp_path / "session.sqlite", "session")
    await reopened.initialize()
    try:
        assert await reopened.accept(request) == results[0]
        assert len(await reopened.events(0)) == 1
    finally:
        await reopened.db.close()


@pytest.mark.asyncio
async def test_cancel_preserves_unrelated_queue_and_completed_result(tmp_path):
    store = SessionStore(tmp_path / "session.sqlite", "session")
    await store.initialize()
    try:
        for name in ["one", "two"]:
            await store.accept(Submit(request_id=name, text=name))
        assert (await store.claim()).request_id == "one"
        assert (await store.cancel("one")).status == "cancelling"
        await store.update("one", status="cancelled")
        assert (await store.claim()).request_id == "two"
        await store.update("two", status="succeeded", answer="done")
        assert (await store.cancel("two")).status == "succeeded"
    finally:
        await store.db.close()


@pytest.mark.asyncio
async def test_recovery_keeps_unknown_effect_and_never_requeues_it(tmp_path):
    store = SessionStore(tmp_path / "session.sqlite", "session")
    await store.initialize()
    await store.accept(Submit(request_id="unsafe", text="write"))
    await store.claim()
    await store.tool("unsafe", "call", '{"command":"write"}')
    await store.message("unsafe", Message(role="assistant", content="partial"))
    await store.accept(Submit(request_id="queued", text="next"))
    await store.db.close()
    store = SessionStore(tmp_path / "session.sqlite", "session")
    await store.initialize()
    try:
        await store.recover()
        assert (await store.get("unsafe")).status == "unknown"
        assert await store.messages() == []
        assert (await store.claim()).request_id == "queued"
        assert (await store.accept(Submit(request_id="unsafe", text="write"))).status == "unknown"
    finally:
        await store.db.close()


@pytest.mark.asyncio
async def test_unsupported_format_is_rejected_without_writing(tmp_path):
    path = tmp_path / "future.sqlite"
    db = sqlite3.connect(path)
    db.execute("PRAGMA user_version=99")
    db.close()
    before = path.read_bytes()
    database = Database(path)
    try:
        with pytest.raises(BackendError, match="unsupported_storage_format"):
            await database.call(lambda db: db.execute("CREATE TABLE unexpected(x)"))
    finally:
        await database.close()
    assert path.read_bytes() == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["future.sqlite"]


@pytest.mark.asyncio
async def test_lost_tool_result_is_unknown_not_failed_and_never_requeued(tmp_path):
    store = SessionStore(tmp_path / "session.sqlite", "s")
    await store.initialize()
    try:
        request = Submit(request_id="effect", text="write")
        await store.accept(request)
        await store.claim()
        await store.tool("effect", "call", "{}")
        await store.finish("effect", "failed", "ReadTimeout")
        assert (await store.accept(request)).status == "unknown"
        assert await store.claim() is None
        assert await store.messages() == []
    finally:
        await store.db.close()


@pytest.mark.asyncio
async def test_snapshot_keeps_tools_after_long_preview_and_uses_full_cursor(tmp_path):
    store = SessionStore(tmp_path / "session.sqlite", "s")
    await store.initialize()
    try:
        await store.accept(Submit(request_id="long", text="read"))
        await store.claim()
        await store.tool("long", "call", '{"name":"read_file"}')
        await store.tool("long", "call", "{}", '{"stdout":"content"}')
        for size in range(30):
            await store.update("long", answer="x" * size)
        snapshot = await store.snapshot()
        assert [e.kind for e in snapshot.events] == ["tool", "tool"]
        assert snapshot.seq == "34"
        assert await store.events(int(snapshot.seq)) == []
    finally:
        await store.db.close()


@pytest.mark.asyncio
async def test_full_queue_snapshot_retains_active_request_for_cancellation(tmp_path):
    store = SessionStore(tmp_path / "session.sqlite", "s")
    await store.initialize()
    try:
        await store.accept(Submit(request_id="active", text="long task"))
        await store.claim()
        for index in range(25):
            await store.accept(Submit(request_id=str(index), text="queued"))
        requests = (await store.snapshot()).requests
        assert requests[0].request_id == "active" and requests[0].status == "running"
        assert len(requests) == 21 and requests[-1].request_id == "24"
    finally:
        await store.db.close()
