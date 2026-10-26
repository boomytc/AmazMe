"""Web calls stay off until enabled, and an unknown paid call is not sent again."""

import json
from pathlib import Path

import httpx
import pytest

from amazme_backend.profiles.profile import Profile
from amazme_backend.platform.private_files import private_write
from amazme_backend.contracts import BackendError, CreateSession, HostFence, Message, ProcessLease, ProviderConfig, Submit, ToolCall, WebFetch, WebPolicy, WebSearch
from amazme_backend.host.service import Host
from amazme_backend.interfaces.http.application import application
from amazme_backend.agent.model import ProductCompletion as Completion, stream
from amazme_backend.sessions.types import CloseEpoch, Continue, ModelInvocation, ModelReturned, OpenEpoch, Park, QueryTool, ToolInvocation, WebRetrieval, WebReturned
from amazme_backend.sessions.service import SessionStore
from amazme_backend.profiles.layout import session_database
from amazme_backend.execution.web.client import dispatch_web
from amazme_backend.agent.driver import Worker, command_for
from amazme_backend.bootstrap.worker import create_worker
from amazme_backend.ai.types import Auth
from session_test_support import session_database_owner

SESSION = "a" * 32
KEY = "sk-test-not-real"
SECRET_HEADER = "header-secret"


def _host(tmp_path: Path, *, provider: str = "deepseek") -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "web", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {
            "provider": provider, "base_url": "https://chat.example", "model": "deepseek-flash",
            "api_key": KEY if provider == "deepseek" else "", "proxy": "http://127.0.0.1:9",
            "headers": {"X-Project": SECRET_HEADER},
        }}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.lifecycle.fence = HostFence(host_epoch=1, build_id=host.lifecycle.build)
    host.origin = "http://127.0.0.1:12345"
    return host


def _handler(seen: list[httpx.Request]) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if b"transport" in request.content:
            raise httpx.ConnectError("down")
        if b"oversize" in request.content:
            return httpx.Response(200, content=b'{"results":[]}' + b"x" * 80,
                                 headers={"content-type": "application/json"})
        if b"redirect-me" in request.content:
            return httpx.Response(302, headers={"location": "https://evil.example/paid"})
        if b"charge" in request.content:
            return httpx.Response(402, json={"error": KEY})
        return httpx.Response(200, json={"results": [
            {"url": "https://example.com/a", "title": "A", "snippet": "s", "date": None}]})
    return httpx.MockTransport(handle)


async def _ready(host: Host, client: httpx.AsyncClient) -> None:
    attached = await client.post(f"/api/v1/sessions/{SESSION}/attachments")
    assert attached.status_code == 201
    client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
    saved = await client.post(f"/api/v1/sessions/{SESSION}/web", json={
        "enabled": True, "base_url": "https://tools.example/v1/tools", "send_original_question": True})
    assert saved.status_code == 200
    assert saved.json()["base_url"] == "https://tools.example/v1/tools"
    assert KEY not in saved.text


