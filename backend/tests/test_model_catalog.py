"""Model catalog selection persists without exposing the API key or clearing sessions."""
import asyncio
import json
import sqlite3
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from amazme_backend.agent.model import stream
from amazme_backend.ai.catalog import SELECTION_INDEX
from amazme_backend.ai.types import Auth
from amazme_backend.bootstrap.worker import create_worker
from amazme_backend.contracts import (
    BackendError,
    ConfigureProvider,
    CreateSession,
    CredentialUpdate,
    HostFence,
    Message,
    ProcessLease,
    Submission,
    Submit,
    UpdateModelSettings,
    UpdateRecord,
)
from amazme_backend.host.service import Host
from amazme_backend.host.store import HostStore
from amazme_backend.interfaces.http.application import application
from amazme_backend.platform.identity import build_id
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.layout import session_database
from amazme_backend.profiles.profile import Profile
from amazme_backend.sessions.types import ModelInvocation

SECRET = "sk-catalog-secret"
PARENT = "c" * 32


def write_profile(path: Path, *, provider: str = "deepseek", model: str = "deepseek-flash",
                  base_url: str = "https://api.deepseek.com", key: str = SECRET,
                  proxy: str = "", headers: dict[str, str] | None = None) -> None:
    private_write(path / "config.json", json.dumps({
        "format": 2, "profile_id": "catalog", "workspace": str(path), "resources": "unused", "user_resources":str(path / "agent"),
        "provider": {"provider": provider, "model": model, "base_url": base_url, "api_key": key,
                     "max_tokens": 2048, "proxy": proxy, "headers": headers or {}},
    }))
    private_write(path / "control.token", "private-control")
    private_write(path / "web.token", "web-only")


@pytest.fixture
async def owner(tmp_path: Path):
    write_profile(tmp_path)
    value = Host(Profile(tmp_path))
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    value.lifecycle.fence = HostFence(host_epoch=1, build_id=value.lifecycle.build)
    value.lifecycle.fence.host_epoch = await value.lifecycle.store.initialize(value.lifecycle.instance, value.lifecycle.build, lease)
    value.origin = "http://127.0.0.1:12345"
    await value.lifecycle.store.create_session(PARENT, CreateSession(title="保留"))
    try:
        yield value
    finally:
        await value.lifecycle.supervisor.close()
        await value.lifecycle.store.db.close()


async def test_catalog_lists_runnable_models_and_hides_the_key(owner: Host) -> None:
    catalog = owner.accounts.model_catalog()
    body = catalog.model_dump_json()
    assert SECRET not in body
    assert {"faux", "deepseek-flash", "deepseek-v4-pro"} <= {item.model for item in catalog.models}
    assert {"anthropic", "openai", "openai-codex", "google", "openrouter"} <= {item.provider for item in catalog.models}
    assert catalog.current.model == "deepseek-flash" and catalog.current.key_configured is True
    saved = await owner.accounts.update_model(UpdateModelSettings(
        provider="deepseek", model="deepseek-chat", base_url="https://gateway.example/v1", max_tokens=128, thinking="high"))
    assert saved.model == "deepseek-chat" and saved.base_url == "https://gateway.example/v1"
    assert SECRET not in saved.model_dump_json()
    raw = json.loads((owner.lifecycle.profile.path / "config.json").read_text())
    assert raw["provider"]["api_key"] == ""
    assert saved.thinking == "high" and raw["provider"]["thinking"] == "high"
    assert owner.accounts.accounts.secrets() == (SECRET,)
    assert raw["profile_id"] == "catalog"
    assert [item.session_id for item in (await owner.sessions.sessions()).sessions] == [PARENT]
    owner.lifecycle.profile.reload_provider()
    assert owner.lifecycle.profile.config.provider.model == "deepseek-chat"


