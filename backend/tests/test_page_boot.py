"""The served page carries the running host identity before the page module starts."""

import base64
import hashlib
import json
import re
from pathlib import Path

import httpx

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import BackendError, HostFence
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
    identity = host.identity()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin) as client:
        response = await client.get("/")
        again = await client.get("/index.html")
        script_file = await client.get("/app.js")
        emulator = await client.get("/xterm-terminal.js")
    assert response.status_code == 200
    assert response.text == again.text == boot_page(identity, host.origin)
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
    assert emulator.status_code == 200
    assert "javascript" in emulator.headers["content-type"]
    assert "export const Terminal" in emulator.text
    assert "xterm-terminal.js" in script_file.text
    assert "sha256-" not in script_file.headers["content-security-policy"]
    assert "unsafe-inline" not in script_file.headers["content-security-policy"]


def test_missing_origin_is_rejected(tmp_path: Path) -> None:
    host = _host(tmp_path)
    host.origin = ""
    try:
        boot_page(host.identity(), host.origin)
    except BackendError as error:
        assert error.code == "boot_origin_invalid"
    else:
        raise AssertionError("empty origin was accepted")
