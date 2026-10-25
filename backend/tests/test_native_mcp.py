import asyncio
import shlex
import sys

import pytest
import test_native_terminal as fixtures

from amazme_backend.contracts import (
    BackendError,
    HostFence,
    McpCallRequest,
    McpDecision,
    McpQuery,
    McpSession,
    OpenMcp,
)
from amazme_backend.mcp_session import schema_digest

terminal_owner = fixtures.terminal_owner

SERVER = '''
import json,os,sys,time
marker=sys.argv[1]
def send(identity,result):
    print(json.dumps({'jsonrpc':'2.0','id':identity,'result':result}),flush=True)
for line in sys.stdin:
    message=json.loads(line); method=message.get('method'); identity=message.get('id')
    if method=='initialize':
        send(identity,{'protocolVersion':message['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'native-test','version':'1'}})
    elif method=='tools/list':
        if 'cursor' not in message.get('params',{}):
            send(identity,{'tools':[{'name':'demo.echo','description':'Echo JSON','inputSchema':{'type':'object'}}],'nextCursor':'page2'})
        else:
            send(identity,{'tools':[{'name':'demo.slow','inputSchema':{'type':'object'}},{'name':'demo.fail','inputSchema':{'type':'object'}}]})
    elif method=='tools/call':
        args=message['params']['arguments']; name=message['params']['name']
        with open(marker,'a') as output: output.write('x')
        if name=='demo.slow': time.sleep(args.get('seconds',2.3))
        send(identity,{'content':[{'type':'text','text':'first'},{'type':'text','text':'second'}],
            'structuredContent':{'arguments':args,'cwd':os.getcwd(),'private_env':os.getenv('AMAZME_PRIVATE_TEST_KEY','absent')},'isError':name=='demo.fail'})
'''


def fence(owner):
    return HostFence(build_id=owner.build, host_epoch=owner.host_epoch)


def query(owner):
    return McpQuery(**fence(owner).model_dump(), session_id="a" * 32, server_id="d" * 32)


async def open_server(owner):
    script = owner.profile.path / "service.py"
    script.write_text(SERVER)
    command = f"{shlex.quote(sys.executable)} {shlex.quote(str(script))} calls.txt"
    value = OpenMcp(**query(owner).model_dump(), command=command, workspace="primary")
    return value, await owner.open_mcp(value)


async def state(owner):
    return await owner.mcp_state(McpSession(**fence(owner).model_dump(), session_id="a" * 32))


async def test_mcp_launch_pins_explicit_environment_and_working_directory_without_publishing_values(terminal_owner):
    owner = terminal_owner
    script = owner.profile.path / "configured.py"
    script.write_text(SERVER.replace("'private_env':os.getenv('AMAZME_PRIVATE_TEST_KEY','absent')",
        "'private_env':os.getenv('AMAZME_PRIVATE_TEST_KEY','absent'),'explicit':os.getenv('LOCAL_MCP_TOKEN','absent')"))
    (owner.profile.path / "nested").mkdir()
    value = OpenMcp(**query(owner).model_dump(), command=f"{shlex.quote(sys.executable)} {shlex.quote(str(script))} calls.txt",
                    cwd="nested", environment={"LOCAL_MCP_TOKEN": "explicit-token", "LOCAL_MCP_SECOND": "ok"})
    opened = await owner.open_mcp(value)
    assert "explicit-token" not in opened.model_dump_json()
    assert await owner.open_mcp(value.model_copy(update={"workspace": "primary", "environment": dict(reversed(list(value.environment.items())))})) == opened
    for changes in ({"cwd": "."}, {"environment": {"LOCAL_MCP_TOKEN": "changed"}}):
        with pytest.raises(BackendError, match="mcp_server_conflict"):
            await owner.open_mcp(value.model_copy(update=changes))
    call = await proposal(owner)
    await approve(owner, call)
    result = await completed(owner, call.call_id)
    assert result.result_data["structuredContent"]["explicit"] == "explicit-token"
    assert result.result_data["structuredContent"]["cwd"] == str(owner.profile.path / "nested")
    assert (owner.profile.path / "nested/calls.txt").read_text() == "x"
    assert not (owner.profile.path / "calls.txt").exists()


async def proposal(owner, identity="e" * 32, name="demo.echo", arguments=None):
    return await owner.request_mcp_call("a" * 32, "d" * 32,
        McpCallRequest(call_id=identity, name=name, arguments=arguments or {}), fence(owner))


async def approve(owner, call, **updates):
    decision = McpDecision(decision_id="approve-" + call.call_id, approve=True, digest=call.digest).model_copy(update=updates)
    return await owner.decide_mcp_call("a" * 32, "d" * 32, call.call_id, decision, fence(owner))


