"""Provider credentials preserve ownership, rotation and Pi's OAuth wire identity."""

import asyncio
import json
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from pydantic import SecretStr

from amazme_backend.accounts.store import AccountStore, ApiKeyCredential
from amazme_backend.platform.private_files import private_write
from amazme_backend.contracts import BackendError, ProviderConfig
from amazme_backend.accounts.oauth.flow import BROWSER, DEVICE, Login, OAuthCredential
from amazme_backend.contracts.accounts import OAuthStart, OAuthView


def store(path: Path) -> AccountStore:
    private_write(path / 'config.json', json.dumps({
        'profile_id': 'accounts', 'workspace': str(path), 'resources': 'unused',
        'provider': {'provider': 'deepseek', 'api_key': 'legacy-secret'}}))
    return AccountStore(path)


async def test_vault_preserves_other_accounts_and_checks_revision(tmp_path: Path) -> None:
    accounts = store(tmp_path)
    first = await accounts.set('openrouter', ApiKeyCredential(key=SecretStr('router-key')), 0)
    assert first.revision == 1
    assert {item.provider for item in first.accounts} == {'deepseek', 'openrouter'}
    assert 'router-key' not in first.model_dump_json()
    with pytest.raises(BackendError, match='credential_conflict'):
        await accounts.set('deepseek', None, 0)
    assert (await accounts.resolve('deepseek')).key.get_secret_value() == 'legacy-secret'
    await accounts.set('openrouter', None, 1)
    assert await accounts.resolve('openrouter') is None
    assert (accounts.path.stat().st_mode & 0o777) == 0o600
    assert accounts.secrets() == ('legacy-secret',)


