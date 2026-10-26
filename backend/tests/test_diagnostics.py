"""Session diagnostics report persisted state codes and do not echo secrets."""

import json
from pathlib import Path

import httpx

from amazme_backend.profiles.profile import Profile
from amazme_backend.platform.private_files import private_write
from amazme_backend.contracts import HostFence, Message, ProcessLease, Submit
from amazme_backend.host.service import Host
from amazme_backend.interfaces.http.application import application
from amazme_backend.agent.model import ProductCompletion as Completion
from amazme_backend.sessions.types import Failed, ModelInvocation, ModelReturned
from amazme_backend.sessions.service import SessionStore
from amazme_backend.profiles.layout import session_database

KEY = "sk-test-not-real"


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "diag", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux", "api_key": KEY}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.lifecycle.fence = HostFence(host_epoch=1, build_id=host.lifecycle.build)
    host.origin = "http://127.0.0.1:12345"
    return host


def _client(host: Host) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": host.lifecycle.build,
        "x-amazme-epoch": str(host.lifecycle.fence.host_epoch),
    })


async def test_diagnostics_reports_unknown_model_and_hides_blocked_secrets(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    try:
        async with _client(host) as client:
            missing = await client.get("/api/v1/sessions/" + "e" * 32 + "/diagnostics")
            assert missing.status_code == 404 and missing.json()["code"] == "session_not_found"
            created = await client.post("/api/v1/sessions", json={"title": "诊断"})
            assert created.status_code == 201
            session = created.json()["session_id"]
            absent = (await client.get(f"/api/v1/sessions/{session}/diagnostics")).json()
            assert absent == {
                "session_id": session, "present": False, "state": "absent", "blocked_code": "",
                "failed": 0, "unknown": 0, "error_codes": []}
            path = session_database(host.lifecycle.profile.path, session)
            path.parent.mkdir(parents=True, mode=0o700)
            store = SessionStore(path, session, build=host.lifecycle.build)
            await store.initialize()
            try:
                await store.accept(Submit(request_id="bad", text="失败"), HostFence(host_epoch=0, build_id=host.lifecycle.build))
                action = None
                for _ in range(8):
                    step = await store.advance()
                    if isinstance(step, ModelInvocation):
                        action = step
                        break
                assert isinstance(action, ModelInvocation)
                await store.advance(Failed(action, "model_outcome_unknown"))
                await store.accept(Submit(request_id="old", text="旧"), HostFence(host_epoch=0, build_id=host.lifecycle.build))
                old = None
                for _ in range(8):
                    step = await store.advance()
                    if isinstance(step, ModelInvocation):
                        old = step
                        break
                assert isinstance(old, ModelInvocation)
                await store.advance(ModelReturned(old, Completion(
                    message=Message(role="assistant", content="未计价"), response_id="old",
                    input_tokens=1, output_tokens=3)))
            finally:
                await store.close()
            report = (await client.get(f"/api/v1/sessions/{session}/diagnostics")).json()
            assert report["present"] is True and report["state"] == "ready"
            assert report["unknown"] == 1 and report["failed"] == 0
            assert report["error_codes"] == ["model_outcome_unknown"]
            assert KEY not in json.dumps(report)
            usage = (await client.get(f"/api/v1/sessions/{session}/usage")).json()
            assert usage["unpriced_calls"] == 1 and usage["priced"] is False and usage["cost_micro_usd"] is None
            assert KEY not in json.dumps(usage)
            store = SessionStore(path, session, build=host.lifecycle.build, require_existing=True)
            await store.initialize()
            try:
                await store.block(KEY)
            finally:
                await store.close()
            blocked = (await client.get(f"/api/v1/sessions/{session}/diagnostics")).json()
            assert blocked["state"] == "blocked" and blocked["blocked_code"] == "unlisted"
            assert KEY not in json.dumps(blocked)
    finally:
        await host.lifecycle.store.db.close()