async def test_web_call_does_not_forward_chat_secrets_or_replay_unknown(tmp_path: Path) -> None:
    host = _host(tmp_path)
    seen: list[httpx.Request] = []
    host.sessions.web_client = httpx.AsyncClient(transport=_handler(seen), follow_redirects=False)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    host.lifecycle.initialized = True
    await host.lifecycle.store.create_session(SESSION, CreateSession(title="网页"))
    path = session_database(tmp_path, SESSION)
    path.parent.mkdir(parents=True, mode=0o700)
    seeded = SessionStore(path, SESSION, build=host.lifecycle.build)
    await seeded.initialize()
    try:
        await seeded.accept(Submit(request_id="root", text="用户原话"), HostFence(host_epoch=0, build_id=host.lifecycle.build))
    finally:
        await seeded.close()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
            "Authorization": "Bearer web-only", "x-amazme-build": host.lifecycle.build,
            "x-amazme-epoch": str(host.lifecycle.fence.host_epoch),
        }) as client:
            attached = await client.post(f"/api/v1/sessions/{SESSION}/attachments")
            assert attached.status_code == 201
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            blocked = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "early", "kind": "search", "query": "项目结构"})
            assert blocked.status_code == 409 and blocked.json()["code"] == "web_disabled"
            assert seen == []
            leaked = await client.post(f"/api/v1/sessions/{SESSION}/web", json={
                "enabled": True, "base_url": "https://user:pass@tools.example/v1/tools"})
            assert leaked.status_code == 409 and leaked.json()["code"] == "web_address"
            await _ready(host, client)
            extra = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "extra", "kind": "search", "query": "项目结构", "api_key": KEY,
                "base_url": "https://evil.example"})
            assert extra.status_code == 422 and seen == []
            first = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "search-1", "kind": "search", "query": "项目结构"})
            assert first.status_code == 200 and first.json()["phase"] == "done"
            assert KEY not in first.text and SECRET_HEADER not in first.text
            assert "https://example.com/a" in first.json()["result"]
            sent = seen[0]
            assert str(sent.url) == "https://tools.example/v1/tools/search"
            assert sent.headers["authorization"] == f"Bearer {KEY}"
            assert "x-project" not in {name.lower() for name in sent.headers}
            assert SECRET_HEADER not in sent.headers.values()
            assert json.loads(sent.content)["ori_question"] == "用户原话"
            assert "chat.example" not in str(sent.url)
            again = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "search-1", "kind": "search", "query": "项目结构"})
            assert again.status_code == 200 and again.json()["result"] == first.json()["result"]
            changed = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "search-1", "kind": "search", "query": "另一句"})
            assert changed.status_code == 409 and changed.json()["code"] == "web_call_conflict"
            assert len(seen) == 1
            dropped = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "drop", "kind": "search", "query": "transport"})
            assert dropped.status_code == 200 and dropped.json()["phase"] == "unknown"
            assert dropped.json()["error"] == "web_transport"
            retry = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "drop", "kind": "search", "query": "transport"})
            assert retry.json()["phase"] == "unknown" and len(seen) == 2
            charged = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "paid", "kind": "search", "query": "charge"})
            assert charged.json()["phase"] == "failed" and charged.json()["error"] == "web_http_402"
            assert KEY not in charged.text
            await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "paid", "kind": "search", "query": "charge"})
            assert len(seen) == 3
            await client.post(f"/api/v1/sessions/{SESSION}/web", json={
                "enabled": True, "base_url": "https://tools.example/v1/tools", "max_response_bytes": 16})
            huge = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "big", "kind": "search", "query": "oversize"})
            assert huge.json()["phase"] == "unknown" and huge.json()["error"] == "web_response_limit"
            await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "big", "kind": "search", "query": "oversize"})
            bounced = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "bounce", "kind": "fetch", "url": "https://example.com/redirect-me"})
            assert bounced.json()["phase"] == "failed" and bounced.json()["error"] == "web_redirect"
            await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "bounce", "kind": "fetch", "url": "https://example.com/redirect-me"})
            assert len(seen) == 5
            nested = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "nested", "kind": "fetch", "url": "https://user:pass@example.com/a"})
            assert nested.status_code == 409 and nested.json()["code"] == "web_address"
            assert len(seen) == 5
        await host.lifecycle.stop_owned_supervisor()
        reopened = SessionStore(path, SESSION, build=host.lifecycle.build, require_existing=True)
        await reopened.initialize()
        try:
            restored, send = await reopened.begin_web_call(
                "drop", "search", json.dumps(
                    {"count": None, "kind": "search", "query": "transport", "url": ""},
                    sort_keys=True, separators=(",", ":"), ensure_ascii=False))
            assert send is False and restored.phase == "unknown" and restored.error == "web_transport"
        finally:
            await reopened.close()
    finally:
        await host.sessions.web_client.aclose()
        await host.close()


