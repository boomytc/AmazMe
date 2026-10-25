"""Protocol and reducer proofs without VM, credentials or a running browser."""

import asyncio
import json
import shutil
import subprocess
from pathlib import Path
from typing import cast

import pytest
from fastapi import WebSocket, WebSocketDisconnect

from amazme_backend import streams
from amazme_backend.contracts import (
    Attachment,
    BackendError,
    CommitBatch,
    Event,
    HostFence,
    Replay,
    Snapshot,
    Stream,
    Submit,
)
from amazme_backend.host import Host
from amazme_backend.storage import PENDING_LIMIT, SessionStore


class Socket:
    def __init__(self, *, stall_send=False):
        self.input = asyncio.Queue(maxsize=4)
        self.output = asyncio.Queue(maxsize=4)
        self.closed = asyncio.Event()
        self.code = None
        self.reason = ""
        self.stall_send = stall_send

    async def receive_text(self):
        value = await self.input.get()
        if value is None:
            raise WebSocketDisconnect()
        return value

    async def send_text(self, text):
        if self.stall_send:
            await asyncio.Event().wait()
        await self.output.put(json.loads(text))

    async def close(self, code, reason=""):
        self.code, self.reason = code, reason
        self.closed.set()

    async def hello(self, **overrides):
        await self.input.put(json.dumps(dict(kind="hello", binding_id="binding", build_id="build", **overrides)))

    async def ack(self, frame, **overrides):
        value = dict(kind="ack", binding_id=frame["binding_id"], stream_id=frame["stream_id"],
                     seq=frame["snapshot"]["seq"] if frame["snapshot"] else frame["batches"][-1]["seq"])
        value.update(overrides)
        await self.input.put(json.dumps(value))

    async def frame(self):
        return await asyncio.wait_for(self.output.get(), 1)


class Owner:
    def __init__(self):
        self.build = "build"
        self.fence = HostFence(host_epoch=1, build_id=self.build)
        self.closing = False
        self.attachments = {"binding": Attachment(attachment_id="binding", session_id="session", host_epoch=1, build_id="build")}
        self.snapshot = Snapshot(session_id="session", stream_id="stream", seq="0", state="ready", requests=[], events=[])
        self.replay = Replay(stream_id="stream", seq="0", batches=[])
        self.calls = []
        self.checks = 0

    def check_attachment(self, identity, session):
        self.checks += 1
        value = self.attachments.get(identity)
        if not value or (value.session_id, value.build_id, value.host_epoch) != (session, self.build, self.fence.host_epoch):
            raise BackendError("stale_client_binding")
        return value

    async def reader(self, session):
        assert session == "session"
        self.calls.append("reader")
        return self

    async def call(self, method, path, response):
        self.calls.append(path)
        return self.snapshot if response is Snapshot else self.replay


def batch(number=1, **updates):
    value = CommitBatch(stream_id="stream", seq=str(number), base_revision=str(number - 1), revision=str(number),
                        events=[Event(seq=str(number), kind="status", request_id="r", text="running")])
    return value.model_copy(update=updates)


def start(owner, socket, session="session"):
    return asyncio.create_task(streams.serve_stream(cast(Host, owner), cast(WebSocket, socket), session))


@pytest.fixture(autouse=True)
def fast_bounds(monkeypatch):
    for name in ["HELLO_TIMEOUT", "ACK_TIMEOUT", "SEND_TIMEOUT", "PEER_TIMEOUT"]:
        monkeypatch.setattr(streams, name, 0.1)
    monkeypatch.setattr(streams, "POLL_INTERVAL", 0.005)


async def stop(task, socket):
    if not task.done():
        await socket.input.put(None)
    await asyncio.wait_for(task, 1)


@pytest.mark.parametrize("change", [
    {"seq":"2"}, {"base_revision":"1"}, {"revision":"2"}, {"stream_id":"other"}, {"events":[]},
    {"events":[Event(seq="2", kind="status", request_id="r", text="running")]}, {"seq":"01"},
])
def test_whole_batch_order_and_revision(change):
    assert not streams.valid_replay(Replay(stream_id="stream", seq="1", batches=[batch(**change)]), "stream", 0)


