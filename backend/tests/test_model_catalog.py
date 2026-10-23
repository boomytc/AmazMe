"""Model catalog selection persists without exposing the API key or clearing sessions."""
import base64
import json
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest

from amazme_backend.common import Profile, build_id, private_write
from amazme_backend.contracts import (
    BackendError,
    CreateSession,
    HostFence,
    Message,
    ProcessLease,
    Stream,
    Submission,
    Submit,
    UpdateModelSettings,
)
from amazme_backend.host import Host, application
from amazme_backend.providers import stream
from amazme_backend.worker import Worker

SECRET = "sk-catalog-secret"
PARENT = "c" * 32


def write_profile(path: Path, *, provider: str = "deepseek", model: str = "deepseek-flash",
                  base_url: str = "https://api.deepseek.com", key: str = SECRET,
                  proxy: str = "", headers: dict[str, str] | None = None) -> None:
    private_write(path / "config.json", json.dumps({
        "format": 2, "profile_id": "catalog", "workspace": str(path), "resources": "unused",
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
    assert {item.model for item in catalog.models} == {"faux", "deepseek-flash"}
    assert catalog.current.model == "deepseek-flash" and catalog.current.key_configured is True
    saved = await owner.update_model(UpdateModelSettings(
        provider="deepseek", model="deepseek-chat", base_url="https://gateway.example/v1", max_tokens=128))
    assert saved.model == "deepseek-chat" and saved.base_url == "https://gateway.example/v1"
    assert SECRET not in saved.model_dump_json()
    raw = json.loads((owner.profile.path / "config.json").read_text())
    assert raw["provider"]["api_key"] == SECRET
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
    write_profile(owner.profile.path, key="")
    owner.profile.reload_provider()
    with pytest.raises(BackendError, match="provider_not_configured"):
        await owner.update_model(UpdateModelSettings(
            provider="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com"))
    assert json.loads((owner.profile.path / "config.json").read_text())["provider"]["api_key"] == ""


async def test_worker_submit_uses_the_reloaded_model_without_the_key(tmp_path: Path) -> None:
    write_profile(tmp_path, provider="faux", model="faux", base_url="", key=SECRET)
    profile = Profile(tmp_path)
    session = "d" * 32
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
        async for _item in stream(owner.profile.config.provider, [Message(role="user", content="hi")]):
            pass
    http_kwargs = captured["http"]
    openai_kwargs = captured["openai"]
    assert isinstance(http_kwargs, dict) and isinstance(openai_kwargs, dict)
    assert http_kwargs["proxy"] == "http://user:pw@127.0.0.1:9" and http_kwargs["trust_env"] is False
    assert openai_kwargs["default_headers"] == {"X-Project": "demo"}
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
            assert.equal(options.headers['x-amazme-build'],'build');
            current={provider:'faux',model:'faux',base_url:'',max_tokens:body.max_tokens,key_configured:true};
            return response(current);
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
        $('model-choice').value='faux\nfaux';
        $('model-choice').onchange();
        $('model-proxy').value='http://127.0.0.1:9';
        $('model-headers').value='X-Project: demo';
        assert.equal($('model-endpoint').disabled, true);
        await $('model-form').onsubmit({preventDefault(){}});
        await until(()=>$('model-choice').value==='faux\nfaux' && $('model-endpoint').value==='' && $('model-endpoint').disabled===true);
        window.happyDOM && await window.happyDOM.abort();
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
