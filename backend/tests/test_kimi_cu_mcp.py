"""KimiCU global stdio MCP configuration, screenshot observation, and live catalog check."""

from __future__ import annotations

import asyncio
import json
import shlex
import sqlite3
import sys
from pathlib import Path

import httpx
import pytest
from test_client import _serve, _stop
from test_management import _host

import amazme_backend.host.integrations as host_integrations
import amazme_backend.interfaces.cli as client_cmd
from amazme_backend.agent.driver import Worker
from amazme_backend.agent.model import model_request, model_spec, stream
from amazme_backend.ai.providers.completions import provider_messages, tool_parameters
from amazme_backend.ai.types import Auth
from amazme_backend.bootstrap.supervisor import create_supervisor
from amazme_backend.contracts import (
    HostFence,
    ImagePart,
    McpCallRef,
    McpCallRequest,
    McpConfigPatch,
    McpDecision,
    McpOpen,
    McpState,
    McpToolCall,
    McpView,
    OpenMcp,
    ProcessLease,
    ProviderConfig,
    Submit,
    ToolCall,
)
from amazme_backend.contracts.mcp import (
    McpStdioSettings,
    catalog_payload,
    offers_from_views,
)
from amazme_backend.execution.supervisor import Supervisor
from amazme_backend.interfaces.http.application import application
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.profile import Profile
from amazme_backend.sdk import Client
from amazme_backend.sessions.service import SessionStore
from amazme_backend.sessions.types import (
    Completion,
    McpRetrieval,
    ModelInvocation,
    ModelReturned,
)

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

APP_STATE_SERVER = """
import json, sys

PNG = sys.argv[1]
LONG_DESC = "D" * 2400
LONG_TEXT = "S" * 10000

def send(identity, result):
    print(json.dumps({"jsonrpc": "2.0", "id": identity, "result": result}), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    identity = message.get("id")
    if method == "initialize":
        send(identity, {
            "protocolVersion": message["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "kimi-cu-double", "version": "0.6.8"},
        })
    elif method == "tools/list":
        send(identity, {
            "tools": [
                {"name": "get_app_state", "description": LONG_DESC, "inputSchema": {"type": "object"}},
                {"name": "click", "description": "Click point", "inputSchema": {"type": "object"}},
            ]
        })
    elif method == "tools/call":
        send(identity, {
            "content": [
                {"type": "text", "text": LONG_TEXT},
                {"type": "image", "mimeType": "image/png", "data": PNG},
            ],
            "isError": False,
        })
"""


def _executable_file(path: Path) -> Path:
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(0o755)
    return path


async def test_add_kimi_cu_missing_binary_and_linux_write_nothing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    host_dir = tmp_path / "host-profile"
    host_dir.mkdir()
    host = _host(host_dir)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(
        host.lifecycle.instance,
        host.lifecycle.build,
        ProcessLease(
            instance_id="host",
            role="host",
            profile_path=str(host_dir),
            path=str(host_dir / "lease"),
            device=1,
            inode=1,
        ),
    )

    def local_client(url: str, token: str) -> Client:
        instance = Client(url, token)
        instance._http = httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=url)
        return instance

    monkeypatch.setattr(client_cmd, "Client", local_client)
    base = ["--url", host.origin, "--token", "web-only", "mcp", "add-kimi-cu"]
    fake_bin = _executable_file(tmp_path / "fake-kimi-cu")
    try:
        missing_code = await client_cmd._run(
            base,
            platform_name="darwin",
            kimi_cu_binary=tmp_path / "missing-kimi-cu",
        )
        captured = capsys.readouterr()
        assert missing_code == 1
        assert captured.out == client_cmd.KIMI_CU_INSTALL_COMMAND + "\n"
        assert captured.err == ""

        linux_code = await client_cmd._run(
            base,
            platform_name="linux",
            kimi_cu_binary=fake_bin,
        )
        linux_captured = capsys.readouterr()
        assert linux_code == 1
        assert linux_captured.out == ""
        assert linux_captured.err.strip() == "unsupported_platform"

        async with local_client(host.origin, "web-only") as client:
            assert (await client.mcp_configuration("")).servers == []
    finally:
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


