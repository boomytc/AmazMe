"""The original client's presentation settings survive origin changes and do not overwrite concurrent edits."""

import json
from pathlib import Path

import httpx
import pytest

from amazme_backend.contracts import InterfacePreferences, ProcessLease
from amazme_backend.host import application
from amazme_backend.host_store import HostStore


async def test_preferences_persist_reject_stale_edits_and_boot_before_the_theme(tmp_path: Path) -> None:
    from test_management import _host

    host = _host(tmp_path)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, ProcessLease(
        instance_id="test-host", role="host", profile_path=str(tmp_path), path=str(tmp_path / "lease"),
        device=1, inode=1))
    headers = {"Authorization": "Bearer web-only", "x-amazme-build": host.build,
               "x-amazme-epoch": str(host.fence.host_epoch)}
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)),
                                    base_url=host.origin, headers=headers) as client:
            saved = await client.put("/api/v1/settings/preferences", json={"expected_revision": 0,
                "preferences": {"appearance": "dark", "locale": "zh", "textSize": 18,
                                "terminalFont": '"Noto Sans SC", Menlo, Menlo', "showWelcome": False}})
            assert saved.status_code == 200, saved.text
            view = saved.json()
            assert view["revision"] == 1 and view["preferences"]["terminalFont"] == "Noto Sans SC, Menlo"
            assert view["preferences"]["textSize"] == 18 and view["preferences"]["showWelcome"] is False
            name = await client.post("/api/v1/settings", json={"display_name": "本机名称", "expected_revision": 1})
            assert name.status_code == 200 and name.json()["preferences"] == view["preferences"]
            replay = await client.put("/api/v1/settings/preferences", json={"expected_revision": 0,
                "preferences": view["preferences"]})
            assert replay.status_code == 200 and replay.json()["revision"] == 2
            stale = await client.put("/api/v1/settings/preferences", json={"expected_revision": 0,
                "preferences": {"appearance": "light"}})
            assert stale.status_code == 409 and stale.json()["code"] == "settings_conflict"
            assert (await client.get("/api/v1/settings")).json() == replay.json()
            page = (await client.get("/")).text
            payload = json.loads(page.split("globalThis.__AMAZME_BOOT__=", 1)[1].split(";", 1)[0])
            assert payload["preferences"] == view["preferences"]
            assert page.index("globalThis.__AMAZME_BOOT__=") < page.index("var preferences =")
            exported = (await client.get("/api/v1/export")).json()
            assert exported["settings"]["preferences"] == view["preferences"]
    finally:
        await host.supervisor.close()
        await host.store.db.close()

    reopened = HostStore(tmp_path / "host.sqlite", require_existing=True)
    try:
        settings = await reopened.product_settings()
        assert settings.display_name == "本机名称" and settings.revision == 2
        assert settings.preferences.appearance == "dark" and settings.preferences.textSize == 18
    finally:
        await reopened.db.close()


@pytest.mark.parametrize("field,value", [
    ("textFont", "Arial; color:red"), ("codeFont", "url(https://example.invalid/font)"),
    ("terminalFont", "Arial, , Menlo"), ("textSize", 100), ("codeSize", True), ("appearance", "invalid"),
])
def test_preferences_validate_font_names_and_original_size_limits(field: str, value: object) -> None:
    with pytest.raises(ValueError):
        InterfacePreferences.model_validate({field: value})