def test_replay_watermark_and_full_window():
    assert streams.valid_replay(Replay(stream_id="stream", seq="2", batches=[batch(), batch(2)]), "stream", 0)
    assert not streams.valid_replay(Replay(stream_id="stream", seq="9", batches=[batch()]), "stream", 0)
    assert not streams.valid_replay(Replay(stream_id="stream", seq="2", batches=[batch(2), batch()]), "stream", 0)


async def test_no_hello_no_worker_and_no_registry_leak():
    owner, socket = Owner(), Socket()
    await start(owner, socket)
    assert socket.code == 1013 and not owner.calls
    assert owner not in streams._connections


@pytest.mark.parametrize("case", ["build", "binding", "session", "epoch", "malformed", "oversized", "binary"])
async def test_hello_fails_before_worker(case):
    owner, socket = Owner(), Socket()
    if case == "build":
        owner.build = "other"
    elif case == "binding":
        owner.attachments.clear()
    elif case == "epoch":
        owner.fence.host_epoch = 2
    if case == "malformed":
        await socket.input.put("not-json")
    elif case == "oversized":
        await socket.input.put(" " * (streams.MAX_INPUT_BYTES + 1))
    elif case == "binary":
        async def binary():
            raise KeyError("text")
        socket.receive_text = binary
    else:
        await socket.hello()
    await start(owner, socket, "other" if case == "session" else "session")
    assert socket.code == 1008 and not owner.calls


async def test_ack_gates_next_transaction_and_refreshes_attachment():
    owner, socket = Owner(), Socket()
    await socket.hello()
    task = start(owner, socket)
    first = await socket.frame()
    owner.replay = Replay(stream_id="stream", seq="1", batches=[batch()])
    await asyncio.sleep(0.02)
    assert socket.output.empty() and not any(path.startswith("/events") for path in owner.calls)
    await socket.ack(first)
    second = await socket.frame()
    assert second["batches"][0]["seq"] == "1" and owner.checks >= 4
    owner.replay = Replay(stream_id="stream", seq="1", batches=[])
    await socket.ack(second)
    await stop(task, socket)
    assert owner not in streams._connections


@pytest.mark.parametrize("change", [{"seq":"99"}, {"seq":"00"}, {"binding_id":"other"}, {"stream_id":"old"}, {"kind":"hello"}])
async def test_ack_must_match_current_complete_frame(change):
    owner, socket = Owner(), Socket()
    await socket.hello()
    task = start(owner, socket)
    await socket.ack(await socket.frame(), **change)
    await task
    assert socket.code == 1008


@pytest.mark.parametrize("case", ["expired", "replaced", "gap", "watermark", "base"])
async def test_unusable_cursor_resynchronizes(case):
    owner, socket = Owner(), Socket()
    owner.snapshot.seq = "4"
    owner.replay = Replay(stream_id="stream", seq="4", batches=[], resync=case == "expired")
    if case == "replaced":
        owner.replay.stream_id = owner.snapshot.stream_id = "new"
    elif case == "gap":
        owner.replay.batches = [batch(4)]
    elif case == "base":
        owner.replay.batches = [batch(3, base_revision="0")]
    await socket.hello(stream_id="stream", after="2")
    task = start(owner, socket)
    frame = await socket.frame()
    assert frame["snapshot"]["seq"] == "4" and frame["resync"] == "cursor_unavailable" and not frame["batches"]
    await stop(task, socket)


async def test_valid_resume_uses_batches_then_detects_stream_replacement():
    owner, socket = Owner(), Socket()
    owner.replay = Replay(stream_id="stream", seq="2", batches=[batch(2)])
    await socket.hello(stream_id="stream", after="1")
    task = start(owner, socket)
    frame = await socket.frame()
    assert frame["snapshot"] is None and frame["batches"][0]["seq"] == "2"
    owner.snapshot.stream_id = "replacement"
    owner.replay = Replay(stream_id="replacement", seq="0", batches=[], resync=True)
    await socket.ack(frame)
    frame = await socket.frame()
    assert frame["stream_id"] == "replacement" and frame["snapshot"]
    await stop(task, socket)


