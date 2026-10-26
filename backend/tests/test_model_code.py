"""Model scripts are parked while their ordinary child tools obtain approvals."""
import json

from amazme_backend.contracts import CodeChild, CodeStatus, CodeView, HostFence, Submit, ToolCall
from amazme_backend.sessions.maintenance import read_settled_root
from amazme_backend.sessions.service import SessionStore
from amazme_backend.sessions.types import CodeRetrieval, CodeReturned, Continue


async def action(store):
    for _ in range(20):
        value = await store.advance()
        if not isinstance(value, Continue):
            return value
    raise AssertionError("no observable action")


async def test_model_script_keeps_original_identity_state_and_child_approval(tmp_path):
    store = SessionStore(tmp_path / "session.sqlite", "a" * 32)
    await store.initialize()
    fence = HostFence(host_epoch=1, build_id="test-build")
    await store.fence(fence)
    try:
        await store.accept(Submit(request_id="script", text="run", tool_call=ToolCall(
            id="code", name="codemode", arguments=json.dumps({"code": 'store("k", 2);'}))), fence)
        original = await action(store)
        assert isinstance(original, CodeRetrieval) and original.start
        retry = await action(store)
        assert retry == original
        child = CodeChild(parent_request_id=original.request_id, parent_step_id=original.step_id,
                          request_id="child", call=ToolCall(id="write", name="write_file", arguments='{"path":"once.txt","content":"x"}'))
        first = await store.accept_code_tool(child)
        assert (await store.accept_code_tool(child)).request_id == first.request_id
        await store.advance(CodeReturned(original, CodeStatus(view=CodeView(run_id=original.step_id[:32], phase="unknown"), running=True)))
        await action(store)
        snapshot = await store.snapshot()
        assert len(snapshot.approvals) == 1 and snapshot.approvals[0].request_id == "child"
        assert not (tmp_path / "once.txt").exists()
    finally:
        await store.close()


async def test_script_state_is_part_of_the_selected_branch_point(tmp_path):
    path = tmp_path / "session.sqlite"
    store = SessionStore(path, "a" * 32)
    await store.initialize()
    fence = HostFence(host_epoch=1, build_id="test-build")
    await store.fence(fence)
    try:
        for index in (1, 2):
            await store.accept(Submit(request_id=f"r{index}", text="run", tool_call=ToolCall(
                id=f"code{index}", name="codemode", arguments='{"code":"return 1;"}')), fence)
            started = await action(store)
            assert isinstance(started, CodeRetrieval)
            assert json.loads(started.initial_state) == ({} if index == 1 else {"k": 1})
            await store.advance(CodeReturned(started, CodeStatus(view=CodeView(run_id=started.step_id[:32], phase="success", clean=True,
                state=json.dumps({"k": index}), value="1"), running=False)))
            for _ in range(10):
                await store.advance()
                if next(item for item in (await store.snapshot()).requests if item.request_id == f"r{index}").status == "succeeded":
                    break
        copied = read_settled_root(path, "r1")
        assert json.loads(json.loads(copied[3])["codemode_state"]) == {"k": 1}
    finally:
        await store.close()
