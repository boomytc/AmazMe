"""Configured stdio uses the original gate, approvals, scope and stable reconnect identities."""

import asyncio
import json
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError
from test_client import _serve, _stop
from test_native_mcp import SERVER

from amazme_backend.contracts import (
    BackendError,
    McpConfigPatch,
    McpConfigWrite,
    McpReconnect,
    McpStdioSettings,
    McpTool,
    McpView,
    WorkspaceGrantRequest,
)
from amazme_backend.contracts.mcp import exposure, offers_from_views
from amazme_backend.host.persistence.mcp import Configured, launch
from amazme_backend.sdk import Client


def test_configuration_references_and_exposure_follow_original_rules(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MCP_EXPLICIT_VALUE", "key")
    value = Configured(config_id="a" * 32, launch_id="b" * 32, name="one", overridden=False,
        settings=McpStdioSettings(command="python3", env={"TOKEN": "prefix-${MCP_EXPLICIT_VALUE}_$MCP_EXPLICIT_VALUE", "ESCAPED": "$$MCP_EXPLICIT_VALUE $!literal", "COMMAND": "!printf secret"}))
    resolved = launch(value, "primary")
    assert resolved.environment == {"TOKEN": "prefix-key_key", "ESCAPED": "$MCP_EXPLICIT_VALUE !literal"}
    assert resolved.environment_commands == {"COMMAND": "printf secret"}
    monkeypatch.delenv("MCP_EXPLICIT_VALUE")
    with pytest.raises(BackendError) as missing:
        launch(value, "primary")
    assert missing.value.code == "mcp_env_missing"
    assert exposure("hidden", {"read*": "codemode", "read_file": "direct"}, "read_file") == "direct"
    assert exposure("hidden", {"read*": "codemode"}, "read_one") == "codemode"
    assert exposure("hidden", {"read?*": "direct"}, "read_one") == "hidden"
    with pytest.raises(ValidationError):
        McpStdioSettings(command="python3", env={"AMAZME_CONTROL_TOKEN": "not-allowed"})
    with pytest.raises(ValidationError):
        McpStdioSettings(command="python3", args=["bad\x00argument"])

    server = McpView(server_id="a" * 32, phase="ready", clean=False, command="server", exposure="hidden",
        tool_exposure={"read*": "codemode", "read_file": "direct"}, tools=[McpTool(name=name) for name in ("read_file", "read_one", "secret")])
    assert [offer.name for offer in offers_from_views([server])] == ["read_file"]
    assert [offer.name for offer in offers_from_views([server], surface="code")] == ["read_file", "read_one"]
    assert not offers_from_views([server.model_copy(update={"enabled": False})], surface="code")


async def test_configuration_revisions_overrides_and_receipts_survive_reopen(tmp_path: Path) -> None:
    import amazme_backend.host.persistence.mcp as mcp_management
    from amazme_backend.contracts import ProcessLease
    from amazme_backend.host.store import HostStore

    path = tmp_path / "host.sqlite"
    store = HostStore(path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path), path=str(tmp_path / "lease"), device=1, inode=1)
    await store.initialize("host", "build", lease)
    first = McpConfigWrite(operation_id="a" * 32, expected_revision=0, name="local-tools", entry=McpStdioSettings(command="python3", env={"TOKEN": "kept-private"}))
    try:
        saved = await store.transaction(lambda db: mcp_management.change(db, first, "primary", path))
        assert saved.servers[0].exposure == "codemode" and "kept-private" not in saved.model_dump_json()
        project = McpConfigPatch(operation_id="b" * 32, expected_revision=1, name=first.name, scope="project", enabled=False)
        await store.transaction(lambda db: mcp_management.change(db, project, "docs", path))
        with pytest.raises(BackendError, match="mcp_config_revision"):
            await store.transaction(lambda db: mcp_management.change(db, first.model_copy(update={"operation_id": "c" * 32}), "primary", path))
        with pytest.raises(BackendError, match="mcp_config_namespace_conflict"):
            await store.transaction(lambda db: mcp_management.change(db, first.model_copy(update={"operation_id": "c" * 32, "expected_revision": 2, "name": "local_tools"}), "primary", path))
        await store.db.close()
        store = HostStore(path, require_existing=True)
        assert await store.transaction(lambda db: mcp_management.change(db, first, "primary", path)) == saved
        assert not (await store.transaction(lambda db: mcp_management.listing(db, "docs", path))).servers[0].enabled
        assert (await store.transaction(lambda db: mcp_management.listing(db, "primary", path))).servers[0].enabled
        with pytest.raises(BackendError, match="mcp_config_operation_conflict"):
            await store.transaction(lambda db: mcp_management.change(db, first.model_copy(update={"name": "different"}), "primary", path))
        removed = McpConfigPatch(operation_id="d" * 32, expected_revision=2, name=first.name, remove=True)
        empty = await store.transaction(lambda db: mcp_management.change(db, removed, "primary", path))
        assert empty.servers == []
        assert await store.transaction(lambda db: mcp_management.change(db, removed, "primary", path)) == empty
        await store.transaction(lambda db: mcp_management.change(db, first, "primary", path))
        assert not (await store.transaction(lambda db: mcp_management.listing(db, "docs", path))).servers
    finally:
        await store.db.close()