async def test_session_starts_and_completes_without_kimi_cu_configured(tmp_path: Path) -> None:
    proc, url, profile = _serve(tmp_path)
    try:
        async with Client(url, (profile / "web.token").read_text().strip()) as client:
            assert (await client.mcp_configuration("")).servers == []
            session = await client.create_session(title="No KimiCU", workspace="primary")
            attachment = await client.attach(session.session_id)
            try:
                receipt = await client.submit(
                    session_id=session.session_id,
                    workspace="primary",
                    attachment_id=attachment.attachment_id,
                    request_id="req-no-kimi",
                    text="hello",
                )
                done = await client.wait(session_id=session.session_id, request_id=receipt.request_id)
                assert done.status == "succeeded"
            finally:
                await client.release(session_id=session.session_id, attachment_id=attachment.attachment_id)
    finally:
        await asyncio.to_thread(_stop, proc, profile)


async def test_add_kimi_cu_writes_global_direct_stdio_entry_idempotently(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    host_dir = tmp_path / "host-profile"
    host_dir.mkdir()
    host = _host(host_dir)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(
        host.lifecycle.instance,
        host.lifecycle.build,
        ProcessLease(
            instance_id="host",
            role="host",
            profile_path=str(host_dir),
            path=str(host_dir / "lease"),
            device=1,
            inode=1,
        ),
    )

    def local_client(url: str, token: str) -> Client:
        instance = Client(url, token)
        instance._http = httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=url)
        return instance

    monkeypatch.setattr(client_cmd, "Client", local_client)
    base = ["--url", host.origin, "--token", "web-only", "mcp", "add-kimi-cu"]
    fake_bin = _executable_file(tmp_path / "fake-kimi-cu")
    try:
        assert await client_cmd._run(base, platform_name="darwin", kimi_cu_binary=fake_bin) == 0
        first = json.loads(capsys.readouterr().out)
        assert first["revision"] == 1
        assert len(first["servers"]) == 1
        entry = first["servers"][0]
        assert entry["name"] == "kimi-cu"
        assert entry["scope"] == "global"
        assert entry["enabled"] is True
        assert entry["exposure"] == "direct"
        assert entry["detail"] == "/Applications/KimiCU.app/Contents/MacOS/kimi-cu mcp -s user"

        with sqlite3.connect(host_dir / "host.sqlite") as db:
            row = db.execute(
                "SELECT payload FROM mcp_configuration WHERE workspace='' AND name='kimi-cu'"
            ).fetchone()
        assert row is not None
        stored = McpStdioSettings.model_validate_json(row[0])
        assert stored.enabled is True
        assert stored.exposure == "direct"
        assert stored.command == "/Applications/KimiCU.app/Contents/MacOS/kimi-cu"
        assert stored.args == ["mcp", "-s", "user"]

        assert await client_cmd._run(base, platform_name="darwin", kimi_cu_binary=fake_bin) == 0
        second = json.loads(capsys.readouterr().out)
        assert second == first

        async with local_client(host.origin, "web-only") as client:
            await client.change_mcp_configuration(
                "",
                "",
                "",
                McpConfigPatch(
                    operation_id="a" * 32,
                    expected_revision=1,
                    name="kimi-cu",
                    enabled=False,
                ),
            )
        assert await client_cmd._run(base, platform_name="darwin", kimi_cu_binary=fake_bin) == 0
        restored = json.loads(capsys.readouterr().out)
        assert len(restored["servers"]) == 1
        assert restored["servers"][0]["config_id"] == entry["config_id"]
        assert restored["servers"][0]["enabled"] is True
        assert restored["servers"][0]["exposure"] == "direct"

        opened: list[McpOpen] = []

        async def fake_mcp_state(_session_id: str) -> McpState:
            return McpState(servers=[], calls=[])

        async def fake_open_mcp(_session_id: str, value: McpOpen) -> McpView:
            opened.append(value)
            return McpView(
                server_id=value.server_id,
                name=value.name,
                managed_id=value.managed_id,
                phase="ready",
                clean=False,
                command=value.command,
                tools=[],
            )

        monkeypatch.setattr(host.integrations, "mcp_state", fake_mcp_state)
        monkeypatch.setattr(host.integrations, "open_mcp", fake_open_mcp)
        async with local_client(host.origin, "web-only") as client:
            session = await client.create_session(title="Uninstalled KimiCU", workspace="primary")
            monkeypatch.setattr(host_integrations, "KIMI_CU_BINARY", tmp_path / "uninstalled-kimi-cu")
            monkeypatch.setattr(host_integrations.sys, "platform", "darwin")
            state = await host.integrations.sync_mcp_configuration(session.session_id)
            assert state.servers == []
            assert opened == []

            monkeypatch.setattr(host_integrations, "KIMI_CU_BINARY", fake_bin)
            monkeypatch.setattr(host_integrations.sys, "platform", "linux")
            await host.integrations.sync_mcp_configuration(session.session_id)
            assert opened == []

            monkeypatch.setattr(host_integrations.sys, "platform", "darwin")
            await host.integrations.sync_mcp_configuration(session.session_id)
            assert len(opened) == 1
            assert opened[0].name == "kimi-cu"
            assert opened[0].managed_id == entry["config_id"]
            assert opened[0].command == "/Applications/KimiCU.app/Contents/MacOS/kimi-cu mcp -s user"
    finally:
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