async def test_rejected_choice_leaves_the_saved_provider(owner: Host) -> None:
    before = (owner.lifecycle.profile.path / "config.json").read_text()
    with pytest.raises(BackendError, match="invalid_model_endpoint"):
        await owner.accounts.update_model(UpdateModelSettings(
            provider="deepseek", model="deepseek-flash", base_url="http://insecure.example"))
    with pytest.raises(BackendError, match="invalid_model_endpoint"):
        await owner.accounts.update_model(UpdateModelSettings(
            provider="deepseek", model="deepseek-flash", base_url="https://user:secret@example.com/v1"))
    with pytest.raises(BackendError, match="model_not_available"):
        await owner.accounts.update_model(UpdateModelSettings(provider="faux", model="deepseek-flash"))
    assert (owner.lifecycle.profile.path / "config.json").read_text() == before
    await owner.accounts.replace_credential(CredentialUpdate(expected_revision=0, clear=True))
    owner.lifecycle.profile.reload_provider()
    with pytest.raises(BackendError, match="provider_not_configured"):
        await owner.accounts.update_model(UpdateModelSettings(
            provider="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com"))
    assert json.loads((owner.lifecycle.profile.path / "config.json").read_text())["provider"]["api_key"] == ""


async def test_provider_edit_does_not_choose_a_model_and_receipts_pin_original_endpoint(owner: Host) -> None:
    before = owner.lifecycle.profile.config.provider.model_dump_json()
    value = ConfigureProvider(operation_id="a" * 32, expected_revision=0, provider="openai", name="工作网关",
        api="openai-responses", base_url="https://gateway.example/v1")
    headers = {"Authorization": "Bearer web-only", "Origin": owner.origin,
        "x-amazme-build": owner.lifecycle.build, "x-amazme-epoch": str(owner.lifecycle.fence.host_epoch)}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(owner)), base_url=owner.origin, headers=headers) as client:
        first = await client.put("/api/v1/providers/openai", json=value.model_dump())
        assert first.status_code == 200 and first.json()["revision"] == 1
        owner.lifecycle.profile.reload_provider()
        assert owner.lifecycle.profile.config.provider.model_dump_json() == before
        catalog = (await client.get("/api/v1/models")).json()
        assert next(item for item in catalog["providers"] if item["provider"] == "openai")["name"] == "工作网关"
        assert {item["base_url"] for item in catalog["models"] if item["provider"] == "openai"} == {value.base_url}
        chosen = next(item for item in catalog["models"] if item["provider"] == "openai")
        submitted = Submit(request_id="hold-endpoint", text="hello", model_selection={"provider": "openai", "model": chosen["model"]})
        held = await owner.lifecycle.store.enqueue(PARENT, "submit", submitted.request_id, submitted, provider=owner.lifecycle.profile.config.provider,
            transports=owner.accounts.accounts.read().transports)
        changed = value.model_copy(update={"operation_id": "b" * 32, "expected_revision": 1, "base_url": "https://new.example/v1"})
        assert (await client.put("/api/v1/providers/openai", json=changed.model_dump())).status_code == 200
        assert (await client.put("/api/v1/providers/openai", json=value.model_dump())).json() == first.json()
        assert next(item for item in owner.accounts.accounts.provider_definitions() if item.provider == "openai").base_url == changed.base_url
        duplicate = await owner.lifecycle.store.enqueue(PARENT, "submit", submitted.request_id, submitted, provider=owner.lifecycle.profile.config.provider,
            transports=owner.accounts.accounts.read().transports)
        assert duplicate.provider == held.provider and held.provider.base_url == value.base_url and held.provider.api == value.api
        assert SECRET not in first.text + json.dumps(catalog) + held.model_dump_json()
        invalid = changed.model_copy(update={"operation_id": "c" * 32, "expected_revision": 2, "base_url": "https://user:secret@example.com"})
        rejected = await client.put("/api/v1/providers/openai", json=invalid.model_dump())
        assert rejected.status_code == 409 and rejected.json()["code"] == "invalid_model_endpoint"


