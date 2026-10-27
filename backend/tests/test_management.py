"""Projects, settings, feedback, shares, and new-format import do not touch old data or secrets."""

import asyncio
import json
import shutil
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx

from amazme_backend.contracts import (
    CreateSession,
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
from amazme_backend.features.management.rules import bundle_digest
from amazme_backend.host.service import Host
from amazme_backend.interfaces.http.application import application
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.profile import Profile

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
    host.lifecycle.fence = HostFence(host_epoch=1, build_id=host.lifecycle.build)
    host.origin = "http://127.0.0.1:12345"
    return host


@asynccontextmanager
async def _initialized_host(tmp_path: Path) -> AsyncIterator[Host]:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    try:
        host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(
            host.lifecycle.instance, host.lifecycle.build, lease
        )
        host.lifecycle.initialized = True
        yield host
    finally:
        child = host.lifecycle.child
        await host.close()
        if child is not None:
            await asyncio.wait_for(child.wait(), timeout=5)


async def _message(host: Host, session: str, request_id: str, text: str) -> None:
    await host.access.operate(
        session, lambda store: store.import_transcript([(request_id, "user", text)])
    )


async def _append_message(host: Host, session: str, request_id: str, text: str) -> None:
    await host.sessions.deliver(session, "submit", request_id, Submit(request_id=request_id, text=text))
    for _ in range(200):
        messages = await host.access.read(session, lambda store: store.transcript())
        if (request_id, "user", text) in messages:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("worker did not persist the submitted message")


async def test_empty_new_chat_is_reused_and_removed_on_shutdown(tmp_path: Path) -> None:
    async with _initialized_host(tmp_path) as host:
        async with _client(host) as client:
            create = {"title": "新会话", "reuse_empty": True}
            first = (await client.post("/api/v1/sessions", json={**create, "session_id": "1" * 32})).json()
            repeated = (await client.post("/api/v1/sessions", json={**create, "session_id": "2" * 32})).json()
            assert repeated["session_id"] == first["session_id"]
            await _message(host, first["session_id"], "imported", "保留")
            retried = await client.post("/api/v1/sessions", json={**create, "session_id": "2" * 32})
            assert retried.json()["session_id"] == first["session_id"]
            conflict = await client.post("/api/v1/sessions", json={**create, "session_id": "2" * 32, "title": "其他"})
            assert conflict.status_code == 409 and conflict.json()["code"] == "session_conflict"
            second = (await client.post("/api/v1/sessions", json={**create, "session_id": "3" * 32})).json()
            assert second["session_id"] != first["session_id"]
            await _append_message(host, second["session_id"], "sent", "已发送")
            empty = (await client.post("/api/v1/sessions", json={**create, "session_id": "4" * 32})).json()
            assert empty["session_id"] not in {first["session_id"], second["session_id"]}
            await host.access.operate(empty["session_id"], lambda store: store.snapshot())
            await host.shutdown()
            remaining = {item.session_id for item in (await host.lifecycle.store.sessions()).sessions}
            assert remaining == {first["session_id"], second["session_id"]}
    reopened = Host(Profile(tmp_path))
    lease = ProcessLease(instance_id="reopened", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    try:
        reopened.lifecycle.fence.host_epoch = await reopened.lifecycle.store.initialize(
            reopened.lifecycle.instance, reopened.lifecycle.build, lease
        )
        reopened.lifecycle.initialized = True
        remaining = {item.session_id for item in (await reopened.sessions.sessions()).sessions}
        assert remaining == {first["session_id"], second["session_id"]}
        retried = await reopened.sessions.create_session(CreateSession(session_id="2" * 32, reuse_empty=True))
        assert retried.session_id == first["session_id"]
    finally:
        await reopened.close()


async def test_live_policy_change_unblocks_running_worker(tmp_path: Path) -> None:
    async with _initialized_host(tmp_path) as host:
        async with _client(host) as client:
            created = await client.post("/api/v1/sessions", json={"session_id": "5" * 32})
            session = created.json()["session_id"]
            attached = await client.post(f"/api/v1/sessions/{session}/attachments", json={})
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            submitted = await client.post(f"/api/v1/sessions/{session}/submissions", json={
                "request_id": "live-policy", "text": "run", "approval_policy": "all",
                "tool_call": {"id": "call", "name": "shell", "arguments": '{"command":"printf live-policy-ok"}'},
            })
            assert submitted.status_code == 202, submitted.text
            for _ in range(200):
                snapshot = (await client.get(f"/api/v1/sessions/{session}/snapshot")).json()
                if any(item["state"] == "pending" for item in snapshot["approvals"]):
                    break
                await asyncio.sleep(0.02)
            else:
                raise AssertionError("approval did not appear")
            changed = await client.put(f"/api/v1/sessions/{session}/approval-policy", json={"policy": "auto"})
            assert changed.status_code == 200
            for _ in range(200):
                receipt = (await client.get(f"/api/v1/sessions/{session}/requests/live-policy")).json()
                if receipt["status"] in {"succeeded", "failed"}:
                    break
                await asyncio.sleep(0.02)
            assert receipt["status"] == "succeeded"
            messages = await host.access.read(session, lambda store: store.messages("live-policy"))
            assert any("live-policy-ok" in message.content for message in messages)


def _client(host: Host) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": host.lifecycle.build,
        "x-amazme-epoch": str(host.lifecycle.fence.host_epoch),
    })


async def test_management_export_hides_secrets_and_import_does_not_overwrite(tmp_path: Path) -> None:
    async with _initialized_host(tmp_path) as host:
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
                "closeWindow": "background", "closeWindowPrompt": True,
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
            historical_secret = "sk-test-credential-after-history"
            await _append_message(host, session, "secret-note", historical_secret)
            accounts = await client.get("/api/v1/accounts")
            assert accounts.status_code == 200
            credential = await client.post("/api/v1/models/credential", json={
                "expected_revision": accounts.json()["revision"], "api_key": historical_secret,
            })
            assert credential.status_code == 200 and historical_secret not in credential.text
            hidden = await client.get("/api/v1/export")
            assert hidden.status_code == 409 and hidden.json()["code"] == "export_secret" and KEY not in hidden.text
            assert historical_secret not in hidden.text
            stored = await client.get(f"/api/v1/sessions/{session}/shares/{SHARE}")
            assert stored.json()["messages"] == [{"request_id": "hello", "role": "user", "content": "你好"}]
            blocked = await client.post(f"/api/v1/sessions/{session}/shares", json={"share_id": SHARE})
            assert blocked.status_code == 409 and blocked.json()["code"] == "share_conflict"


def _sealed(bundle: ExportBundle) -> dict[str, object]:
    return bundle.model_copy(update={"digest": bundle_digest(bundle)}).model_dump()


async def test_import_checks_every_workspace_before_writing(tmp_path: Path) -> None:
    grant = tmp_path.parent / f"import-{tmp_path.name}"
    grant.mkdir()
    project_id = "f" * 32
    first, second, orphan = "1" * 32, "2" * 32, "3" * 32
    try:
        async with _initialized_host(tmp_path) as host, _client(host) as client:
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


async def test_import_rejects_feedback_for_an_unknown_session_before_writing(tmp_path: Path) -> None:
    session_id, project_id, feedback_id = "4" * 32, "5" * 32, "6" * 32
    async with _initialized_host(tmp_path) as host:
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
