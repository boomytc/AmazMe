"""Model catalog selection persists without exposing the API key or clearing sessions."""
import asyncio
import base64
import json
import shutil
import sqlite3
import subprocess
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from amazme_backend.common import Profile, build_id, private_write
from amazme_backend.contracts import (
    BackendError,
    CreateSession,
    CredentialUpdate,
    HostFence,
    Message,
    ProcessLease,
    Stream,
    Submission,
    Submit,
    UpdateModelSettings,
    UpdateRecord,
)
from amazme_backend.host import Host, application
from amazme_backend.host_store import HostStore
from amazme_backend.providers import stream
from amazme_backend.session_domain import ModelInvocation
from amazme_backend.worker import Worker

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
    value.fence = HostFence(host_epoch=1, build_id=value.build)
    value.fence.host_epoch = await value.store.initialize(value.instance, value.build, lease)
    value.origin = "http://127.0.0.1:12345"
    await value.store.create_session(PARENT, CreateSession(title="保留"))
    try:
        yield value
    finally:
        await value.supervisor.close()
        await value.store.db.close()


async def test_catalog_lists_runnable_models_and_hides_the_key(owner: Host) -> None:
    catalog = owner.model_catalog()
    body = catalog.model_dump_json()
    assert SECRET not in body
    assert {"faux", "deepseek-flash", "deepseek-v4-pro"} <= {item.model for item in catalog.models}
    assert {"anthropic", "openai", "openai-codex", "google", "openrouter"} <= {item.provider for item in catalog.models}
    assert catalog.current.model == "deepseek-flash" and catalog.current.key_configured is True
    saved = await owner.update_model(UpdateModelSettings(
        provider="deepseek", model="deepseek-chat", base_url="https://gateway.example/v1", max_tokens=128))
    assert saved.model == "deepseek-chat" and saved.base_url == "https://gateway.example/v1"
    assert SECRET not in saved.model_dump_json()
    raw = json.loads((owner.profile.path / "config.json").read_text())
    assert raw["provider"]["api_key"] == ""
    assert owner.accounts.secrets() == (SECRET,)
    assert raw["profile_id"] == "catalog"
    assert [item.session_id for item in (await owner.sessions()).sessions] == [PARENT]
    owner.profile.reload_provider()
    assert owner.profile.config.provider.model == "deepseek-chat"


async def test_rejected_choice_leaves_the_saved_provider(owner: Host) -> None:
    before = (owner.profile.path / "config.json").read_text()
    with pytest.raises(BackendError, match="invalid_model_endpoint"):
        await owner.update_model(UpdateModelSettings(
            provider="deepseek", model="deepseek-flash", base_url="http://insecure.example"))
    with pytest.raises(BackendError, match="invalid_model_endpoint"):
        await owner.update_model(UpdateModelSettings(
            provider="deepseek", model="deepseek-flash", base_url="https://user:secret@example.com/v1"))
    with pytest.raises(BackendError, match="model_not_available"):
        await owner.update_model(UpdateModelSettings(provider="faux", model="deepseek-flash"))
    assert (owner.profile.path / "config.json").read_text() == before
    await owner.replace_credential(CredentialUpdate(expected_revision=0, clear=True))
    owner.profile.reload_provider()
    with pytest.raises(BackendError, match="provider_not_configured"):
        await owner.update_model(UpdateModelSettings(
            provider="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com"))
    assert json.loads((owner.profile.path / "config.json").read_text())["provider"]["api_key"] == ""