async def test_web_outbound_omits_the_provider_secret(tmp_path: Path) -> None:
    host = _host(tmp_path)
    seen: list[httpx.Request] = []
    host.sessions.web_client = httpx.AsyncClient(transport=_handler(seen), follow_redirects=False)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    host.lifecycle.initialized = True
    await host.lifecycle.store.create_session(SESSION, CreateSession(title="网页"))
    path = session_database(tmp_path, SESSION)
    path.parent.mkdir(parents=True, mode=0o700)
    seeded = SessionStore(path, SESSION, build=host.lifecycle.build)
    await seeded.initialize()
    try:
        await seeded.accept(Submit(request_id="root", text=f"原话 {KEY}"), HostFence(host_epoch=0, build_id=host.lifecycle.build))
    finally:
        await seeded.close()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
            "Authorization": "Bearer web-only", "x-amazme-build": host.lifecycle.build,
            "x-amazme-epoch": str(host.lifecycle.fence.host_epoch),
        }) as client:
            await _ready(host, client)
            query = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "secret-query", "kind": "search", "query": f"查找 {KEY}"})
            assert query.status_code == 409 and query.json()["code"] == "web_secret"
            assert KEY not in query.text and seen == []
            fetched = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "secret-fetch", "kind": "fetch", "url": f"https://example.com/{KEY}"})
            assert fetched.status_code == 409 and fetched.json()["code"] == "web_secret"
            assert seen == []
            clean = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "clean", "kind": "search", "query": "项目结构"})
            assert clean.status_code == 200 and clean.json()["phase"] == "done"
            body = json.loads(seen[0].content)
            assert "ori_question" not in body and KEY.encode() not in seen[0].content
        await host.lifecycle.stop_owned_supervisor()
        stored = SessionStore(path, SESSION, build=host.lifecycle.build, require_existing=True)
        await stored.initialize()
        try:
            reserved = await session_database_owner(stored).call(lambda db: db.execute(
                "SELECT id FROM web_calls WHERE id IN ('secret-query','secret-fetch')").fetchall())
            assert reserved == []
        finally:
            await stored.close()
    finally:
        await host.sessions.web_client.aclose()
        await host.close()


async def test_web_call_without_a_deepseek_key_sends_nothing(tmp_path: Path) -> None:
    host = _host(tmp_path, provider="faux")
    seen: list[httpx.Request] = []
    host.sessions.web_client = httpx.AsyncClient(transport=_handler(seen), follow_redirects=False)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    host.lifecycle.initialized = True
    await host.lifecycle.store.create_session(SESSION, CreateSession(title="无钥匙"))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
            "Authorization": "Bearer web-only", "x-amazme-build": host.lifecycle.build,
            "x-amazme-epoch": str(host.lifecycle.fence.host_epoch),
        }) as client:
            attached = await client.post(f"/api/v1/sessions/{SESSION}/attachments")
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            saved = await client.post(f"/api/v1/sessions/{SESSION}/web", json={"enabled": True})
            assert saved.status_code == 200 and saved.json()["enabled"] is True
            missing = await client.post(f"/api/v1/sessions/{SESSION}/web/calls", json={
                "call_id": "none", "kind": "search", "query": "项目结构"})
            assert missing.status_code == 409 and missing.json()["code"] == "web_credential_missing"
            assert seen == [] and KEY not in missing.text
    finally:
        await host.sessions.web_client.aclose()
        await host.close()




def _model_transport(seen: list[httpx.Request]) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if b"transport" in request.content:
            raise httpx.ConnectError("down")
        if request.url.path.endswith("/fetch"):
            return httpx.Response(200, json={"title": "T", "content": "正文"})
        return httpx.Response(200, json={"results": [
            {"url": "https://example.com/a", "title": "A", "snippet": "s", "date": None}]})
    return httpx.MockTransport(handle)


async def _complete(messages: list[Message]) -> Completion:
    found: Completion | None = None
    async for item in stream(ProviderConfig(provider="faux"), messages, auth=Auth()):
        if isinstance(item, Completion):
            found = item
    assert found is not None
    return found