async def _local_supervisor(root: Path, session_id: str) -> Supervisor:
    private_write(
        root / "config.json",
        json.dumps(
            {
                "format": 2,
                "profile_id": "kimi-cu-test",
                "workspace": str(root),
                "resources": "unused",
                "provider": {"provider": "faux"},
            }
        ),
    )
    private_write(root / "control.token", "token")
    with sqlite3.connect(root / "host.sqlite") as db:
        db.execute(
            "CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0)"
        )
        db.execute("INSERT INTO sessions(id,workspace) VALUES(?,'primary')", (session_id,))
    owner = create_supervisor(Profile(root), "kimi-cu-supervisor")
    await owner.initialize()
    if owner.monitor_task:
        owner.monitor_task.cancel()
        await asyncio.gather(owner.monitor_task, return_exceptions=True)
        owner.monitor_task = None
    return owner


async def test_get_app_state_screenshot_survives_gate_text_truncation_to_model(
    tmp_path: Path,
) -> None:
    session_id = "a" * 32
    server_id = "b" * 32
    owner = await _local_supervisor(tmp_path, session_id)
    script = tmp_path / "kimi_cu_double.py"
    script.write_text(APP_STATE_SERVER)
    fence = HostFence(host_epoch=owner.host_epoch, build_id=owner.build)
    session_dir = tmp_path / "session-dir"
    session_dir.mkdir()
    store = SessionStore(session_dir / "session.sqlite", session_id, approval_policy="auto", instance="worker")
    await store.initialize()
    store_fence = HostFence(host_epoch=1, build_id="test-build")
    await store.fence(store_fence)
    try:
        view = await owner.mcp.open(
            OpenMcp(
                host_epoch=fence.host_epoch,
                build_id=fence.build_id,
                session_id=session_id,
                server_id=server_id,
                command=f"{shlex.quote(sys.executable)} {shlex.quote(str(script))} {shlex.quote(PNG)}",
                workspace="primary",
            )
        )
        assert view.phase == "ready"
        app_state_tool = next(tool for tool in view.tools if tool.name == "get_app_state")
        assert len(app_state_tool.description) == 2000

        offers = [
            offer.model_copy(update={"active": offer.exposure == "direct"})
            for offer in offers_from_views([view], surface="model")
        ]
        assert {offer.name for offer in offers} == {"get_app_state", "click"}
        assert all(offer.active for offer in offers)
        model_tools = tool_parameters(model_request(ProviderConfig(provider="deepseek"), [], offers, auth=Auth()))
        chosen = next(offer for offer in offers if offer.name == "get_app_state")
        assert any(item["function"]["name"] == chosen.alias for item in model_tools)

        call = await owner.mcp.request_call(
            session_id,
            server_id,
            McpCallRequest(
                call_id="c" * 32,
                name="get_app_state",
                arguments={},
                schema_digest=chosen.schema_digest,
                origin="model",
            ),
            fence,
        )
        decided = await owner.mcp.decide_call(
            session_id,
            server_id,
            call.call_id,
            McpDecision(
                decision_id="d" * 32,
                approve=True,
                digest=call.digest,
            ),
            fence,
        )
        for _ in range(60):
            if decided.phase == "done":
                break
            await asyncio.sleep(0.05)
            decided = await owner.mcp.lookup_call(
                McpCallRef(
                    host_epoch=fence.host_epoch,
                    build_id=fence.build_id,
                    session_id=session_id,
                    server_id=server_id,
                    call_id=call.call_id,
                )
            )
        assert decided.phase == "done"
        assert len(decided.result) == 8000

        action = McpRetrieval(
            step_id="c" * 32,
            request_id="root",
            generation=1,
            call=ToolCall(
                id="call-1",
                name="mcp_tool",
                arguments=McpToolCall(
                    server_id=server_id,
                    tool="get_app_state",
                    workspace="primary",
                    command=view.command,
                    schema_digest=chosen.schema_digest,
                    call_id="c" * 32,
                    arguments={},
                ).model_dump_json(),
            ),
        )
        observed = Worker._mcp_observation(object(), action, decided)  # type: ignore[arg-type]
        expected_image = ImagePart(media_type="image/png", data_base64=PNG)
        assert observed.phase == "done"
        assert observed.images == [expected_image]

        prompt = "/mcp " + json.dumps({"alias": chosen.alias, "arguments": {}}, ensure_ascii=False)
        await store.accept(Submit(request_id="root", text=prompt), store_fence)
        first_turn = None
        for _ in range(12):
            candidate = await store.advance()
            if isinstance(candidate, ModelInvocation):
                first_turn = candidate
                break
        assert first_turn is not None
        await store.bind_model_tools(first_turn.step_id, first_turn.generation, catalog_payload([chosen]))
        completions = [
            item
            async for item in stream(first_turn.config, first_turn.messages, auth=Auth())
            if isinstance(item, Completion)
        ]
        await store.advance(ModelReturned(first_turn, completions[0]))
        retrieval = None
        for _ in range(12):
            candidate = await store.advance()
            if isinstance(candidate, McpRetrieval):
                retrieval = candidate
                break
        assert retrieval is not None
        rebound = Worker._mcp_observation(object(), retrieval, decided)  # type: ignore[arg-type]
        await store.advance(rebound)
        next_turn = None
        for _ in range(12):
            candidate = await store.advance()
            if isinstance(candidate, ModelInvocation):
                next_turn = candidate
                break
        assert next_turn is not None
        tool_msg = next(msg for msg in next_turn.messages if msg.role == "tool")
        assert tool_msg.images == [expected_image]
        serialized = provider_messages(
            model_spec(ProviderConfig(provider="deepseek")),
            model_request(ProviderConfig(provider="deepseek"), next_turn.messages, auth=Auth()),
        )
        assert f"data:image/png;base64,{PNG}" in json.dumps(serialized)
    finally:
        await store.close()
        await owner.close()