async def test_ambiguous_refresh_is_not_replayed_and_cannot_erase_newer_credentials(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    accounts = store(tmp_path)
    old = OAuthCredential(access=SecretStr('expired'), refresh=SecretStr('refresh'), expires=1)
    await accounts.set('xai', old, 0)
    attempted = []

    async def fail(client, provider, credential):
        attempted.append(provider)
        raise BackendError('oauth_request_failed')
    monkeypatch.setattr('amazme_backend.accounts.store.refresh', fail)
    with pytest.raises(BackendError, match='oauth_request_failed'):
        await accounts.resolve('xai')
    with pytest.raises(BackendError, match='oauth_login_required'):
        await accounts.resolve('xai')
    assert attempted == ['xai']
    assert next(item for item in accounts.view().accounts if item.provider == 'xai').login_required
    fresh = old.model_copy(update={'access': SecretStr('fresh'), 'expires': int(time.time() * 1000) + 100000})
    await accounts.set('xai', fresh, 1)
    assert (await accounts.resolve('xai')).access.get_secret_value() == 'fresh'


async def test_parallel_refreshes_share_the_persisted_winner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    accounts = store(tmp_path)
    await accounts.set('xai', OAuthCredential(access=SecretStr('old'), refresh=SecretStr('refresh'), expires=1), 0)
    attempts = []

    async def renew(client, provider, credential):
        attempts.append(provider)
        await asyncio.sleep(0.01)
        return OAuthCredential(access=SecretStr('new'), refresh=SecretStr('rotated'),
                               expires=int(time.time() * 1000) + 100000)
    monkeypatch.setattr('amazme_backend.accounts.store.refresh', renew)
    one, two = await asyncio.gather(accounts.resolve('xai'), AccountStore(tmp_path).resolve('xai'))
    assert one == two and attempts == ['xai']
    assert accounts.view().revision == 2
    assert 'rotated' in accounts.secrets()


async def test_queued_provider_uses_its_own_transport_after_selection_changes(tmp_path: Path) -> None:
    accounts = store(tmp_path)
    await accounts.ensure()
    await accounts.set('openrouter', ApiKeyCredential(key=SecretStr('router-key')), 0)

    async def guard() -> None:
        pass

    await accounts.save_transport(ProviderConfig(provider='openrouter', model='router/model',
        proxy='http://127.0.0.1:9001', headers={'X-Project': 'router'}), guard)
    held = ProviderConfig(provider='deepseek', model='deepseek-flash', headers={})
    deepseek = await accounts.configured(held)
    router = await accounts.configured(held.model_copy(update={'provider': 'openrouter'}))
    assert deepseek.headers == {} and deepseek.proxy == ''
    assert deepseek.api_key.get_secret_value() == 'legacy-secret'
    assert router.headers == {'X-Project': 'router'} and router.proxy == 'http://127.0.0.1:9001'
    assert router.api_key.get_secret_value() == 'router-key'


async def test_openrouter_callback_is_one_shot_and_exchange_uses_pi_pkce() -> None:
    request = OAuthStart(login_id='a' * 32, provider='openrouter', expected_revision=0)
    login = Login(request, OAuthView(login_id=request.login_id, provider=request.provider, phase='pending'))
    await login.begin_browser()
    try:
        query = parse_qs(urlsplit(login.view.url).query)
        assert login.view.url.startswith('https://openrouter.ai/auth?')
        assert query['callback_url'] == [login.redirect_uri]
        assert query['code_challenge_method'] == ['S256']
        assert 'client_id' not in query
        async with httpx.AsyncClient(trust_env=False) as client:
            reply = await client.get(login.redirect_uri + '?code=issued')
        assert reply.status_code == 200
        assert await asyncio.wait_for(login.future, 1) == login.redirect_uri + '?code=issued'
        seen = []

        def exchange(request: httpx.Request) -> httpx.Response:
            seen.append(json.loads(request.content))
            assert str(request.url) == BROWSER['openrouter'].token_url
            return httpx.Response(200, json={'key': 'issued-key'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(exchange)) as client:
            credential = await login.exchange(client, login.redirect_uri + '?code=issued')
        assert credential.access.get_secret_value() == 'issued-key'
        assert seen == [{'code': 'issued', 'code_verifier': login.verifier, 'code_challenge_method': 'S256'}]
    finally:
        await login.close_callback()


def test_pi_callback_and_client_ids_remain_exact() -> None:
    assert BROWSER['openai-codex'].client_id == 'app_EMoamEEZ73f0CkXaXp7hrann'
    assert BROWSER['openai-codex'].redirect_uri == 'http://localhost:1455/auth/callback'
    assert BROWSER['openai'].client_id == 'dynamic_agent_client'
    assert BROWSER['openai'].redirect_uri == 'http://127.0.0.1:1455/auth/callback'
    assert DEVICE['xai'].client_id == 'b1a00492-073a-47ea-816f-4c329264a828'
    login = Login(OAuthStart(login_id='a' * 32, provider='anthropic', expected_revision=0),
                  OAuthView(login_id='a' * 32, provider='anthropic', phase='pending'))
    # Pi accepts a manually pasted bare code; actual browser callbacks must carry the matching state.
    assert login.parse_input('bare')['code'] == 'bare'
    with pytest.raises(BackendError, match='oauth_state_mismatch'):
        login.parse_input('code=code&state=other')
    with pytest.raises(BackendError, match='oauth_state_mismatch'):
        login.parse_input('code=code', callback=True)


async def test_host_oauth_same_id_and_cancel_do_not_repeat_the_flow(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from amazme_backend.profiles.profile import Profile
    from amazme_backend.contracts import HostFence, ProcessLease
    from amazme_backend.host.service import Host
    store(tmp_path)
    private_write(tmp_path / 'control.token', 'control')
    private_write(tmp_path / 'web.token', 'web')
    host = Host(Profile(tmp_path))
    host.lifecycle.fence = HostFence(host_epoch=1, build_id=host.lifecycle.build)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize('host', host.lifecycle.build, ProcessLease(
        instance_id='host', role='host', profile_path=str(tmp_path), path=str(tmp_path / 'lease'), device=1, inode=1))
    calls = []
    started = asyncio.Event()

    async def begin(login: Login) -> None:
        calls.append(login.request.login_id)
        login.future = asyncio.get_running_loop().create_future()
        started.set()
    monkeypatch.setattr(Login, 'begin_browser', begin)
    request = OAuthStart(login_id='a' * 32, provider='openrouter', expected_revision=0)
    try:
        first, second = await asyncio.gather(host.accounts.start_oauth(request), host.accounts.start_oauth(request))
        await started.wait()
        assert first == second and calls == [request.login_id]
        with pytest.raises(BackendError, match='oauth_login_conflict'):
            await host.accounts.start_oauth(request.model_copy(update={'provider': 'anthropic'}))
        assert (await host.accounts.cancel_oauth(request.login_id)).phase == 'cancelled'
        assert (await host.accounts.start_oauth(request)).phase == 'cancelled'
        assert host.accounts.accounts.read().logins[request.login_id].view.phase == 'cancelled'
        assert calls == [request.login_id]
        # A recorded pending login from a lost Host is explicitly unknown, not restarted.
        prior = request.model_copy(update={'login_id': 'b' * 32})
        await host.accounts.accounts.reserve_login(prior, OAuthView(login_id=prior.login_id, provider='openrouter', phase='pending'), host.accounts.write_guard)
        assert (await host.accounts.start_oauth(prior)).phase == 'unknown'
        assert host.accounts.oauth_view(prior.login_id).phase == 'unknown'
        assert calls == [request.login_id]
        assert (await host.accounts.cancel_oauth(prior.login_id)).phase == 'cancelled'
    finally:
        for login in host.accounts.oauth_logins.values():
            await login.cancel()
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


async def test_host_accounts_rpc_and_sdk_share_one_private_credential_store(tmp_path: Path) -> None:
    from amazme_backend.profiles.profile import Profile
    from amazme_backend.contracts import CredentialUpdate, HostFence, ProcessLease, UpdateModelSettings
    from amazme_backend.host.service import Host
    from amazme_backend.interfaces.http.application import application
    from amazme_backend.interfaces.rpc import RpcCall, RpcParams, handle_rpc
    from amazme_backend.sdk import Client
    store(tmp_path)
    private_write(tmp_path / 'control.token', 'control')
    private_write(tmp_path / 'web.token', 'web')
    host = Host(Profile(tmp_path))
    host.origin = 'http://127.0.0.1:12345'
    host.lifecycle.fence = HostFence(host_epoch=1, build_id=host.lifecycle.build)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize('host', host.lifecycle.build, ProcessLease(
        instance_id='host', role='host', profile_path=str(tmp_path), path=str(tmp_path / 'lease'), device=1, inode=1))
    client = Client(host.origin, 'web')
    await client._http.aclose()
    client._http = httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin)
    try:
        await client.bootstrap()
        listed = await client.accounts()
        assert listed.revision == 0
        saved = await client.update_account('openrouter', CredentialUpdate(expected_revision=0, api_key=SecretStr('router-secret')))
        assert saved.revision == 1 and 'router-secret' not in saved.model_dump_json()
        model = await client.update_model(UpdateModelSettings(provider='openrouter', model='custom/chat',
            api='openai-completions', base_url='https://openrouter.ai/api/v1'))
        assert model.key_configured and model.provider == 'openrouter'
        assert host.lifecycle.profile.config.provider.api_key.get_secret_value() == ''
        result = await handle_rpc(host, RpcCall(id='list', method='account.list'))
        assert 'router-secret' not in json.dumps(result)
        assert result['result']['revision'] == 1
        result = await handle_rpc(host, RpcCall(id='clear', method='account.update', params=RpcParams(
            provider='openrouter', credential=CredentialUpdate(expected_revision=1, clear=True))))
        assert 'error' not in result
        assert (await client.models()).current.key_configured is False
        assert 'router-secret' not in host.accounts.accounts.secrets()
        assert 'legacy-secret' in host.accounts.accounts.secrets()
        with pytest.raises(BackendError, match='credential_conflict'):
            await client.update_account('openrouter', CredentialUpdate(expected_revision=1, api_key=SecretStr('stale')))
    finally:
        await client._http.aclose()
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


async def test_xai_device_polling_and_refresh_keep_original_client_and_rotation(monkeypatch: pytest.MonkeyPatch) -> None:
    from amazme_backend.accounts.oauth.flow import refresh
    delays = []

    async def sleep(delay: float) -> None:
        delays.append(delay)
    monkeypatch.setattr('amazme_backend.accounts.oauth.flow.asyncio.sleep', sleep)
    seen = []
    polls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal polls
        fields = parse_qs(request.content.decode())
        seen.append((str(request.url), fields))
        assert fields['client_id'] == [DEVICE['xai'].client_id]
        if str(request.url) == DEVICE['xai'].device_url:
            assert fields['referrer'] == ['pi']
            return httpx.Response(200, json={'device_code': 'device', 'user_code': 'AB-CD',
                'verification_uri': 'https://auth.x.ai/activate', 'interval': 2, 'expires_in': 900})
        if fields['grant_type'] == ['refresh_token']:
            assert fields['refresh_token'] == ['refresh-original']
            return httpx.Response(200, json={'access_token': 'renewed', 'expires_in': 7200})
        polls += 1
        if polls == 1:
            return httpx.Response(400, json={'error': 'slow_down', 'interval': 10})
        return httpx.Response(200, json={'access_token': 'access', 'refresh_token': 'refresh-original', 'expires_in': 7200})
    request = OAuthStart(login_id='c' * 32, provider='xai', expected_revision=0, method='device_code')
    login = Login(request, OAuthView(login_id=request.login_id, provider='xai', phase='pending'))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await login.begin_device(client)
        credential = await login.poll_device(client)
        renewed = await refresh(client, 'xai', credential)
    assert login.view.user_code == 'AB-CD' and delays == [2, 10]
    assert credential.access.get_secret_value() == 'access'
    assert renewed.refresh.get_secret_value() == 'refresh-original'
    assert renewed.access.get_secret_value() == 'renewed'
    assert len(seen) == 4


async def test_chatgpt_token_exchange_requires_issued_client_id_and_direct_scope() -> None:
    request = OAuthStart(login_id='d' * 32, provider='openai', expected_revision=0)
    login = Login(request, OAuthView(login_id=request.login_id, provider='openai', phase='pending'))
    login.redirect_uri = BROWSER['openai'].redirect_uri
    callback = login.redirect_uri + '?code=code&state=' + login.state + '&client_id=issued-client'
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        fields = parse_qs(request.content.decode())
        seen.append(fields)
        assert fields['client_id'] == ['issued-client']
        assert fields['resource'] == ['https://api.openai.com/v1']
        assert fields['redirect_uri'] == ['http://127.0.0.1:1455/auth/callback']
        return httpx.Response(200, json={'access_token': 'access', 'refresh_token': 'refresh',
            'expires_in': 7200, 'id_token': 'present', 'scope': 'openid chatgpt.tokens.use.direct'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        credential = await login.exchange(client, callback)
    assert credential.client_id == 'issued-client'
    assert len(seen) == 1
    with pytest.raises(BackendError, match='oauth_callback_mismatch'):
        login.parse_input('http://localhost:1455/auth/callback?code=code&state=' + login.state + '&client_id=issued')