async def _until_idle(worker: Worker, seen: list[httpx.Request]) -> None:
    for _ in range(30):
        action = await worker.store.advance()
        if isinstance(action, Park):
            return
        if isinstance(action, Continue):
            continue
        if isinstance(action, (OpenEpoch, ToolInvocation, QueryTool, CloseEpoch)):
            raise AssertionError(type(action).__name__)
        if isinstance(action, ModelInvocation):
            await worker.store.advance(ModelReturned(action, await _complete(action.messages)))
            continue
        if isinstance(action, WebRetrieval):
            before = len(seen)
            outcome = await worker.perform(action)
            assert isinstance(outcome, WebReturned)
            await worker.perform(action)
            sent = 0 if outcome.phase == "refused" else 1
            assert len(seen) == before + sent
            if outcome.phase == "unknown":
                resumed = await worker.store.advance()
                assert isinstance(resumed, Continue) and len(seen) == before + sent
                continue
            await worker.store.advance(outcome)
            continue
        raise AssertionError(type(action).__name__)
    raise AssertionError("turn did not settle")


async def test_model_web_tool_stays_out_of_the_vm_and_does_not_replay(tmp_path: Path) -> None:
    host = _host(tmp_path)
    (tmp_path / "sessions" / SESSION).mkdir(parents=True)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    host.lifecycle.initialized = True
    await host.lifecycle.store.create_session(SESSION, CreateSession(title="网页工具"))
    worker = create_worker(host.lifecycle.profile, SESSION, "worker-web")
    await worker.store.initialize()
    fence = HostFence(host_epoch=1, build_id=worker.build)
    await worker.store.fence(fence)
    seen: list[httpx.Request] = []
    worker.web_client = httpx.AsyncClient(transport=_model_transport(seen), follow_redirects=False)
    try:
        await worker.store.accept(Submit(request_id="off", text="/web 项目结构"), fence)
        await _until_idle(worker, seen)
        assert seen == []
        off = next(item for item in (await worker.store.snapshot()).requests if item.request_id == "off")
        assert off.status == "failed" and off.error == "web_disabled"
        calls = await session_database_owner(worker.store).call(lambda db: db.execute("SELECT COUNT(*) FROM web_calls").fetchone()[0])
        assert calls == 0
        await worker.store.save_web_policy(WebPolicy(
            enabled=True, base_url="https://tools.example/v1/tools", send_original_question=True))
        await worker.store.accept(Submit(request_id="search", text="/web 项目结构"), fence)
        await _until_idle(worker, seen)
        assert len(seen) == 1
        sent = seen[0]
        assert str(sent.url) == "https://tools.example/v1/tools/search"
        assert sent.headers["authorization"] == f"Bearer {KEY}"
        assert "x-project" not in {name.lower() for name in sent.headers}
        assert SECRET_HEADER not in sent.headers.values()
        body = json.loads(sent.content)
        assert body["query"] == "项目结构" and body["ori_question"] == "/web 项目结构"
        assert "chat.example" not in str(sent.url) and KEY not in sent.content.decode()
        messages = await worker.store.messages("search")
        assert [item.role for item in messages] == ["user", "assistant", "tool", "assistant"]
        assert messages[1].tool_calls[0].name == "web_search"
        assert messages[2].tool_call_id == messages[1].tool_calls[0].id
        assert "https://example.com/a" in messages[2].content and messages[3].content == messages[2].content
        assert KEY not in messages[2].content and SECRET_HEADER not in messages[2].content
        search_receipt = next(item for item in (await worker.store.snapshot()).requests if item.request_id == "search")
        assert search_receipt.status == "succeeded" and search_receipt.answer == messages[2].content
        assert KEY not in search_receipt.answer
        await worker.store.accept(Submit(request_id="page", text="/fetch https://example.com/doc"), fence)
        await _until_idle(worker, seen)
        assert len(seen) == 2 and str(seen[1].url) == "https://tools.example/v1/tools/fetch"
        assert json.loads(seen[1].content) == {"url": "https://example.com/doc"}
        fetched = await worker.store.messages("page")
        page_tool = next(item for item in reversed(fetched) if item.role == "tool")
        assert "正文" in page_tool.content and KEY not in page_tool.content
        assert fetched[-1].role == "assistant" and fetched[-1].content == page_tool.content
        await worker.store.accept(Submit(request_id="lost", text="/web transport"), fence)
        await _until_idle(worker, seen)
        assert len(seen) == 3
        lost = next(item for item in (await worker.store.snapshot()).requests if item.request_id == "lost")
        assert lost.status == "unknown" and lost.error == "web_transport"
        payloads = await session_database_owner(worker.store).call(
            lambda db: [json.loads(row[0]) for row in db.execute("SELECT payload FROM web_calls")])
        assert any(item["phase"] == "unknown" and item["error"] == "web_transport" for item in payloads)
        assert all(KEY not in json.dumps(item) for item in payloads)
        runs = await session_database_owner(worker.store).call(lambda db: [row[0] for row in db.execute("SELECT payload FROM runs")])
        assert all("supervisor_id" not in row for row in runs)
    finally:
        await worker.web_client.aclose()
        await worker.store.close()
        await worker.supervisor.close()
        await host.close()


