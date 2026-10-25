"""Projects, settings, feedback, shares, and new-format import do not touch old data or secrets."""

import json
import shutil
from pathlib import Path

import httpx

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import (
    ExportBundle,
    ExportMessage,
    ExportSession,
    FeedbackView,
    HostFence,
    ProcessLease,
    ProductSettings,
    ProjectView,
    Submit,
)
from amazme_backend.host import Host, application
from amazme_backend.manage import bundle_digest
from amazme_backend.providers import Completion, stream
from amazme_backend.session_domain import ModelInvocation, ModelReturned
from amazme_backend.storage import SessionStore, session_database

SESSION = "a" * 32
PROJECT = "b" * 32
FEEDBACK = "c" * 32
SHARE = "d" * 32
KEY = "sk-test-not-real"


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "manage", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux", "api_key": KEY, "proxy": "http://user:secret@127.0.0.1:9",
                     "headers": {"Authorization": "Bearer leaked"}}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:12345"
    return host


async def _message(host: Host, session: str, request_id: str, text: str) -> None:
    path = session_database(host.profile.path, session)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    store = SessionStore(path, session, build=host.build)
    await store.initialize()
    try:
        await store.accept(Submit(request_id=request_id, text=text), HostFence(host_epoch=0, build_id=host.build))
        for _ in range(8):
            if any(content == text for _request, _role, content in await store.transcript()):
                return
            action = await store.advance()
            if isinstance(action, ModelInvocation):
                async for item in stream(action.config, action.messages):
                    if isinstance(item, Completion):
                        await store.advance(ModelReturned(action, item))
    finally:
        await store.db.close()


def _client(host: Host) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": host.build,
        "x-amazme-epoch": str(host.fence.host_epoch),
    })


