"""The served page carries the running host identity before the page module starts."""

import base64
import hashlib
import json
import re
from pathlib import Path

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import BackendError, HostFence, ProcessLease
from amazme_backend.host import Host, application
from amazme_backend.page_boot import boot_page, boot_script


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "host-1", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux", "api_key": "", "proxy": "", "headers": {}},
    }))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "c" * 64)
    private_write(tmp_path / "web.token", "w" * 48)
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:4310"
    return host


def test_script_escapes_markup() -> None:
    script = boot_script({"app": {"name": "AmazMe", "version": "0.1.0"}, "note": "<script>"})
    assert "<script>" not in script.split("globalThis.__AMAZME_BOOT__=", 1)[1]
    assert "\\u003cscript>" in script


async def test_served_page_names_this_host(tmp_path: Path) -> None:
    host = _host(tmp_path)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, ProcessLease(
        instance_id="test-host", role="host", profile_path=str(tmp_path), path=str(tmp_path / "lease"),
        device=1, inode=1))
    identity = host.identity()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin) as client:
        response = await client.get("/")
        again = await client.get("/index.html")
        script_file = await client.get("/page.js")
        sheet = await client.get("/page.css")
    assert response.status_code == 200
    def without_nonce(document: str) -> str:
        return re.sub(r'(<meta name="amazme-style-nonce" content=")[^"]+', r'\1NONCE', document)
    assert without_nonce(response.text) == without_nonce(again.text) == without_nonce(boot_page(identity, host.origin))
    nonce = re.search(r'<meta name="amazme-style-nonce" content="([^"]+)"', response.text)
    assert nonce is not None
    assert f"'nonce-{nonce.group(1)}'" in response.headers["content-security-policy"]
    assert nonce.group(1) not in again.text
    marker = "globalThis.__AMAZME_BOOT__="
    payload = response.text.split(marker, 1)[1].split(";", 1)[0]
    boot = json.loads(payload)
    assert boot["app"] == {"name": "AmazMe", "version": identity.version}
    assert boot["protocol"] == identity.protocol == "amazme-http/1"
    assert boot["server"]["id"] == identity.profile_id == "host-1"
    assert boot["transport"] == {"url": "ws://127.0.0.1:4310/api/v1/events", "path": "/api/v1/events"}
    assert boot["mode"] == "source"
    assert "document.title=globalThis.__AMAZME_BOOT__.app.name" in response.text
    source = re.search(r"<script>(globalThis\.__AMAZME_BOOT__=.*?)</script>", response.text)
    assert source is not None
    digest = base64.b64encode(hashlib.sha256(source.group(1).encode()).digest()).decode()
    policy = response.headers["content-security-policy"]
    assert f"script-src 'self' 'sha256-{digest}'" in policy
    assert "unsafe-inline" not in policy
    assert script_file.status_code == 200
    assert 'id="composer"' in response.text
    assert 'id="modal-root"' in response.text
    assert 'id="model-form"' not in response.text
    assert 'id="amazme-page-entry" type="module" src="/page.js"' in response.text
    assert 'panel.id = "startup-error"' in response.text
    assert response.text.index("globalThis.__AMAZME_BOOT__=") < response.text.index('var preferences =')
    assert "{{" not in response.text
    assert sheet.status_code == 200 and ".app-rail" in sheet.text
    assert "sha256-" not in script_file.headers["content-security-policy"]
    assert "unsafe-inline" not in script_file.headers["content-security-policy"]
    await host.supervisor.close()
    await host.store.db.close()


def test_missing_origin_is_rejected(tmp_path: Path) -> None:
    host = _host(tmp_path)
    host.origin = ""
    try:
        boot_page(host.identity(), host.origin)
    except BackendError as error:
        assert error.code == "boot_origin_invalid"
    else:
        raise AssertionError("empty origin was accepted")


@pytest.mark.parametrize("page_path", ["/", "/index.html?new=1"])
async def test_local_page_connects_without_manual_pairing(tmp_path: Path, page_path: str) -> None:
    host = _host(tmp_path)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, ProcessLease(
        instance_id="test-host", role="host", profile_path=str(tmp_path), path=str(tmp_path / "lease"),
        device=1, inode=1))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin) as client:
            assert (await client.get("/api/v1/sessions")).status_code == 401
            response = await client.get(page_path)
            assert response.status_code == 200
            assert client.cookies.get("amazme") == host.web_token
            assert "HttpOnly" in response.headers["set-cookie"]
            assert "SameSite=strict" in response.headers["set-cookie"]
            assert host.web_token not in response.text
            assert (await client.get("/api/v1/sessions")).status_code == 200
            headers = {"x-amazme-build": host.build, "x-amazme-epoch": str(host.fence.host_epoch)}
            assert (await client.post("/api/v1/sessions", json={}, headers=headers)).status_code == 401
            headers["origin"] = host.origin
            assert (await client.post("/api/v1/sessions", json={}, headers=headers)).status_code == 201
            assert (await client.get("/control/updates/current")).status_code == 401
            client.cookies.clear()
            assert (await client.get(page_path)).status_code == 200
            assert (await client.get("/api/v1/sessions")).status_code == 200
    finally:
        await host.supervisor.close()
        await host.store.db.close()


@pytest.mark.parametrize("headers", [{"host": "other.example"}, {"origin": "https://other.example"}])
async def test_foreign_page_request_does_not_receive_cookie(tmp_path: Path, headers: dict[str, str]) -> None:
    host = _host(tmp_path)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin) as client:
            response = await client.get("/", headers=headers)
            assert response.status_code == 403
            assert "set-cookie" not in response.headers
    finally:
        await host.supervisor.close()
        await host.store.db.close()