async def test_model_web_tool_without_a_key_does_not_reserve_a_call(tmp_path: Path) -> None:
    host = _host(tmp_path, provider="faux")
    (tmp_path / "sessions" / SESSION).mkdir(parents=True)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    host.lifecycle.initialized = True
    await host.lifecycle.store.create_session(SESSION, CreateSession(title="网页工具"))
    worker = create_worker(host.lifecycle.profile, SESSION, "worker-web")
    await worker.store.initialize()
    fence = HostFence(host_epoch=1, build_id=worker.build)
    await worker.store.fence(fence)
    seen: list[httpx.Request] = []
    worker.web_client = httpx.AsyncClient(transport=_model_transport(seen), follow_redirects=False)
    try:
        await worker.store.save_web_policy(WebPolicy(enabled=True, base_url="https://tools.example/v1/tools"))
        await worker.store.accept(Submit(request_id="none", text="/web 项目结构"), fence)
        await _until_idle(worker, seen)
        assert seen == []
        receipt = next(item for item in (await worker.store.snapshot()).requests if item.request_id == "none")
        assert receipt.status == "failed" and receipt.error == "web_credential_missing"
        calls = await session_database_owner(worker.store).call(lambda db: db.execute("SELECT COUNT(*) FROM web_calls").fetchone()[0])
        assert calls == 0
    finally:
        await worker.web_client.aclose()
        await worker.store.close()
        await worker.supervisor.close()
        await host.close()


def test_web_tools_are_not_container_commands() -> None:
    search = ToolCall(id="call", name="web_search", arguments=WebSearch(query="项目结构").model_dump_json())
    fetch = ToolCall(id="call", name="web_fetch", arguments=WebFetch(url="https://example.com/a").model_dump_json())
    for call in (search, fetch):
        with pytest.raises(BackendError, match="not_an_execution_tool"):
            command_for(call)


async def test_dispatch_opens_a_client_without_the_chat_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[dict[str, object]] = []
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"results": []}))
    real = httpx.AsyncClient

    def factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        opened.append(dict(kwargs))
        return real(transport=transport, follow_redirects=bool(kwargs.get("follow_redirects", False)))

    monkeypatch.setattr("amazme_backend.execution.web.client.httpx.AsyncClient", factory)
    outcome, status, _raw = await dispatch_web(
        "https://tools.example/v1/tools/search", {"query": "q", "count": 1, "need_content": False},
        KEY, WebPolicy(enabled=True, base_url="https://tools.example/v1/tools", max_response_bytes=1000), None)
    assert outcome == "ok" and status == 200
    assert opened == [{"follow_redirects": False}]