async def test_management_export_hides_secrets_and_import_does_not_overwrite(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        async with _client(host) as client:
            project = await client.post("/api/v1/projects", json={"project_id": PROJECT, "name": "演示"})
            again = await client.post("/api/v1/projects", json={"project_id": PROJECT, "name": "演示"})
            changed = await client.post("/api/v1/projects", json={"project_id": PROJECT, "name": "另一个"})
            assert project.status_code == 200 and again.json()["name"] == "演示"
            assert changed.status_code == 409 and changed.json()["code"] == "project_conflict"
            listed_projects = await client.get("/api/v1/projects")
            assert listed_projects.status_code == 200
            assert listed_projects.json()["projects"] == [{"project_id": PROJECT, "name": "演示", "workspaces": ["primary"], "revision": 0, "removed": False}]
            missing = await client.post("/api/v1/sessions", json={"title": "孤立", "project_id": "e" * 32})
            assert missing.status_code == 404 and missing.json()["code"] == "project_not_found"
            created = await client.post("/api/v1/sessions", json={"title": "笔记", "project_id": PROJECT})
            assert created.status_code == 201 and created.json()["project_id"] == PROJECT
            session = created.json()["session_id"]
            kept = await client.post("/api/v1/sessions", json={"title": "保留"})
            assert kept.status_code == 201
            chosen = "f" * 32
            first_fixed = await client.post("/api/v1/sessions", json={"title": "固定", "session_id": chosen})
            second_fixed = await client.post("/api/v1/sessions", json={"title": "固定", "session_id": chosen})
            assert first_fixed.status_code == 201 and second_fixed.status_code == 201
            assert first_fixed.json()["session_id"] == second_fixed.json()["session_id"] == chosen
            clash = await client.post("/api/v1/sessions", json={"title": "别的", "session_id": chosen})
            assert clash.status_code == 409 and clash.json()["code"] == "session_conflict"
            invalid = await client.post("/api/v1/sessions", json={"title": "坏", "session_id": "nope"})
            assert invalid.status_code == 400 and invalid.json()["code"] == "invalid_session_id"
            listed_ids = [item["session_id"] for item in (await client.get("/api/v1/sessions")).json()["sessions"]]
            assert listed_ids.count(chosen) == 1
            await _message(host, session, "hello", "你好")
            settings = await client.get("/api/v1/settings")
            assert settings.json() == {"display_name": "", "revision": 0, "preferences": {
                "appearance": "system", "locale": "auto", "showWelcome": True,
                "enabledModels": None,
                "textFont": "", "codeFont": "", "terminalFont": "",
                "textSize": 15, "codeSize": 13, "terminalSize": 12,
            }}
            saved = await client.post("/api/v1/settings", json={"display_name": "甲", "expected_revision": 0})
            stale = await client.post("/api/v1/settings", json={"display_name": "乙", "expected_revision": 0})
            assert saved.json() == {**settings.json(), "display_name": "甲", "revision": 1}
            assert stale.status_code == 409 and stale.json()["code"] == "settings_conflict"
            assert (await client.get("/api/v1/settings")).json()["display_name"] == "甲"
            secret = await client.post("/api/v1/feedback", json={
                "feedback_id": FEEDBACK, "session_id": session, "text": f"失败 {KEY}"})
            assert secret.status_code == 409 and secret.json()["code"] == "feedback_secret"
            assert KEY not in secret.text and "leaked" not in secret.text
            note = await client.post("/api/v1/feedback", json={
                "feedback_id": FEEDBACK, "session_id": session, "text": "界面卡住"})
            conflict = await client.post("/api/v1/feedback", json={
                "feedback_id": FEEDBACK, "session_id": session, "text": "另一句"})
            assert note.status_code == 200 and note.json()["session_id"] == session
            assert conflict.status_code == 409 and conflict.json()["code"] == "feedback_conflict"
            attached = await client.post(f"/api/v1/sessions/{session}/attachments")
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            shared = await client.post(f"/api/v1/sessions/{session}/shares", json={"share_id": SHARE})
            assert shared.status_code == 200 and shared.json()["messages"] == [
                {"request_id": "hello", "role": "user", "content": "你好"}]
            assert KEY not in shared.text and "leaked" not in shared.text and "api_key" not in shared.text
            exported = await client.get("/api/v1/export")
            assert exported.status_code == 200 and exported.json()["format"] == "amazme-export/1"
            assert KEY not in exported.text and "leaked" not in exported.text and "api_key" not in exported.text
            assert bundle_digest(ExportBundle.model_validate(exported.json())) == exported.json()["digest"]
            repeat = await client.post("/api/v1/import", json=exported.json())
            assert repeat.status_code == 200 and repeat.json()["created"] == 0
            listed = await client.get("/api/v1/sessions")
            assert any(item["session_id"] == kept.json()["session_id"] and item["title"] == "保留"
                       for item in listed.json()["sessions"])
            mutated = exported.json()
            mutated["sessions"][0]["title"] = "改掉"
            mutated["digest"] = bundle_digest(ExportBundle.model_validate(mutated))
            refused = await client.post("/api/v1/import", json=mutated)
            assert refused.status_code == 409 and refused.json()["code"] == "import_conflict"
            assert any(item["title"] == "笔记" for item in (await client.get("/api/v1/sessions")).json()["sessions"])
            old = await client.post("/api/v1/import", json={"format": "jsonl", "digest": "", "sessions": []})
            assert old.status_code == 409 and old.json()["code"] == "import_format"
            tampered = exported.json()
            tampered["digest"] = "0" * 64
            assert (await client.post("/api/v1/import", json=tampered)).json()["code"] == "import_digest"
            await _message(host, session, "secret-note", KEY)
            hidden = await client.get("/api/v1/export")
            assert hidden.status_code == 409 and hidden.json()["code"] == "export_secret" and KEY not in hidden.text
            stored = await client.get(f"/api/v1/sessions/{session}/shares/{SHARE}")
            assert stored.json()["messages"] == [{"request_id": "hello", "role": "user", "content": "你好"}]
            blocked = await client.post(f"/api/v1/sessions/{session}/shares", json={"share_id": SHARE})
            assert blocked.status_code == 409 and blocked.json()["code"] == "share_conflict"
    finally:
        await host.supervisor.close()
        await host.store.db.close()


def _sealed(bundle: ExportBundle) -> dict[str, object]:
    return bundle.model_copy(update={"digest": bundle_digest(bundle)}).model_dump()


async def test_import_checks_every_workspace_before_writing(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    grant = tmp_path.parent / f"import-{tmp_path.name}"
    grant.mkdir()
    project_id = "f" * 32
    first, second, orphan = "1" * 32, "2" * 32, "3" * 32
    try:
        async with _client(host) as client:
            missing_project = _sealed(ExportBundle(
                format="amazme-export/1",
                sessions=[ExportSession(
                    session_id=orphan, title="孤立", workspace="primary", project_id="9" * 32,
                    messages=[ExportMessage(request_id="m", role="user", content="不该写入")])],
            ))
            refused_project = await client.post("/api/v1/import", json=missing_project)
            assert refused_project.status_code == 409 and refused_project.json()["code"] == "import_conflict"
            assert (await client.get("/api/v1/sessions")).json()["sessions"] == []
            pending = _sealed(ExportBundle(
                format="amazme-export/1",
                projects=[ProjectView(project_id=project_id, name="待导入")],
                sessions=[
                    ExportSession(session_id=first, title="先到", workspace="primary", project_id=project_id,
                                  messages=[ExportMessage(request_id="m1", role="user", content="甲")]),
                    ExportSession(session_id=second, title="后到", workspace="docs", project_id=project_id,
                                  messages=[ExportMessage(request_id="m2", role="user", content="乙")]),
                ],
            ))
            refused = await client.post("/api/v1/import", json=pending)
            assert refused.status_code == 404 and refused.json()["code"] == "workspace_not_found"
            assert (await client.get("/api/v1/sessions")).json()["sessions"] == []
            assert (await client.get("/api/v1/projects")).json()["projects"] == []
            granted = await client.post("/api/v1/workspaces", json={"name": "docs", "host_path": str(grant)})
            assert granted.status_code == 200, granted.text
            imported = await client.post("/api/v1/import", json=pending)
            assert imported.status_code == 200, imported.text
            assert imported.json()["created"] == 2
            listed = {item["session_id"]: item["workspace"] for item in (await client.get("/api/v1/sessions")).json()["sessions"]}
            assert listed == {first: "primary", second: "docs"}
            assert (await client.get("/api/v1/projects")).json()["projects"] == [
                {"project_id": project_id, "name": "待导入", "workspaces": ["primary"], "revision": 0, "removed": False}]
            primary_hits = await client.get(f"/api/v1/sessions/{first}/search", params={"q": "甲"})
            docs_hits = await client.get(f"/api/v1/sessions/{second}/search", params={"q": "乙"})
            assert primary_hits.status_code == 200 and primary_hits.json()["hits"]
            assert docs_hits.status_code == 200 and docs_hits.json()["hits"]
            assert not (await client.get(f"/api/v1/sessions/{first}/search", params={"q": "乙"})).json()["hits"]
    finally:
        shutil.rmtree(grant, ignore_errors=True)
        await host.supervisor.close()
        await host.store.db.close()


async def test_import_rejects_feedback_for_an_unknown_session_before_writing(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    session_id, project_id, feedback_id = "4" * 32, "5" * 32, "6" * 32
    try:
        async with _client(host) as client:
            refused_body = _sealed(ExportBundle(
                format="amazme-export/1",
                projects=[ProjectView(project_id=project_id, name="不该出现")],
                sessions=[ExportSession(
                    session_id=session_id, title="先到", workspace="primary", project_id=project_id,
                    messages=[ExportMessage(request_id="m", role="user", content="甲")])],
                feedback=[FeedbackView(feedback_id=feedback_id, session_id="7" * 32, text="悬空反馈")],
                settings=ProductSettings(display_name="不该改名"),
            ))
            refused = await client.post("/api/v1/import", json=refused_body)
            assert refused.status_code == 409 and refused.json()["code"] == "import_conflict"
            exported = await client.get("/api/v1/export")
            assert exported.status_code == 200
            assert exported.json()["projects"] == []
            assert exported.json()["sessions"] == []
            assert exported.json()["feedback"] == []
            assert exported.json()["settings"]["display_name"] == ""
            accepted_body = _sealed(ExportBundle(
                format="amazme-export/1",
                projects=[ProjectView(project_id=project_id, name="不该出现")],
                sessions=[ExportSession(
                    session_id=session_id, title="先到", workspace="primary", project_id=project_id,
                    messages=[ExportMessage(request_id="m", role="user", content="甲")])],
                feedback=[FeedbackView(feedback_id=feedback_id, session_id=session_id, text="跟着会话")],
                settings=ProductSettings(display_name="已导入"),
            ))
            accepted = await client.post("/api/v1/import", json=accepted_body)
            assert accepted.status_code == 200 and accepted.json()["created"] == 1
            again = (await client.get("/api/v1/export")).json()
            assert again["projects"] == [{"project_id": project_id, "name": "不该出现", "workspaces": ["primary"], "revision": 0, "removed": False}]
            assert again["feedback"] == [{"feedback_id": feedback_id, "session_id": session_id, "text": "跟着会话"}]
            assert again["settings"]["display_name"] == "已导入"
            assert any(item["session_id"] == session_id for item in again["sessions"])
    finally:
        await host.supervisor.close()
        await host.store.db.close()