async def test_custom_provider_catalog_and_old_configuration_receipts_preserve_new_defaults(owner: Host) -> None:
    from amazme_backend.interfaces.rpc import RpcCall, RpcParams, handle_rpc

    await owner.accounts.update_account("private-gateway", CredentialUpdate(expected_revision=0, api_key=SecretStr("gateway-private-key")))
    original = ConfigureProvider(operation_id="d" * 32, expected_revision=0, provider="private-gateway", name="本机网关",
        api="openai-responses", base_url="https://gateway.example/v1", model_ids=["one"])
    first = await owner.accounts.configure_provider(original)
    expanded = original.model_copy(update={"operation_id": "e" * 32, "expected_revision": 1, "model_ids": ["one", "two"]})
    await owner.accounts.configure_provider(expanded)
    await owner.accounts.update_model(UpdateModelSettings(provider=original.provider, model="two", api=original.api, base_url=original.base_url))
    result = await handle_rpc(owner, RpcCall(id="retry", method="provider.configure", params=RpcParams(provider_configuration=original)))
    assert result["result"] == first.model_dump(mode="json")
    catalog = owner.accounts.model_catalog()
    assert catalog.current.provider == original.provider and catalog.current.model == "two"
    assert {item.model for item in catalog.models if item.provider == original.provider} == {"one", "two"}
    with pytest.raises(BackendError, match="default_model_not_available"):
        await owner.accounts.configure_provider(original.model_copy(update={"operation_id": "f" * 32, "expected_revision": catalog.configuration_revision}))
    assert (await owner.accounts.accounts.resolve(original.provider)).key.get_secret_value() == "gateway-private-key"
    assert "gateway-private-key" not in catalog.model_dump_json() + json.dumps(result)


@pytest.mark.parametrize("target", ["session", "default"])
@pytest.mark.parametrize("credential_kind", ["api_key", "expired_oauth"])
async def test_model_save_rejects_excluded_models_before_persistence(
    owner: Host, monkeypatch: pytest.MonkeyPatch, target: str, credential_kind: str,
) -> None:
    from amazme_backend.accounts.oauth.flow import OAuthCredential
    from amazme_backend.accounts.store import ApiKeyCredential
    from amazme_backend.contracts import SessionModel

    await owner.accounts.configure_provider(ConfigureProvider(
        operation_id="1" * 32, expected_revision=0, provider="openai", api="openai-completions",
        base_url="https://gateway.example/v1", model_ids=["allowed-custom-model"],
    ))
    credential = (ApiKeyCredential(key=SecretStr("provider-key")) if credential_kind == "api_key" else
        OAuthCredential(access=SecretStr("expired-access"), refresh=SecretStr("refresh-token"), expires=1))
    await owner.accounts.accounts.set("openai", credential, 0)
    previous = await owner.accounts.save_session_model(SessionModel(session_id=PARENT, provider="faux", model="faux"))
    profile_before = (owner.lifecycle.profile.path / "config.json").read_bytes()
    accounts_before = owner.accounts.accounts.path.read_bytes()
    refreshes: list[str] = []

    async def renew(client: httpx.AsyncClient, provider: str, credential: OAuthCredential) -> OAuthCredential:
        refreshes.append(provider)
        return credential.model_copy(update={"access": SecretStr("renewed-access"), "expires": 2**60})

    monkeypatch.setattr("amazme_backend.accounts.store.refresh", renew)
    headers = {"Authorization": "Bearer web-only", "Origin": owner.origin,
        "x-amazme-build": owner.lifecycle.build, "x-amazme-epoch": str(owner.lifecycle.fence.host_epoch)}
    body = {"provider": "openai", "model": "gpt-5"}
    if target == "session":
        method, route = "PUT", f"/api/v1/session-models/{PARENT}"
        body["session_id"] = PARENT
    else:
        method, route = "POST", "/api/v1/models"
        body.update({"api": "openai-completions", "base_url": "https://override.example/v1"})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(owner)),
                                base_url=owner.origin, headers=headers) as client:
        rejected = await client.request(method, route, json=body)
        assert rejected.status_code == 409 and rejected.json()["code"] == "model_not_available"
        assert refreshes == []
        assert (owner.lifecycle.profile.path / "config.json").read_bytes() == profile_before
        assert owner.accounts.accounts.path.read_bytes() == accounts_before
        assert await owner.accounts.session_model(PARENT) == previous
        assert (await client.get("/api/v1/models")).status_code == 200

        body["model"] = "allowed-custom-model"
        accepted = await client.request(method, route, json=body)
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["model"] == "allowed-custom-model"
        if target == "session":
            assert (await owner.accounts.session_model(PARENT)).model == "allowed-custom-model"
            assert refreshes == [] and owner.accounts.accounts.path.read_bytes() == accounts_before
        else:
            assert owner.accounts.model_catalog().current.model == "allowed-custom-model"
            assert refreshes == (["openai"] if credential_kind == "expired_oauth" else [])