async def test_live_installed_kimi_cu_completes_initialize_and_lists_tools(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    binary = Path(client_cmd.KIMI_CU_COMMAND)
    if sys.platform != "darwin" or not binary.is_file():
        pytest.skip("KimiCU binary not installed on this machine")
    proc, url, profile = _serve(tmp_path)
    token = (profile / "web.token").read_text().strip()
    try:
        code = await client_cmd._run(["--url", url, "--token", token, "mcp", "add-kimi-cu"])
        assert code == 0
        configured = json.loads(capsys.readouterr().out)
        assert [item["name"] for item in configured["servers"]] == ["kimi-cu"]

        async with Client(url, token) as client:
            session = await client.create_session(title="KimiCU Live", workspace="primary")
            attachment = await client.attach(session.session_id)
            try:
                await client.snapshot(session.session_id)
                state = await client.mcp_state(session.session_id)
                kimi_server = next((srv for srv in state.servers if srv.name == "kimi-cu"), None)
                assert kimi_server is not None
                assert kimi_server.phase == "ready"
                assert kimi_server.enabled is True
                assert kimi_server.exposure == "direct"
                tool_names = {tool.name for tool in kimi_server.tools}
                assert {"get_app_state", "click"} <= tool_names
                assert len(kimi_server.tools) <= 64
                direct_offers = offers_from_views([kimi_server], surface="model")
                assert {"get_app_state", "click"} <= {offer.name for offer in direct_offers}
            finally:
                await client.release(session_id=session.session_id, attachment_id=attachment.attachment_id)
    finally:
        await asyncio.to_thread(_stop, proc, profile)
