"""Original package management persists configuration and uses real owned Python plugins."""

import asyncio
from pathlib import Path

import httpx
import pytest
from test_client import _serve, _stop

from amazme_backend.contracts import (
    BackendError,
    PluginCallRequest,
    PluginDraft,
    PluginPackageAdd,
    PluginPackageRemove,
)
from amazme_backend.plugin_packages import plugin_identity
from amazme_backend.sdk import Client


async def test_package_configuration_loads_for_both_sessions_then_removes_only_its_own_instances(tmp_path: Path) -> None:
    source = (Path(__file__).parent / "helpers/plugin_fixture.py").read_text()
    package = tmp_path / "package"
    package.mkdir()
    entry = package / "extension.py"
    entry.write_text(source)
    proc, url, profile = _serve(tmp_path)
    try:
        async with Client(url, (profile / "web.token").read_text().strip()) as client:
            async with httpx.AsyncClient(base_url=url) as unauthenticated:
                assert (await unauthenticated.get("/api/v1/plugin-packages")).status_code == 401
            added = PluginPackageAdd(package_id="c" * 32, entry=str(package), expected_revision=0)
            configured = await client.add_plugin_package(added)
            assert configured.revision == 1 and configured.packages[0].entry == str(entry.resolve())
            assert (await client.rpc("plugin.package.list"))["packages"][0]["package_id"] == added.package_id
            assert await client.add_plugin_package(added) == configured
            with pytest.raises(BackendError, match="plugin_package_conflict"):
                await client.add_plugin_package(added.model_copy(update={"entry": str(tmp_path / "else.py")}))
            with pytest.raises(BackendError, match="plugin_package_revision"):
                await client.add_plugin_package(added.model_copy(update={"package_id": "d" * 32}))
            sessions = [await client.rpc("session.create", workspace="primary", title=title) for title in ("A", "B")]
            bindings = [await client.attach(str(session["session_id"])) for session in sessions]
            # Starting the normal worker syncs the configured package; the second session loads explicitly.
            first, second = (str(session["session_id"]) for session in sessions)
            await client.snapshot(first)
            assert (await client.plugins(first)).plugins[0].phase == "ready"
            loaded = await client.load_plugin_packages(second, "primary", bindings[1].attachment_id)
            assert loaded.plugins[0].package_id == added.package_id
            await client.register_plugin(PluginDraft(plugin_id="9" * 32, session_id=second, name="independent", entry=str(entry)))
            for session, binding in zip((first, second), bindings, strict=True):
                request = PluginCallRequest(call_id=("e" if session == first else "f") * 32, name="hello", arguments={"name": session})
                result = await client.call_plugin(session, "primary", binding.attachment_id, plugin_identity(added.package_id, session), request)
                assert result.result is not None and result.result.details["session"] == session
            removed = await client.remove_plugin_package(added.package_id, PluginPackageRemove(expected_revision=1))
            assert removed.packages == [] and removed.revision == 3
            assert not (await client.plugins(first)).plugins
            remaining = (await client.plugins(second)).plugins
            assert len(remaining) == 1 and remaining[0].plugin_id == "9" * 32 and remaining[0].phase == "ready"
            assert await client.remove_plugin_package(added.package_id, PluginPackageRemove(expected_revision=1)) == removed
            entry.rename(package / "kept.py")
            # A lost acceptance retried after removal and a missing file is still the original operation.
            assert await client.add_plugin_package(added) == removed
            assert (package / "kept.py").exists()
            await client.snapshot(first)
            assert not (await client.plugins(first)).plugins
            assert len((tmp_path / "workspace/effects.txt").read_text().splitlines()) == 2
    finally:
        await asyncio.to_thread(_stop, proc, profile)


async def test_package_removal_barrier_and_revision_survive_store_reopen(tmp_path: Path) -> None:
    from amazme_backend import plugin_packages
    from amazme_backend.contracts import ProcessLease
    from amazme_backend.host_store import HostStore

    path = tmp_path / "host.sqlite"
    store = HostStore(path)
    lease = ProcessLease(instance_id="owner", role="host", profile_path=str(tmp_path), path=str(tmp_path / "lease"), device=1, inode=1)
    await store.initialize("owner", "build", lease)
    value = PluginPackageAdd(package_id="a" * 32, entry="/configured/extension.py", expected_revision=0)
    try:
        await store.transaction(lambda db: plugin_packages.add(db, value, value.entry))
        with pytest.raises(BackendError, match="plugin_package_duplicate"):
            await store.transaction(lambda db: plugin_packages.add(db, value.model_copy(update={"package_id": "b" * 32, "expected_revision": 1}), value.entry))
        removing = await store.transaction(lambda db: plugin_packages.begin_remove(db, value.package_id, 1))
        assert removing.phase == "removing"
        await store.db.close()
        store = HostStore(path, require_existing=True)
        recovered = await store.transaction(plugin_packages.listing)
        assert recovered.revision == 2 and recovered.packages[0].phase == "removing"
        assert await store.transaction(lambda db: plugin_packages.begin_remove(db, value.package_id, 1)) == removing
        removed = await store.transaction(lambda db: plugin_packages.finish_remove(db, value.package_id))
        assert not removed.packages and removed.revision == 3
        assert await store.transaction(lambda db: plugin_packages.add(db, value, value.entry)) == removed
    finally:
        await store.db.close()