async def test_worker_submit_uses_the_reloaded_model_without_the_key(tmp_path: Path) -> None:
    write_profile(tmp_path, provider="faux", model="faux", base_url="", key=SECRET)
    profile = Profile(tmp_path)
    session = "d" * 32
    with sqlite3.connect(tmp_path / "host.sqlite") as db:
        db.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL)")
        db.execute("INSERT INTO sessions VALUES(?, 'primary')", (session,))
    (tmp_path / "sessions" / session).mkdir(parents=True)
    worker = create_worker(profile, session, "worker-1")
    worker.initialized = True
    worker.state = "ready"
    await worker.store.initialize()
    build = build_id()
    fence = HostFence(host_epoch=1, build_id=build)
    await worker.store.fence(fence)
    write_profile(tmp_path, provider="deepseek", model="deepseek-chat",
                  base_url="https://gateway.example/v1", key=SECRET,
                  proxy="http://user:pw@127.0.0.1:9", headers={"X-Project": "demo"})
    try:
        receipt = await worker.submit(Submission(**fence.model_dump(), value=Submit(request_id="turn", text="hello")))
        assert receipt.status == "queued"
        with sqlite3.connect(session_database(tmp_path, session)) as db:
            payload = db.execute("SELECT payload FROM runs WHERE request_id='turn'").fetchone()[0]
        assert "deepseek-chat" in payload and "https://gateway.example/v1" in payload
        stored = json.loads(payload)["config"]
        assert SECRET not in payload
        assert stored["api_key"] == "" and stored["proxy"] == "http://127.0.0.1:9" and stored["headers"] == {}
    finally:
        await worker.store.close()
        await worker.supervisor.close()