async def test_idle_snapshot_refresh_has_ack_and_current_metadata(monkeypatch):
    monkeypatch.setattr(streams, "SNAPSHOT_INTERVAL", 0.01)
    owner, socket = Owner(), Socket()
    await socket.hello()
    task = start(owner, socket)
    await socket.ack(await socket.frame())
    owner.snapshot.state = "frozen"
    frame = await socket.frame()
    assert frame["snapshot"]["state"] == "frozen" and frame["resync"] == "refresh"
    await stop(task, socket)


async def test_duplicate_socket_cannot_replace_or_release_live_binding():
    owner, first, second = Owner(), Socket(), Socket()
    await first.hello()
    task = start(owner, first)
    frame = await first.frame()
    await second.hello()
    await start(owner, second)
    assert second.reason == "binding_in_use"
    assert streams._connections[owner].bindings["binding"] is first
    await first.ack(frame)
    await stop(task, first)
    assert owner not in streams._connections


@pytest.mark.parametrize("case", ["epoch", "detach", "closing"])
async def test_binding_is_revalidated_after_ack(case):
    owner, socket = Owner(), Socket()
    await socket.hello()
    task = start(owner, socket)
    frame = await socket.frame()
    if case == "epoch":
        owner.fence.host_epoch += 1
    elif case == "detach":
        owner.attachments.clear()
    else:
        owner.closing = True
    await socket.ack(frame)
    await task
    assert socket.code == 1008 and socket.output.empty()


@pytest.mark.parametrize("case", ["ack", "send", "peer", "bytes"])
async def test_slow_and_oversized_streams_end_with_bounded_work(case, monkeypatch):
    owner, socket = Owner(), Socket(stall_send=case == "send")
    if case == "bytes":
        monkeypatch.setattr(streams, "MAX_FRAME_BYTES", 5)
    if case == "peer":
        async def blocked(*args, **kwargs):
            await asyncio.Event().wait()
        owner.reader = blocked
    await socket.hello()
    await asyncio.wait_for(start(owner, socket), 0.5)
    assert socket.code == (1009 if case == "bytes" else 1013)
    assert socket.output.qsize() <= 1
    assert owner not in streams._connections


async def test_connection_capacity_counts_prehello(monkeypatch):
    monkeypatch.setattr(streams, "MAX_CONNECTIONS", 1)
    owner, first, second = Owner(), Socket(), Socket()
    task = start(owner, first)
    await asyncio.sleep(0)
    await start(owner, second)
    assert second.code == 1013 and second.reason == "stream_capacity"
    await stop(task, first)


def browser_module():
    return (Path(__file__).parents[2] / "packages/web/src/python-stream.ts").resolve().as_uri()


def browser_apply_batches(snapshot: Snapshot, batches: list[CommitBatch]) -> Snapshot:
    node = shutil.which("node")
    if not node:
        pytest.skip("node unavailable")
    binding = dict(attachment_id="binding", session_id=snapshot.session_id, build_id="test-build")
    frames = [Stream(snapshot=snapshot, stream_id=snapshot.stream_id, binding_id="binding", build_id="test-build")]
    frames.extend(Stream(batches=batches[index:index + 16], stream_id=snapshot.stream_id,
                         binding_id="binding", build_id="test-build") for index in range(0, len(batches), 16))
    script = "import {applyFrame} from " + json.dumps(browser_module()) + ";\n"
    script += "const binding=" + json.dumps(binding) + "; let model=null;\n"
    for frame in frames:
        script += "model=applyFrame(model," + frame.model_dump_json() + ",binding);\n"
    script += "delete model.resolutionCalls; console.log(JSON.stringify(model));"
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stderr[-5000:]
    return Snapshot.model_validate_json(result.stdout)