async def completed(owner, identity):
    for _ in range(60):
        current = next(c for c in (await state(owner)).calls if c.call_id == identity)
        if current.phase == "done":
            return current
        await asyncio.sleep(.05)
    raise AssertionError(current.phase)


async def test_native_mcp_catalog_approval_json_result_and_retry(terminal_owner, monkeypatch):
    owner = terminal_owner
    monkeypatch.setenv("AMAZME_PRIVATE_TEST_KEY", "never-forward")
    value, server = await open_server(owner)
    assert server.phase == "ready" and server.protocol_version == "2025-11-25"
    assert [t.name for t in server.tools] == ["demo.echo", "demo.slow", "demo.fail"]
    assert server.tools[0].input_schema == {"type": "object"}
    assert (await owner.open_mcp(value)).server_id == server.server_id
    args = {"nested": [True, None, 3, {"text": "中文"}]}
    call = await proposal(owner, arguments=args)
    assert call.phase == "waiting_approval" and call.arguments == args
    assert not (owner.profile.path / "calls.txt").exists()
    with pytest.raises(BackendError, match="mcp_call_conflict"):
        await approve(owner, call, digest="0" * 64)
    await approve(owner, call)
    result = await completed(owner, call.call_id)
    assert result.result == "first\nsecond" and not result.is_error
    assert result.result_data["structuredContent"] == {"arguments": args, "cwd": str(owner.profile.path), "private_env": "absent"}
    assert (await approve(owner, call)).phase == "done"
    assert (await proposal(owner, arguments=args)).phase == "done"
    assert (owner.profile.path / "calls.txt").read_text() == "x"
    with pytest.raises(BackendError, match="mcp_call_conflict"):
        await proposal(owner, arguments={"different": True})
    await owner.cleanup("a" * 32)
    assert (await state(owner)).servers[0].phase == "ready"
    with pytest.raises(BackendError, match="mcp_not_found"):
        await owner.cancel_mcp(query(owner).model_copy(update={"session_id": "f" * 32}))
    with pytest.raises(BackendError, match="stale_host_epoch"):
        await owner.cancel_mcp(query(owner).model_copy(update={"host_epoch": 99}))
    closed = await owner.cancel_mcp(query(owner))
    assert closed.clean and closed.phase == "exited"


async def test_mcp_slow_response_remains_running_and_late_result_is_queryable(terminal_owner):
    owner = terminal_owner
    await open_server(owner)
    call = await proposal(owner, name="demo.slow")
    assert (await approve(owner, call)).phase == "running"
    assert (await completed(owner, call.call_id)).phase == "done"
    failed = await proposal(owner, identity="f" * 32, name="demo.fail")
    await approve(owner, failed)
    assert (await completed(owner, failed.call_id)).is_error


async def test_mcp_stop_keeps_inflight_effect_unknown_and_never_replays(terminal_owner):
    owner = terminal_owner
    value, _ = await open_server(owner)
    call = await proposal(owner, name="demo.slow", arguments={"seconds": 60})
    assert (await approve(owner, call)).phase == "running"
    closed = await owner.cancel_mcp(query(owner))
    assert closed.clean and closed.phase == "exited"
    assert (await approve(owner, call)).phase == "unknown"
    assert (await owner.open_mcp(value)).phase == "exited"
    assert (owner.profile.path / "calls.txt").read_text() == "x"


async def test_mcp_denial_and_storage_failure_do_not_leak_service(terminal_owner):
    owner = terminal_owner
    await open_server(owner)
    call = await proposal(owner)
    assert (await approve(owner, call, approve=False)).phase == "denied"
    assert not (owner.profile.path / "calls.txt").exists()
    process = owner.mcp_processes["d" * 32]
    owner.db.path.unlink()
    with pytest.raises(BackendError):
        await owner.health()
    await owner.close()
    assert process.process.returncode is not None