async def test_worker_submit_uses_the_reloaded_model_without_the_key(tmp_path: Path) -> None:
    write_profile(tmp_path, provider="faux", model="faux", base_url="", key=SECRET)
    profile = Profile(tmp_path)
    session = "d" * 32
    with sqlite3.connect(tmp_path / "host.sqlite") as db:
        db.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL)")
        db.execute("INSERT INTO sessions VALUES(?, 'primary')", (session,))
    (tmp_path / "sessions" / session).mkdir(parents=True)
    worker = Worker(profile, session, "worker-1")
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
        payload = await worker.store.db.call(lambda db: db.execute(
            "SELECT payload FROM runs WHERE request_id='turn'").fetchone()[0])
        assert "deepseek-chat" in payload and "https://gateway.example/v1" in payload
        assert SECRET not in payload and "pw" not in payload and "demo" not in payload
    finally:
        await worker.store.db.close()
        await worker.supervisor.close()


async def test_proxy_password_is_kept_but_not_published_or_recorded(owner: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    saved = await owner.update_model(UpdateModelSettings(
        provider="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com",
        proxy="http://user:pw@127.0.0.1:9", headers={"X-Project": "demo"}))
    assert saved.proxy == "http://127.0.0.1:9" and "pw" not in saved.model_dump_json()
    assert saved.headers == {"X-Project": "demo"}
    stored = json.loads((owner.profile.path / "config.json").read_text())["provider"]
    assert stored["proxy"] == "http://user:pw@127.0.0.1:9" and stored["headers"] == {"X-Project": "demo"}
    again = await owner.update_model(UpdateModelSettings(
        provider="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com",
        proxy=saved.proxy, headers={"X-Project": "demo"}))
    assert again.proxy == saved.proxy
    assert json.loads((owner.profile.path / "config.json").read_text())["provider"]["proxy"] == stored["proxy"]
    with pytest.raises(BackendError, match="invalid_proxy"):
        await owner.update_model(UpdateModelSettings(
            provider="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com",
            proxy="http://user:pw@127.0.0.1:9/path?token=secret"))
    with pytest.raises(BackendError, match="invalid_header"):
        await owner.update_model(UpdateModelSettings(
            provider="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com",
            headers={"Authorization": "secret"}))
    assert json.loads((owner.profile.path / "config.json").read_text())["provider"]["proxy"] == stored["proxy"]
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

    monkeypatch.setattr("amazme_backend.providers.httpx2.AsyncClient", FakeHTTP)
    monkeypatch.setattr("amazme_backend.providers.AsyncOpenAI", FakeOpenAI)
    with pytest.raises(BackendError, match="stop-before-network"):
        async for _item in stream(await owner.accounts.configured(owner.profile.config.provider), [Message(role="user", content="hi")]):
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
        client.headers.update({"x-amazme-build": owner.build, "x-amazme-epoch": str(owner.fence.host_epoch)})
        saved = await client.post("/api/v1/models", json={
            "provider": "faux", "model": "faux", "base_url": "", "max_tokens": 2048})
        assert saved.status_code == 200
        body = saved.json()
        assert body["provider"] == "faux" and body["model"] == "faux" and "api_key" not in body
        assert SECRET not in saved.text
        leaked = await client.post("/api/v1/models", json={
            "provider": "faux", "model": "faux", "base_url": "", "max_tokens": 2048, "api_key": SECRET})
        assert leaked.status_code == 422 and SECRET not in leaked.text
        assert owner.accounts.read().credentials["deepseek"].key.get_secret_value() == SECRET


async def test_credential_revision_keeps_one_key_and_a_cleared_key_is_not_sent(owner: Host, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    first = CredentialUpdate(expected_revision=0, api_key=SecretStr("sk-rotate-one"))
    second = CredentialUpdate(expected_revision=0, api_key=SecretStr("sk-rotate-two"))
    results = await asyncio.gather(owner.replace_credential(first), owner.replace_credential(second), return_exceptions=True)
    saved = [item for item in results if not isinstance(item, Exception)]
    failed = [item for item in results if isinstance(item, Exception)]
    assert len(saved) == 1 and len(failed) == 1
    assert isinstance(failed[0], BackendError) and failed[0].code == "credential_conflict"
    published = saved[0].model_dump_json()
    assert "sk-rotate-one" not in published and "sk-rotate-two" not in published
    assert saved[0].key_configured is True and saved[0].credential_revision == 1
    stored = json.loads((owner.profile.path / "config.json").read_text())
    assert stored["credential_revision"] == 1
    assert stored["provider"]["api_key"] == ""
    winner = owner.accounts.read().credentials["deepseek"].key.get_secret_value()
    assert winner in {"sk-rotate-one", "sk-rotate-two"}
    with pytest.raises(BackendError, match="credential_conflict"):
        await owner.replace_credential(CredentialUpdate(expected_revision=0, api_key=SecretStr("sk-rotate-stale")))
    assert owner.accounts.read().credentials["deepseek"].key.get_secret_value() == winner
    changed = await owner.update_model(UpdateModelSettings(
        provider="deepseek", model="deepseek-chat", base_url="https://gateway.example/v1"))
    assert changed.credential_revision == 1 and winner not in changed.model_dump_json()
    assert owner.accounts.read().credentials["deepseek"].key.get_secret_value() == winner
    frozen = UpdateRecord(update_id="upgrade", source_build="src", target_build="dst",
                          phase="freezing", revision="1", cancel_work=False)
    database = sqlite3.connect(owner.profile.path / "host.sqlite")
    database.execute("INSERT INTO updates(id, payload) VALUES(?,?)", ("upgrade", frozen.model_dump_json()))
    database.execute("UPDATE control SET freeze_id='upgrade' WHERE id=1")
    database.commit()
    with pytest.raises(BackendError, match="update_frozen"):
        await owner.replace_credential(CredentialUpdate(expected_revision=1, clear=True))
    assert owner.accounts.read().credentials["deepseek"].key.get_secret_value() == winner
    database.execute("UPDATE control SET freeze_id='' WHERE id=1")
    database.commit()
    database.close()
    with pytest.raises(BackendError, match="credential_conflict"):
        await owner.replace_credential(CredentialUpdate(expected_revision=1, clear=True, api_key=SecretStr(winner)))
    with pytest.raises(BackendError, match="invalid_credential"):
        await owner.replace_credential(CredentialUpdate(expected_revision=1, api_key=SecretStr("")))
    cleared = await owner.replace_credential(CredentialUpdate(expected_revision=1, clear=True))
    assert cleared.key_configured is False and cleared.credential_revision == 2
    assert winner not in cleared.model_dump_json()
    assert json.loads((owner.profile.path / "config.json").read_text())["provider"]["api_key"] == ""
    with pytest.raises(BackendError, match="provider_not_configured"):
        await owner.update_model(UpdateModelSettings(
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

    monkeypatch.setattr("amazme_backend.providers.AsyncOpenAI", FakeOpenAI)
    empty = owner.profile.config.provider
    with pytest.raises(BackendError, match="provider_not_configured"):
        async for _item in stream(empty, [Message(role="user", content="hi")]):
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
    worker = Worker(profile, session, "worker-key")
    worker.initialized = True
    worker.state = "ready"
    await worker.store.initialize()
    held = profile.config.provider
    seen: dict[str, str] = {}

    async def fake_stream(config, _messages, _offers=None, _plugins=None):
        seen["key"] = config.api_key.get_secret_value()
        if seen["key"]:
            raise BackendError("stop-before-network")
        yield ""

    monkeypatch.setattr("amazme_backend.worker.stream", fake_stream)
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
        await worker.store.db.close()
        await worker.supervisor.close()


def test_browser_saves_the_selected_catalog_model() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node unavailable")
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    contract = (web / "contract.js").read_text().split("\n", 1)[1]
    contract = "const root = " + json.dumps(Stream.model_json_schema()) + ";\n" + contract
    url = "data:text/javascript;base64," + base64.b64encode(contract.encode()).decode()
    source = (web / "app.js").read_text().replace('"/contract.js"', json.dumps(url))
    app_url = "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,sessionStorage:window.sessionStorage});
        const identity = {build_id:'build',host_epoch:1,state:'ready'};
        let current = {provider:'deepseek',model:'deepseek-flash',base_url:'https://api.deepseek.com',max_tokens:2048,key_configured:true};
        const models = [
          {provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false},
          {provider:'deepseek',model:'deepseek-flash',label:'DeepSeek Flash',endpoint_editable:true}];
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        globalThis.fetch = async (path, options={})=>{
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/sessions') return response({sessions:[]});
          if(path==='/api/v1/models' && (options.method||'GET')==='GET') return response({models,current});
          if(path==='/api/v1/models') {
            const body=JSON.parse(options.body);
            assert.equal(body.provider,'faux');
            assert.equal(body.model,'faux');
            assert.equal(body.proxy,'http://127.0.0.1:9');
            assert.deepEqual(body.headers,{'X-Project':'demo'});
            assert.equal(body.api_key, undefined);
            assert.equal(options.headers['x-amazme-build'],'build');
            current={provider:'faux',model:'faux',base_url:'',max_tokens:body.max_tokens,key_configured:true,credential_revision:0};
            return response(current);
          }
          if(path==='/api/v1/accounts/faux') {
            const body=JSON.parse(options.body);
            assert.equal(options.headers['x-amazme-build'],'build');
            if(body.clear) {
              assert.equal(body.api_key,'');
              assert.equal(body.expected_revision, 1);
              current={...current, key_configured:false, credential_revision:2};
              return response({revision:2,accounts:[]});
            }
            assert.equal(body.api_key,'next-secret');
            assert.equal(body.clear, false);
            assert.equal(body.expected_revision, 0);
            current={...current, key_configured:true, credential_revision:1};
            return response({revision:1,accounts:[{provider:'faux',type:'api_key'}]});
          }
          throw Error('unexpected '+path);
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent);
        }
        await import(appURL);
        await until(()=>$('model-choice').selectedOptions[0]?.textContent==='DeepSeek Flash');
        assert.equal($('model-key-state').textContent, '密钥已配置');
        assert.equal($('model-key').value, '');
        $('model-choice').value='faux\nfaux';
        $('model-choice').onchange();
        $('model-proxy').value='http://127.0.0.1:9';
        $('model-headers').value='X-Project: demo';
        assert.equal($('model-endpoint').disabled, true);
        await $('model-form').onsubmit({preventDefault(){}});
        await until(()=>$('model-choice').value==='faux\nfaux' && $('model-endpoint').value==='' && $('model-endpoint').disabled===true);
        $('model-key').value = 'next-secret';
        $('model-key-save').click();
        await until(()=>$('model-key-state').textContent==='账号已配置' && $('model-key').value==='');
        $('model-key-clear').click();
        await until(()=>$('model-key-state').textContent==='账号未配置' && $('model-key').value==='');
        window.happyDOM && await window.happyDOM.abort();
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]


@pytest.mark.parametrize("endpoint", ["http://127.0.0.1:11434/v1", "http://[::1]:11434/v1", "http://localhost:11434/v1"])
async def test_native_loopback_model_endpoint(owner: Host, endpoint: str) -> None:
    saved = await owner.update_model(UpdateModelSettings(provider="deepseek",model="local-model",base_url=endpoint))
    assert saved.base_url == endpoint and saved.key_configured


@pytest.mark.parametrize("endpoint", ["http://localhost.evil.example/v1", "http://192.168.1.1/v1", "http://127.0.0.1@evil.example/v1", "http://localhost/v1?token=secret"])
async def test_http_endpoint_cannot_bypass_external_tls(owner: Host, endpoint: str) -> None:
    with pytest.raises(BackendError,match="invalid_model_endpoint"):
        await owner.update_model(UpdateModelSettings(provider="deepseek",model="local-model",base_url=endpoint))