async def test_proxy_password_is_kept_but_not_published_or_recorded(owner: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    saved = await owner.accounts.update_model(UpdateModelSettings(
        provider="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com",
        proxy="http://user:pw@127.0.0.1:9", headers={"X-Project": "demo"}))
    assert saved.proxy == "http://127.0.0.1:9" and "pw" not in saved.model_dump_json()
    assert saved.headers == {"X-Project": "demo"}
    stored = json.loads((owner.lifecycle.profile.path / "config.json").read_text())["provider"]
    assert stored["proxy"] == "http://user:pw@127.0.0.1:9" and stored["headers"] == {"X-Project": "demo"}
    again = await owner.accounts.update_model(UpdateModelSettings(
        provider="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com",
        proxy=saved.proxy, headers={"X-Project": "demo"}))
    assert again.proxy == saved.proxy
    assert json.loads((owner.lifecycle.profile.path / "config.json").read_text())["provider"]["proxy"] == stored["proxy"]
    with pytest.raises(BackendError, match="invalid_proxy"):
        await owner.accounts.update_model(UpdateModelSettings(
            provider="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com",
            proxy="http://user:pw@127.0.0.1:9/path?token=secret"))
    with pytest.raises(BackendError, match="invalid_header"):
        await owner.accounts.update_model(UpdateModelSettings(
            provider="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com",
            headers={"Authorization": "secret"}))
    assert json.loads((owner.lifecycle.profile.path / "config.json").read_text())["provider"]["proxy"] == stored["proxy"]
    captured: dict[str, object] = {}

    class FakeHTTP:
        def __init__(self, **kwargs: object) -> None:
            captured["http"] = kwargs

        async def aclose(self) -> None:
            captured["closed"] = True

    class FakeOpenAI:
        def __init__(self, **kwargs: object) -> None:
            captured["openai"] = kwargs

        async def __aenter__(self) -> "FakeOpenAI":
            raise BackendError("stop-before-network")

        async def __aexit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr("amazme_backend.ai.providers.completions.httpx2.AsyncClient", FakeHTTP)
    monkeypatch.setattr("amazme_backend.ai.providers.completions.AsyncOpenAI", FakeOpenAI)
    configured = await owner.accounts.accounts.configured(owner.lifecycle.profile.config.provider)
    with pytest.raises(BackendError, match="stop-before-network"):
        async for _item in stream(configured, [Message(role="user", content="hi")], auth=Auth(api_key=configured.api_key, auth_type=configured.auth_type)):
            pass
    http_kwargs = captured["http"]
    openai_kwargs = captured["openai"]
    assert isinstance(http_kwargs, dict) and isinstance(openai_kwargs, dict)
    assert http_kwargs["proxy"] == "http://user:pw@127.0.0.1:9" and http_kwargs["trust_env"] is False
    assert openai_kwargs["default_headers"]["X-Project"] == "demo"
    assert openai_kwargs["default_headers"]["Authorization"] == "Bearer " + SECRET
    assert captured["closed"] is True


async def test_model_route_returns_the_saved_choice(owner: Host) -> None:
    app = application(owner)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin,
                                  headers={"Authorization": "Bearer web-only"}) as client:
        listed = await client.get("/api/v1/models")
        assert listed.status_code == 200 and SECRET not in listed.text
        client.headers.update({"x-amazme-build": owner.lifecycle.build, "x-amazme-epoch": str(owner.lifecycle.fence.host_epoch)})
        saved = await client.post("/api/v1/models", json={
            "provider": "faux", "model": "faux", "base_url": "", "max_tokens": 2048})
        assert saved.status_code == 200
        body = saved.json()
        assert body["provider"] == "faux" and body["model"] == "faux" and "api_key" not in body
        assert SECRET not in saved.text
        leaked = await client.post("/api/v1/models", json={
            "provider": "faux", "model": "faux", "base_url": "", "max_tokens": 2048, "api_key": SECRET})
        assert leaked.status_code == 422 and SECRET not in leaked.text
        assert owner.accounts.accounts.read().credentials["deepseek"].key.get_secret_value() == SECRET