async def test_managed_mcp_scope_disable_receipts_and_reconnect_use_real_stdio(tmp_path: Path) -> None:
    script = tmp_path / "managed.py"
    script.write_text(SERVER.replace("'private_env':os.getenv('AMAZME_PRIVATE_TEST_KEY','absent')",
        "'private_env':os.getenv('AMAZME_PRIVATE_TEST_KEY','absent'),'explicit':os.getenv('LOCAL_MCP_TOKEN','absent')"))
    proc, url, profile = _serve(tmp_path)
    other = tmp_path / "docs"
    other.mkdir()
    try:
        async with Client(url, (profile / "web.token").read_text().strip()) as client:
            await client.add_workspace(WorkspaceGrantRequest(name="docs", host_path=str(other)))
            a = str((await client.rpc("session.create", workspace="primary", title="A"))["session_id"])
            b = str((await client.rpc("session.create", workspace="docs", title="B"))["session_id"])
            sibling = str((await client.rpc("session.create", workspace="primary", title="Sibling"))["session_id"])
            binding = await client.attach(a)
            write = McpConfigWrite(operation_id="c" * 32, expected_revision=0, name="local",
                entry=McpStdioSettings(command=sys.executable, args=[str(script), "calls.txt"], exposure="direct", env={
                    "LOCAL_MCP_TOKEN": "!printf x >> credential-lookups.txt; printf config-secret",
                    "LOCAL_MCP_SECOND": "!printf x >> credential-lookups.txt; printf config-secret"}))
            config = await client.change_mcp_configuration(a, "primary", binding.attachment_id, write)
            assert config.revision == 1 and "config-secret" not in config.model_dump_json()
            first = next(server for server in (await client.mcp_state(a)).servers if server.enabled)
            assert first.phase == "ready" and first.name == "local"
            await client.snapshot(b)
            await client.snapshot(sibling)
            second = next(server for server in (await client.mcp_state(b)).servers if server.enabled)
            assert second.workspace == "docs" and second.server_id != first.server_id
            call = await client.request_mcp(session_id=a, attachment_id=binding.attachment_id, server_id=first.server_id,
                call_id="d" * 32, name="demo.echo", arguments={"text": "once"})
            await client.decide_mcp(session_id=a, attachment_id=binding.attachment_id, server_id=first.server_id,
                call_id=call.call_id, decision_id="accept-original", approve=True, digest=call.digest)
            for _ in range(100):
                result = next(item for item in (await client.mcp_state(a)).calls if item.call_id == call.call_id)
                if result.phase == "done":
                    break
                await asyncio.sleep(.02)
            assert result.phase == "done" and result.result_data["structuredContent"]["explicit"] == "config-secret"
            hidden = McpConfigPatch(operation_id="e" * 32, expected_revision=1, name="local", scope="project", exposure="hidden")
            await client.change_mcp_configuration(a, "primary", binding.attachment_id, hidden)
            assert next(server for server in (await client.mcp_state(a)).servers if server.server_id == first.server_id).exposure == "hidden"
            assert next(server for server in (await client.mcp_state(b)).servers if server.server_id == second.server_id).exposure == "direct"
            assert (tmp_path / "workspace/credential-lookups.txt").read_text() == "xx"
            with pytest.raises(BackendError, match="mcp_tool_hidden"):
                await client.request_mcp(session_id=a, attachment_id=binding.attachment_id, server_id=first.server_id,
                    call_id="f" * 32, name="demo.echo", arguments={})
            await client.change_mcp_configuration(a, "primary", binding.attachment_id,
                McpConfigPatch(operation_id="6" * 32, expected_revision=2, name="local", scope="project", enabled=False))
            assert all(server.clean for server in (await client.mcp_state(a)).servers)
            assert all(server.clean for server in (await client.mcp_state(sibling)).servers)
            assert any(server.phase == "ready" and not server.clean for server in (await client.mcp_state(b)).servers)
            await client.change_mcp_configuration(a, "primary", binding.attachment_id,
                McpConfigPatch(operation_id="7" * 32, expected_revision=3, name="local", scope="project", remove=True))
            disabled = McpConfigPatch(operation_id="1" * 32, expected_revision=4, name="local", enabled=False)
            await client.change_mcp_configuration(a, "primary", binding.attachment_id, disabled)
            assert all(server.clean for server in (await client.mcp_state(a)).servers)
            assert all(server.clean for server in (await client.mcp_state(b)).servers)
            replay = await client.request_mcp(session_id=a, attachment_id=binding.attachment_id, server_id=first.server_id,
                call_id=call.call_id, name="demo.echo", arguments={"text": "once"})
            assert replay.phase == "done" and (tmp_path / "workspace/calls.txt").read_text() == "x"
            await client.change_mcp_configuration(a, "primary", binding.attachment_id, write)
            assert not (await client.mcp_configuration(a)).servers[0].enabled
            await client.change_mcp_configuration(a, "primary", binding.attachment_id,
                McpConfigPatch(operation_id="2" * 32, expected_revision=5, name="local", enabled=True))
            reconnect = McpReconnect(operation_id="3" * 32, name="local")
            fresh = await client.reconnect_mcp(a, "primary", binding.attachment_id, reconnect)
            assert fresh.phase == "ready" and fresh.server_id != first.server_id
            assert (await client.reconnect_mcp(a, "primary", binding.attachment_id, reconnect)).server_id == fresh.server_id
            assert (tmp_path / "workspace/credential-lookups.txt").read_text() == "xxxx"
            newest = await client.reconnect_mcp(a, "primary", binding.attachment_id, reconnect.model_copy(update={"operation_id": "4" * 32}))
            old = await client.reconnect_mcp(a, "primary", binding.attachment_id, reconnect)
            assert old.server_id == fresh.server_id and old.phase == "exited" and old.clean
            assert next(server for server in (await client.mcp_state(a)).servers if server.server_id == newest.server_id).phase == "ready"
            assert (tmp_path / "workspace/credential-lookups.txt").read_text() == "xxxxx"
            assert "config-secret" not in json.dumps((await client.mcp_configuration(a)).model_dump())
            failed_start = write.model_copy(update={"operation_id": "5" * 32, "expected_revision": 6,
                "entry": write.entry.model_copy(update={"env": {"LOCAL_MCP_TOKEN": "!printf x >> credential-failures.txt; exit 2"}})})
            with pytest.raises(BackendError) as failed:
                await client.change_mcp_configuration(a, "primary", binding.attachment_id, failed_start)
            assert failed.value.code == "mcp_config_apply_pending" and failed.value.status == 503
            await client.change_mcp_configuration(a, "primary", binding.attachment_id, failed_start)
            await client.reload_mcp_configuration(a, "primary", binding.attachment_id)
            assert (tmp_path / "workspace/credential-failures.txt").read_text() == "x"
            assert any(server.phase == "unknown" and server.clean for server in (await client.mcp_state(a)).servers)
    finally:
        await asyncio.to_thread(_stop, proc, profile)
