import asyncio
import contextlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import (
    BackendError,
    Cleanup,
    Lease,
    Message,
    RunTool,
    Submit,
    ToolResult,
    WorkerSpec,
)
from amazme_backend.providers import Completion
from amazme_backend.supervisor import Supervisor
from amazme_backend.worker import Worker


@pytest.fixture
def profile(tmp_path, monkeypatch):
    private_write(tmp_path / "config.json", json.dumps({
        "profile_id": "test", "workspace": str(tmp_path), "resources": "unused", "provider": {"provider": "faux"},
    }))
    private_write(tmp_path / "control.token", "test-control")
    for module in ("worker", "supervisor"):
        monkeypatch.setattr(f"amazme_backend.{module}.build_id", lambda: "test-build")
    return Profile(tmp_path)


class PausedPeer:
    def __init__(self):
        self.opened, self.release_open = asyncio.Event(), asyncio.Event()
        self.closing, self.release_close = asyncio.Event(), asyncio.Event()
        self.closes = 0

    async def call(self, method, path, response, value):
        if path == "/epochs/open":
            self.opened.set()
            await self.release_open.wait()
            return Lease(**value.model_dump(), execution_epoch=1)
        assert path == "/epochs/close"
        self.closes += 1
        self.closing.set()
        await self.release_close.wait()
        return Cleanup(session_id=value.session_id, execution_epoch=1, state="clean", containers=[])

    async def close(self):
        pass


async def prepared_worker(profile):
    (profile.path / "sessions/s").mkdir(parents=True)
    owner = Worker(profile, "s", "worker")
    await owner.store.initialize()
    owner.state = "ready"
    await owner.supervisor.close()
    return owner


@pytest.mark.asyncio
async def test_repeated_cancel_cannot_interrupt_lease_open_or_cleanup(profile, monkeypatch):
    owner = await prepared_worker(profile)
    peer = PausedPeer()
    owner.supervisor = peer
    model = Mock(side_effect=AssertionError("cancelled work reached model"))
    monkeypatch.setattr("amazme_backend.worker.stream", model)
    await owner.submit(Submit(request_id="cancel", text="task"))
    request = await owner.store.claim()
    owner.current = request.request_id
    owner.run_task = asyncio.create_task(owner.run(request))
    try:
        await asyncio.wait_for(peer.opened.wait(), 2)
        await asyncio.gather(*(owner.cancel("cancel") for _ in range(20)))
        assert not owner.run_task.done()
        peer.release_open.set()
        await asyncio.wait_for(peer.closing.wait(), 2)
        await asyncio.gather(*(owner.cancel("cancel") for _ in range(20)))
        assert not owner.run_task.done()
        assert (await owner.store.get("cancel")).status == "cancelling"
        peer.release_close.set()
        await asyncio.wait_for(owner.run_task, 2)
        assert (await owner.store.get("cancel")).status == "cancelled"
        assert peer.closes == 1
        model.assert_not_called()
    finally:
        peer.release_open.set()
        peer.release_close.set()
        await owner.run_task
        await owner.store.db.close()


@pytest.mark.asyncio
async def test_cancel_between_claim_and_run_never_calls_model(profile):
    owner = await prepared_worker(profile)
    owner.supervisor = SimpleNamespace(call=AsyncMock())
    owner.perform = AsyncMock()
    await owner.submit(Submit(request_id="cancel", text="task"))
    request = await owner.store.claim()
    await owner.cancel(request.request_id)
    try:
        await owner.run(request)
        assert (await owner.store.get("cancel")).status == "cancelled"
        owner.supervisor.call.assert_not_awaited()
        owner.perform.assert_not_awaited()
    finally:
        await owner.store.db.close()


@pytest.mark.asyncio
async def test_lost_lease_reply_blocks_admission_and_emits_state(profile):
    owner = await prepared_worker(profile)
    owner.supervisor = SimpleNamespace(call=AsyncMock(side_effect=httpx.ReadTimeout("lost reply")))
    await owner.submit(Submit(request_id="lost", text="task"))
    try:
        await owner.run(await owner.store.claim())
        assert owner.state == "blocked"
        assert (await owner.store.get("lost")).status == "running"
        assert (await owner.store.events(0))[-1].kind == "cleanup"
        with pytest.raises(BackendError, match="execution_cleanup_pending"):
            await owner.submit(Submit(request_id="unsafe", text="must not start"))
    finally:
        await owner.store.db.close()


@pytest.mark.asyncio
async def test_final_message_is_authoritative_without_preview(profile, monkeypatch):
    owner = await prepared_worker(profile)
    peer = PausedPeer()
    peer.release_open.set()
    peer.release_close.set()
    owner.supervisor = peer

    async def complete(*_):
        yield Completion(message=Message(role="assistant", content="final result"), response_id="response")

    monkeypatch.setattr("amazme_backend.worker.stream", complete)
    await owner.submit(Submit(request_id="final", text="task"))
    try:
        await owner.run(await owner.store.claim())
        result = await owner.store.get("final")
        assert result.status == "succeeded" and result.answer == "final result"
    finally:
        await owner.store.db.close()


@pytest.mark.asyncio
async def test_concurrent_ensure_during_startup_reserves_one_worker(profile, monkeypatch):
    monkeypatch.setattr("amazme_backend.supervisor.VM", lambda _: SimpleNamespace(start=AsyncMock(return_value="boot")))
    peer = SimpleNamespace(call=AsyncMock(side_effect=httpx.ConnectError("not listening yet")), close=AsyncMock())
    monkeypatch.setattr("amazme_backend.supervisor.Peer", lambda *_: peer)
    spawn = AsyncMock(return_value=SimpleNamespace(pid=123, returncode=None))
    monkeypatch.setattr("amazme_backend.supervisor.asyncio.create_subprocess_exec", spawn)
    owner = Supervisor(profile)
    await owner.initialize()
    try:
        value = WorkerSpec(host_epoch=0, build_id=owner.build, session_id="a" * 32)
        results = await asyncio.gather(*(owner.ensure_worker(value) for _ in range(16)))
        assert len({r.worker_id for r in results}) == 1
        assert spawn.await_count == 1
        assert (await owner.worker_info(value.session_id)).worker_id == results[0].worker_id
    finally:
        owner.monitor_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await owner.monitor_task
        await owner.db.close()


@pytest.mark.asyncio
async def test_disconnected_tool_waiters_release_capacity(profile, monkeypatch):
    monkeypatch.setattr("amazme_backend.supervisor.VM", lambda _: SimpleNamespace())
    owner = Supervisor(profile)
    owner.check_lease = AsyncMock()
    try:
        for index in range(18):
            started, complete = asyncio.Event(), asyncio.Event()

            async def execute(value):
                started.set()
                await complete.wait()
                return ToolResult(call_id=value.call_id, exit_code=0, stdout="done", stderr="")

            owner.execute = execute
            value = RunTool(session_id="s", worker_id="w", execution_epoch=1, build_id=owner.build,
                            call_id=str(index), command="true")
            waiter = asyncio.create_task(owner.run_tool(value))
            await asyncio.wait_for(started.wait(), 2)
            waiter.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await waiter
            task = owner.jobs[value.call_id]
            complete.set()
            assert (await task).stdout == "done"
            await asyncio.sleep(0)
            assert not owner.jobs and not owner.job_requests
    finally:
        await owner.db.close()