async def test_credential_revision_keeps_one_key_and_a_cleared_key_is_not_sent(owner: Host, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    first = CredentialUpdate(expected_revision=0, api_key=SecretStr("sk-rotate-one"))
    second = CredentialUpdate(expected_revision=0, api_key=SecretStr("sk-rotate-two"))
    results = await asyncio.gather(owner.accounts.replace_credential(first), owner.accounts.replace_credential(second), return_exceptions=True)
    saved = [item for item in results if not isinstance(item, Exception)]
    failed = [item for item in results if isinstance(item, Exception)]
    assert len(saved) == 1 and len(failed) == 1
    assert isinstance(failed[0], BackendError) and failed[0].code == "credential_conflict"
    published = saved[0].model_dump_json()
    assert "sk-rotate-one" not in published and "sk-rotate-two" not in published
    assert saved[0].key_configured is True and saved[0].credential_revision == 1
    stored = json.loads((owner.lifecycle.profile.path / "config.json").read_text())
    assert stored["credential_revision"] == 1
    assert stored["provider"]["api_key"] == ""
    winner = owner.accounts.accounts.read().credentials["deepseek"].key.get_secret_value()
    assert winner in {"sk-rotate-one", "sk-rotate-two"}
    with pytest.raises(BackendError, match="credential_conflict"):
        await owner.accounts.replace_credential(CredentialUpdate(expected_revision=0, api_key=SecretStr("sk-rotate-stale")))
    assert owner.accounts.accounts.read().credentials["deepseek"].key.get_secret_value() == winner
    changed = await owner.accounts.update_model(UpdateModelSettings(
        provider="deepseek", model="deepseek-chat", base_url="https://gateway.example/v1"))
    assert changed.credential_revision == 1 and winner not in changed.model_dump_json()
    assert owner.accounts.accounts.read().credentials["deepseek"].key.get_secret_value() == winner
    frozen = UpdateRecord(update_id="upgrade", source_build="src", target_build="dst",
                          phase="freezing", revision="1", cancel_work=False)
    database = sqlite3.connect(owner.lifecycle.profile.path / "host.sqlite")
    database.execute("INSERT INTO updates(id, payload) VALUES(?,?)", ("upgrade", frozen.model_dump_json()))
    database.execute("UPDATE control SET freeze_id='upgrade' WHERE id=1")
    database.commit()
    with pytest.raises(BackendError, match="update_frozen"):
        await owner.accounts.replace_credential(CredentialUpdate(expected_revision=1, clear=True))
    assert owner.accounts.accounts.read().credentials["deepseek"].key.get_secret_value() == winner
    database.execute("UPDATE control SET freeze_id='' WHERE id=1")
    database.commit()
    database.close()
    with pytest.raises(BackendError, match="credential_conflict"):
        await owner.accounts.replace_credential(CredentialUpdate(expected_revision=1, clear=True, api_key=SecretStr(winner)))
    with pytest.raises(BackendError, match="invalid_credential"):
        await owner.accounts.replace_credential(CredentialUpdate(expected_revision=1, api_key=SecretStr("")))
    cleared = await owner.accounts.replace_credential(CredentialUpdate(expected_revision=1, clear=True))
    assert cleared.key_configured is False and cleared.credential_revision == 2
    assert winner not in cleared.model_dump_json()
    assert json.loads((owner.lifecycle.profile.path / "config.json").read_text())["provider"]["api_key"] == ""
    with pytest.raises(BackendError, match="provider_not_configured"):
        await owner.accounts.update_model(UpdateModelSettings(
            provider="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com"))
    called = False

    class FakeOpenAI:
        def __init__(self, **_kwargs: object) -> None:
            nonlocal called
            called = True

        async def __aenter__(self) -> "FakeOpenAI":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr("amazme_backend.ai.providers.completions.AsyncOpenAI", FakeOpenAI)
    empty = owner.lifecycle.profile.config.provider
    with pytest.raises(BackendError, match="provider_not_configured"):
        async for _item in stream(empty, [Message(role="user", content="hi")], auth=Auth(api_key=empty.api_key, auth_type=empty.auth_type)):
            pass
    assert called is False

    send_root = tmp_path / "send-profile"
    send_root.mkdir()
    write_profile(send_root, provider="deepseek", model="deepseek-flash", key="sk-before-send")
    profile = Profile(send_root)
    session = "e" * 32
    (send_root / "sessions" / session).mkdir(parents=True)
    metadata = HostStore(send_root / "host.sqlite")
    await metadata.initialize("credential-host", build_id(), ProcessLease(
        instance_id="credential-host", role="host", profile_path=str(send_root),
        path=str(send_root / "lease"), device=1, inode=1))
    await metadata.create_session(session, CreateSession(title="credential rotation"))
    await metadata.db.close()
    worker = create_worker(profile, session, "worker-key")
    worker.initialized = True
    worker.state = "ready"
    await worker.store.initialize()
    held = profile.config.provider
    seen: dict[str, str] = {}

    async def fake_stream(config, _messages, _offers=None, _plugins=None, *, auth: Auth):
        seen["key"] = auth.api_key.get_secret_value()
        if seen["key"]:
            raise BackendError("stop-before-network")
        yield ""

    monkeypatch.setattr("amazme_backend.agent.driver.stream", fake_stream)
    write_profile(send_root, provider="deepseek", model="deepseek-flash", key="sk-after-send")
    try:
        with pytest.raises(BackendError, match="stop-before-network"):
            await worker.perform(ModelInvocation(
                step_id="step", request_id="turn", generation=1,
                messages=[Message(role="user", content="hi")], config=held))
        assert seen["key"] == "sk-after-send"
        assert held.api_key.get_secret_value() == "sk-before-send"
        write_profile(send_root, provider="deepseek", model="deepseek-flash", key="")
        seen.clear()
        with pytest.raises(BackendError, match="provider_not_configured"):
            await worker.perform(ModelInvocation(
                step_id="step", request_id="turn", generation=1,
                messages=[Message(role="user", content="hi")], config=held))
        assert "key" not in seen
        assert json.loads((send_root / "config.json").read_text())["provider"]["api_key"] == ""
    finally:
        await worker.store.close()
        await worker.supervisor.close()




@pytest.mark.parametrize("endpoint", ["http://127.0.0.1:11434/v1", "http://[::1]:11434/v1", "http://localhost:11434/v1"])
async def test_native_loopback_model_endpoint(owner: Host, endpoint: str) -> None:
    saved = await owner.accounts.update_model(UpdateModelSettings(provider="deepseek",model="local-model",base_url=endpoint))
    assert saved.base_url == endpoint and saved.key_configured


@pytest.mark.parametrize("endpoint", ["http://localhost.evil.example/v1", "http://192.168.1.1/v1", "http://127.0.0.1@evil.example/v1", "http://localhost/v1?token=secret"])
async def test_http_endpoint_cannot_bypass_external_tls(owner: Host, endpoint: str) -> None:
    with pytest.raises(BackendError,match="invalid_model_endpoint"):
        await owner.accounts.update_model(UpdateModelSettings(provider="deepseek",model="local-model",base_url=endpoint))


async def test_model_scope_http_sdk_and_rpc_share_python_resolution(owner) -> None:
    from amazme_backend.sdk import Client

    headers = {"Authorization":"Bearer web-only", "Origin":owner.origin,
        "x-amazme-build":owner.lifecycle.build,"x-amazme-epoch":str(owner.lifecycle.fence.host_epoch)}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(owner)),base_url=owner.origin,headers=headers) as http:
        patterns = ["deepseek/deepseek-flash:high","deepseek/deepseek-v4-pro"]
        response = await http.post("/api/v1/models/scope",json={"patterns":patterns})
        assert response.status_code == 200
        assert [(item["model"]["provider"],item["model"]["model"],item["thinking"]) for item in response.json()["models"]] == [
            ("deepseek","deepseek-flash","high"),("deepseek","deepseek-v4-pro",None)]
        client = Client(owner.origin,"web-only")
        await client._http.aclose()
        client._http = http
        await client.bootstrap()
        assert (await client.model_scope(patterns)).model_dump() == response.json()
        rpc = await http.post("/api/v1/rpc",json={"jsonrpc":"2.0","id":"scope","method":"model.scope", "params":{"model_scope":{"patterns":patterns}}})
        assert rpc.status_code == 200 and rpc.json()["result"] == response.json()
        assert SECRET not in response.text


async def test_model_scope_keeps_the_configured_custom_model_and_endpoint(owner) -> None:
    from amazme_backend.contracts import ModelScopeRequest, ModelSelection
    from amazme_backend.profiles.configuration import selected_provider

    custom = owner.lifecycle.profile.config.provider.model_copy(update={"model":"custom-chat","base_url":"https://example.invalid/v1"})
    owner.lifecycle.profile.save_provider(custom)
    found = owner.accounts.model_scope(ModelScopeRequest(patterns=["deepseek/custom-chat"]))
    assert len(found.models) == 1 and found.models[0].model.model == "custom-chat"
    captured = selected_provider(custom,ModelSelection(provider="deepseek",model="custom-chat"), catalog=SELECTION_INDEX)
    assert captured.base_url == custom.base_url and not captured.api_key.get_secret_value()