@pytest.mark.parametrize("completed", [False, True])
async def test_cancel_replay_preserves_existing_result_and_cleanup(tmp_path, completed):
    from test_session_p2 import FENCE, SESSION, Driver, submit

    from amazme_backend.contracts import ToolObservation
    from amazme_backend.session_domain import Failed, QueryTool, ToolInvocation, ToolObserved

    store = SessionStore(tmp_path / "session.sqlite", SESSION, approval_policy="auto", instance="worker")
    await store.initialize()
    await store.fence(FENCE)
    try:
        driver = Driver(store)
        await submit(store, "hello" if completed else "/shell echo ok")
        if completed:
            await driver.drain()
        else:
            tool = await driver.until(ToolInvocation)
            await store.advance(Failed(tool, "lost_reply"))
            query = await driver.next()
            assert isinstance(query, QueryTool)
            await store.advance(ToolObserved(query, ToolObservation(call_id=query.step_id, state="unknown")))
        before = await store.snapshot()
        original = await store.get("root")
        assert original.status == ("succeeded" if completed else "cleaning")
        assert await store.cancel("root", FENCE) == original
        assert await store.cancel("root", FENCE) == original
        replay = await store.events(int(before.seq), before.stream_id)
        actual = browser_apply_batches(before, replay.batches)
        assert next(r for r in actual.requests if r.request_id == "root") == original
        assert actual.pending == before.pending
        assert actual.effects == before.effects
    finally:
        await store.db.close()


@pytest.mark.parametrize("surface", ["snapshot", "replay"])
async def test_nested_children_cannot_evict_root_answer_or_unsettled_work(tmp_path, surface):
    from test_session_p2 import FENCE, SESSION, Driver, submit

    from amazme_backend.session_domain import ModelInvocation, Park
    from amazme_backend.storage import SNAPSHOT_MAX_BYTES, now_ms

    store = SessionStore(tmp_path / "session.sqlite", SESSION, approval_policy="auto", instance="worker")
    await store.initialize()
    await store.fence(FENCE)
    try:
        text = "/delegate " + json.dumps([
            "/delegate " + json.dumps([f"leaf {i}-{j}" for j in range(8)]) for i in range(3)])
        await submit(store, text)
        driver = Driver(store)
        root_models = 0
        for _ in range(100):
            action = await driver.next()
            assert not isinstance(action, Park)
            if isinstance(action, ModelInvocation) and action.request_id == "root":
                root_models += 1
                if root_models == 2:
                    break
            await driver.respond(action)
        else:
            pytest.fail("root never joined its required children")
        pending_ids = {f"scheduled-{i}" for i in range(127)}
        due = now_ms() + 60000
        for identity in sorted(pending_ids):
            await store.accept(Submit(request_id=identity, text="queued", not_before_ms=due), FENCE)
        before = await store.snapshot()
        await driver.respond(action)
        await driver.drain()
        final = await store.get("root")
        assert final.status == "succeeded" and final.answer
        replay = await store.events(int(before.seq), before.stream_id)
        actual = await store.snapshot() if surface == "snapshot" else browser_apply_batches(before, replay.batches)
        assert final in actual.requests
        assert {r.request_id for r in actual.requests if r.status == "waiting_time"} == pending_ids
        assert actual.pending == len(pending_ids)
        assert len([r for r in actual.requests if r.kind == "child"]) <= 20
        assert len(actual.model_dump_json().encode()) <= SNAPSHOT_MAX_BYTES
    finally:
        await store.db.close()


