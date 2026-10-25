"""A session artifact is stored once, read back from disk, and not replaced by a conflicting retry."""

import base64
import hashlib
import json
from pathlib import Path

import httpx

from amazme_backend.artifacts import ArtifactView
from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import HostFence, ProcessLease, Session
from amazme_backend.host import Host, application
from amazme_backend.sdk import Client
from amazme_backend.storage import session_database

KEY = "sk-test-not-real"
BODY = b"hello artifact"


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "artifacts", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux", "api_key": KEY}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:12345"
    return host


def _client(host: Host) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": host.build,
        "x-amazme-epoch": str(host.fence.host_epoch),
    })


def _payload(data: bytes, *, name: str = "记录.txt", media_type: str = "text/plain") -> dict[str, str]:
    return {
        "artifact_id": "note1", "name": name, "media_type": media_type,
        "data_base64": base64.b64encode(data).decode(),
    }


async def test_artifact_is_stored_once_and_a_conflict_keeps_the_original(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        async with _client(host) as client:
            missing = await client.get("/api/v1/sessions/" + "e" * 32 + "/artifacts")
            assert missing.status_code == 404 and missing.json()["code"] == "session_not_found"
            created = await client.post("/api/v1/sessions", json={"title": "产物"})
            assert created.status_code == 201
            session = created.json()["session_id"]
            path = f"/api/v1/sessions/{session}/artifacts"
            unattached = await client.post(path, json=_payload(BODY))
            assert unattached.status_code == 409 and unattached.json()["code"] == "stale_client_binding"
            attached = await client.post(f"/api/v1/sessions/{session}/attachments")
            assert attached.status_code == 201
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            secret = await client.post(path, json=_payload(KEY.encode(), name="key.txt"))
            assert secret.status_code == 409 and secret.json()["code"] == "artifact_secret"
            assert KEY not in secret.text
            saved = await client.post(path, json=_payload(BODY))
            assert saved.status_code == 201
            view = saved.json()
            assert view["name"] == "记录.txt" and view["size"] == len(BODY)
            assert view["digest"] == hashlib.sha256(BODY).hexdigest()
            again = await client.post(path, json=_payload(BODY))
            assert again.status_code == 201 and again.json()["digest"] == view["digest"]
            conflict = await client.post(path, json=_payload(b"other bytes"))
            assert conflict.status_code == 409 and conflict.json()["code"] == "artifact_conflict"
            renamed = await client.post(path, json=_payload(BODY, name="另一份.txt"))
            assert renamed.status_code == 409 and renamed.json()["code"] == "artifact_conflict"
            listed = await client.get(path)
            assert listed.status_code == 200
            assert [item["artifact_id"] for item in listed.json()["artifacts"]] == ["note1"]
            fetched = await client.get(path + "/note1")
            assert fetched.status_code == 200
            assert base64.b64decode(fetched.json()["data_base64"]) == BODY
            assert KEY not in fetched.text
            binary = session_database(host.profile.path, session).parent / "artifacts" / "note1.bin"
            assert binary.read_bytes() == BODY
            assert list(binary.parent.glob("*.bin")) == [binary]
            other = tmp_path / "other.txt"
            other.write_text("secret-neighbor")
            meta = binary.with_suffix(".json")
            meta.unlink()
            meta.symlink_to(other)
            refused = await client.get(path)
            assert refused.status_code == 409 and refused.json()["code"] == "artifact_refused"
            assert "secret-neighbor" not in refused.text
    finally:
        await host.store.db.close()


async def test_sdk_put_artifact_sends_the_bytes() -> None:
    client = Client("http://127.0.0.1:9", "token")
    seen: dict[str, object] = {}

    async def session(session_id: str) -> Session:
        return Session(session_id=session_id, title="产物", workspace="primary")

    async def send(method: str, path: str, *, json_body: object | None = None,
                   headers: dict[str, str] | None = None) -> object:
        del method, path, headers
        seen["body"] = json_body
        return {"artifact_id": "note1", "name": "记录.txt", "media_type": "text/plain",
                "size": len(BODY), "digest": "abc"}

    client.session = session  # type: ignore[method-assign]
    client._send = send  # type: ignore[method-assign]
    try:
        view = await client.put_artifact(
            session_id="s" * 32, workspace="primary", attachment_id="bind",
            artifact_id="note1", name="记录.txt", data=BODY, media_type="text/plain")
        assert isinstance(view, ArtifactView)
        body = seen["body"]
        assert isinstance(body, dict)
        assert base64.b64decode(str(body["data_base64"])) == BODY
    finally:
        await client._http.aclose()