REFRESH = '''
import json,sys,threading,time
marker,mode=sys.argv[1],sys.argv[2]
listed=0
def send(identity,result):
    print(json.dumps({"jsonrpc":"2.0","id":identity,"result":result}),flush=True)
def changed():
    print(json.dumps({"jsonrpc":"2.0","method":"notifications/tools/list_changed"}),flush=True)
for line in sys.stdin:
    message=json.loads(line); method=message.get("method"); identity=message.get("id")
    if method=="initialize":
        send(identity,{"protocolVersion":message["params"]["protocolVersion"],"capabilities":{"tools":{"listChanged":True}},"serverInfo":{"name":"refresh","version":"1"}})
    elif method=="tools/list":
        listed+=1
        if listed==1:
            name="demo.slow" if mode=="after-call" else "demo.echo"
            send(identity,{"tools":[{"name":name,"inputSchema":{"type":"object"}}]})
            if mode!="after-call":
                threading.Thread(target=lambda: (time.sleep(0.6), changed()), daemon=True).start()
        elif mode=="fail":
            open(marker+".note","w").write("refresh-failed\\n")
            print(json.dumps({"jsonrpc":"2.0","id":identity,"error":{"code":-32000,"message":"list failed"}}),flush=True)
        elif mode=="after-call":
            send(identity,{"tools":[{"name":"demo.slow","inputSchema":{"type":"object"}},{"name":"demo.added","inputSchema":{"type":"object"}}]})
        else:
            send(identity,{"tools":[{"name":"demo.echo","inputSchema":{"type":"object","additionalProperties":False}},{"name":"demo.added","inputSchema":{"type":"object"}}]})
    elif method=="tools/call":
        open(marker,"a").write("x")
        if mode=="after-call": time.sleep(0.4)
        send(identity,{"content":[{"type":"text","text":"ok"}]})
        if mode=="after-call": changed()
'''


async def open_refresh(owner, mode):
    script = owner.profile.path / "refresh.py"
    script.write_text(REFRESH)
    marker = owner.profile.path / "calls.txt"
    command = f"{shlex.quote(sys.executable)} {shlex.quote(str(script))} {shlex.quote(str(marker))} {mode}"
    value = OpenMcp(**query(owner).model_dump(), command=command, workspace="primary")
    return marker, await owner.open_mcp(value)


async def test_mcp_list_changed_replaces_catalog_without_replaying(terminal_owner):
    owner = terminal_owner
    marker, server = await open_refresh(owner, "refresh")
    assert [tool.name for tool in server.tools] == ["demo.echo"]
    call = await owner.request_mcp_call("a" * 32, "d" * 32, McpCallRequest(
        call_id="e" * 32, name="demo.echo", schema_digest=schema_digest({"type": "object"})), fence(owner))
    current = server
    for _ in range(50):
        current = (await state(owner)).servers[0]
        if any(tool.name == "demo.added" for tool in current.tools):
            break
        await asyncio.sleep(0.05)
    echo = next(tool for tool in current.tools if tool.name == "demo.echo")
    assert echo.input_schema["additionalProperties"] is False
    assert (await approve(owner, call)).phase == "conflict"
    assert not marker.exists()
    added = await proposal(owner, identity="f" * 32, name="demo.added")
    await approve(owner, added)
    assert (await completed(owner, added.call_id)).result == "ok"
    assert marker.read_text() == "x"
    assert (await proposal(owner, identity="f" * 32, name="demo.added")).phase == "done"
    assert marker.read_text() == "x"


async def test_mcp_failed_refresh_keeps_the_last_catalog(terminal_owner):
    owner = terminal_owner
    marker, server = await open_refresh(owner, "fail")
    assert [tool.name for tool in server.tools] == ["demo.echo"]
    call = await owner.request_mcp_call("a" * 32, "d" * 32, McpCallRequest(
        call_id="e" * 32, name="demo.echo", schema_digest=schema_digest({"type": "object"})), fence(owner))
    note = owner.profile.path / "calls.txt.note"
    for _ in range(50):
        if note.exists():
            break
        await asyncio.sleep(0.05)
    assert note.read_text() == "refresh-failed\n"
    for _ in range(10):
        await state(owner)
        await asyncio.sleep(0.05)
    with pytest.raises(BackendError, match="mcp_catalog_stale"):
        await proposal(owner, identity="1" * 32, name="demo.added")
    with pytest.raises(BackendError, match="mcp_catalog_stale"):
        await approve(owner, call)
    assert next(item for item in (await state(owner)).calls if item.call_id == call.call_id).phase == "waiting_approval"
    assert (await approve(owner, call, approve=False)).phase == "denied"
    assert not marker.exists()
    listed = (await state(owner)).servers[0]
    assert listed.phase == "ready" and [tool.name for tool in listed.tools] == ["demo.echo"]
    assert owner.mcp_processes["d" * 32].process.returncode is None


async def test_mcp_refresh_after_a_call_does_not_replay_it(terminal_owner):
    owner = terminal_owner
    marker, server = await open_refresh(owner, "after-call")
    assert [tool.name for tool in server.tools] == ["demo.slow"]
    call = await proposal(owner, name="demo.slow")
    await approve(owner, call)
    for _ in range(50):
        view = await state(owner)
        names = [tool.name for tool in view.servers[0].tools]
        phase = next(item.phase for item in view.calls if item.call_id == call.call_id)
        if "demo.added" in names and phase == "done":
            break
        await asyncio.sleep(0.05)
    assert marker.read_text() == "x"
    assert (await proposal(owner, name="demo.slow")).phase == "done"
    assert marker.read_text() == "x"