@pytest.mark.parametrize("surface", ["snapshot", "replay"])
async def test_child_history_byte_budget_keeps_unsettled_approval(tmp_path, surface):
    from test_session_p2 import FENCE, SESSION, Driver, submit

    from amazme_backend.contracts import Message
    from amazme_backend.providers import Completion
    from amazme_backend.session_domain import ModelInvocation, ModelReturned, Park
    from amazme_backend.storage import SNAPSHOT_CHILD_BYTES

    store = SessionStore(tmp_path / "session.sqlite", SESSION, approval_policy="mutations", instance="worker")
    await store.initialize()
    await store.fence(FENCE)
    try:
        tasks = [f"leaf-{index}" for index in range(7)] + ["/shell echo wait"]
        await submit(store, "/delegate " + json.dumps(tasks))
        driver = Driver(store)
        before = None
        for _ in range(20):
            action = await driver.next()
            if isinstance(action, Park):
                assert action.reason == "approval"
                break
            if isinstance(action, ModelInvocation) and action.messages[0].content.startswith("leaf-"):
                if action.messages[0].content == "leaf-6":
                    before = await store.snapshot()
                await store.advance(ModelReturned(action, Completion(
                    message=Message(role="assistant", content="界" * 20000), response_id=action.step_id)))
            else:
                await driver.respond(action)
        else:
            pytest.fail("child never reached approval")
        assert before is not None
        replay = await store.events(int(before.seq), before.stream_id)
        actual = await store.snapshot() if surface == "snapshot" else browser_apply_batches(before, replay.batches)
        history = [r for r in actual.requests if r.kind == "child" and r.status == "succeeded"]
        assert 0 < len(history) < 7
        assert sum(len(r.model_dump_json().encode()) for r in history) <= SNAPSHOT_CHILD_BYTES
        root = await store.get("root")
        assert root in actual.requests and root.status == "waiting_children"
        assert any(r.request_id == root.children[-1] and r.status == "waiting_approval" for r in actual.requests)
        assert actual.pending == 2 and actual.approvals[-1].state == "pending"
    finally:
        await store.db.close()


def test_browser_transaction_reducer_uses_real_schema():
    node = shutil.which("node")
    if not node:
        pytest.skip("node unavailable")
    script = "import {applyFrame} from " + json.dumps(browser_module()) + ";\n" + r'''
        import assert from 'node:assert/strict';
        const binding = {attachment_id:'b',session_id:'s',build_id:'build',host_epoch:1};
        const receipt = {request_id:'r',text:'task',status:'waiting_approval',answer:'',error:'',accepted_revision:'1',revision:'1',run_id:'run',parent_id:'',kind:'root',generation:0,cancel_requested:false,decision:null,children:[],not_before_ms:0};
        const snapshot = {session_id:'s',stream_id:'stream',seq:'0',state:'ready',requests:[],events:[],approvals:[],effects:[],previews:[],pending:0,next_wake_ms:0};
        const frame = {snapshot, batches:[],stream_id:'stream',binding_id:'b',build_id:'build',resync:'initial'};
        let model = applyFrame(null,frame,binding);
        const event = {seq:'1',kind:'accepted',request_id:'r',text:'task',receipt,approval:null,preview:null};
        const batch = {stream_id:'stream',seq:'1',base_revision:'0',revision:'1',events:[event]};
        const delta = {...frame,snapshot:null,batches:[batch],resync:''};
        model = applyFrame(model,delta,binding);
        assert.equal(model.pending,1);
        assert.equal(model.requests[0].status,'waiting_approval');
        assert.deepEqual(applyFrame(model,delta,binding),model); // duplicate complete frame
        assert.equal(snapshot.requests.length,0); // reducer never mutates previous state
        const before = structuredClone(model);
        for (const bad of [
            {...delta,binding_id:'old'}, {...delta,build_id:'old'}, {...delta,stream_id:'other'},
            {...delta,batches:[{...batch,seq:'3',revision:'3',base_revision:'2'}]},
            {...delta,batches:[{...batch,base_revision:'9'}]},
            {...delta,batches:[{...batch,events:[{...event,seq:'2'}]}]},
            {...delta,batches:[{...batch,seq:'01'}]},
            {...delta,batches:[{...batch,events:[]}]},
            {...frame,snapshot:{...snapshot,session_id:'other'}}
        ]) assert.throws(()=>applyFrame(model,bad,binding));
        assert.deepEqual(model,before);
        const second = {...batch,seq:'2',revision:'2',base_revision:'1',events:[{...event,seq:'2',receipt:{...receipt,revision:'2',status:'running'}}]};
        const third = {...batch,seq:'4',revision:'4',base_revision:'3'};
        assert.throws(()=>applyFrame(model,{...delta,batches:[second,third]},binding));
        assert.deepEqual(model,before); // later corrupt transaction cannot partially apply the frame
        const preview = {request_id:'r',run_id:'run',generation:0,preview_seq:'1',text:'whole prefix'};
        const previewBatch = {...second,events:[{...event,seq:'2',kind:'preview',receipt:null,preview}]};
        model = applyFrame(model,{...delta,batches:[previewBatch]},binding);
        assert.equal(model.previews[0].text,'whole prefix');
        const staleBatch = {...previewBatch,seq:'3',revision:'3',base_revision:'2',events:[{...event,seq:'3',receipt:null,preview:{...preview,generation:1,text:'stale'}}]};
        model = applyFrame(model,{...delta,batches:[staleBatch]},binding);
        assert.equal(model.previews[0].text,'whole prefix');
        const doneBatch = {...staleBatch,seq:'4',revision:'4',base_revision:'3',events:[{...event,seq:'4',receipt:{...receipt,revision:'4',status:'unknown'},preview:null}]};
        model = applyFrame(model,{...delta,batches:[doneBatch]},binding);
        assert.equal(model.previews.length,0);
        assert.equal(model.pending,0);
        const full = {...snapshot,seq:'5',state:'frozen',pending:42,next_wake_ms:1234,
            requests:Array.from({length:42},(_,i)=>({...receipt,request_id:'p'+i})),
            effects:[{call_id:'c',session_id:'s',request_id:'p0',reason:'unknown',resource_clean:false,reconciled:false}]};
        model = applyFrame(model,{...frame,snapshot:full},binding);
        assert.equal(model.requests.length,42);
        assert.equal(model.effects[0].resource_clean,false);
        assert.equal(model.next_wake_ms,1234);
        assert.equal(model.state,'frozen');
        model = applyFrame(model,{...frame,stream_id:'new',snapshot:{...full,seq:'0',stream_id:'new'}},binding);
        assert.equal(model.stream_id,'new');
        console.log('reducer verified');
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stderr[-5000:]


async def test_maximum_unicode_pending_and_terminal_history_fit_transport(tmp_path, monkeypatch):
    store = SessionStore(tmp_path / "session.sqlite", "session")
    fence = HostFence(host_epoch=1, build_id="test-build")
    await store.initialize()
    await store.fence(fence)
    try:
        text = "\U0001f600" * 16000
        # Build legal historical receipts using the real cancel-before-submit path.
        for index in range(20):
            await store.cancel(f"terminal-{index}", fence)
            await store.accept(Submit(request_id=f"terminal-{index}", text=text), fence)
        for index in range(PENDING_LIMIT):
            await store.accept(Submit(request_id=f"pending-{index}", text=text), fence)
        owner, socket = Owner(), Socket()
        owner.snapshot = await store.snapshot()
        assert len(owner.snapshot.requests) == PENDING_LIMIT + 20
        serialized = Stream(snapshot=owner.snapshot, stream_id=owner.snapshot.stream_id,
                            binding_id="binding", build_id=owner.build).model_dump_json().encode()
        assert len(serialized) > 8 * 1024 * 1024
        assert len(serialized) < streams.MAX_FRAME_BYTES
        monkeypatch.setattr(streams, "ACK_TIMEOUT", 2)
        await socket.hello()
        task = start(owner, socket)
        frame = await socket.frame()
        assert len(frame["snapshot"]["requests"]) == PENDING_LIMIT + 20
        await socket.ack(frame)
        await stop(task, socket)
    finally:
        await store.db.close()


async def test_store_replay_window_matches_stream_batch_limit(tmp_path):
    store = SessionStore(tmp_path / "session.sqlite", "session")
    fence = HostFence(host_epoch=1, build_id="test-build")
    await store.initialize()
    await store.fence(fence)
    try:
        for index in range(32):
            await store.accept(Submit(request_id=f"request-{index}", text="work"), fence)
        snapshot = await store.snapshot()
        replay = await store.events(0, snapshot.stream_id)
        assert len(replay.batches) == streams.MAX_BATCHES
        assert streams.valid_replay(replay, snapshot.stream_id, 0)
    finally:
        await store.db.close()
