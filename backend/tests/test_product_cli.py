"""Product commands use the Python SDK, private account vault and new-format export."""

import io
import json
from pathlib import Path

import httpx
import pytest

import amazme_backend.interfaces.cli as client_cmd
from amazme_backend.contracts import ProcessLease
from amazme_backend.interfaces.http.application import application
from amazme_backend.sdk import Client


async def test_product_cli_accounts_models_and_export_share_the_host(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    from test_management import _host
    host = _host(tmp_path)
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, ProcessLease(
        instance_id='host', role='host', profile_path=str(tmp_path), path=str(tmp_path / 'lease'), device=1, inode=1))

    def client(url, token):
        instance = Client(url, token)
        # Avoid opening a real listener; keep the SDK's real auth and request path.
        instance._http = httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=url)
        return instance

    monkeypatch.setattr(client_cmd, 'Client', client)
    base = ['--url',host.origin,'--token','web-only']
    try:
        monkeypatch.setattr('sys.stdin', io.StringIO('cli-private-key\n'))
        assert await client_cmd._run([*base,'auth','login','--provider','openrouter','--method','api-key']) == 0
        assert 'cli-private-key' not in capsys.readouterr().out
        assert host.accounts.accounts.read().credentials['openrouter'].key.get_secret_value() == 'cli-private-key'
        assert await client_cmd._run([*base,'models','--search','openrouter']) == 0
        catalog = json.loads(capsys.readouterr().out)
        assert catalog['models'] and all(item['provider'] == 'openrouter' for item in catalog['models'])
        assert await client_cmd._run([*base,'model','--provider','openrouter','--model','custom',
                                      '--base-url','https://openrouter.ai/api/v1']) == 0
        assert json.loads(capsys.readouterr().out)['provider'] == 'openrouter'
        output = tmp_path / 'export.json'
        assert await client_cmd._run([*base,'export','--output',str(output)]) == 0
        assert output.stat().st_mode & 0o777 == 0o600
        exported = output.read_bytes()
        assert b'cli-private-key' not in exported
        assert await client_cmd._run([*base,'export','--output',str(output)]) == 1
        assert output.read_bytes() == exported
        capsys.readouterr()
        assert await client_cmd._run([*base,'import',str(output)]) == 0
        assert json.loads(capsys.readouterr().out)['format'] == 'amazme-export/1'
        assert await client_cmd._run([*base,'auth','logout','--provider','openrouter']) == 0
        capsys.readouterr()
        assert 'openrouter' not in host.accounts.accounts.read().credentials
    finally:
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


async def test_oauth_cli_keeps_original_identity_after_unknown_response(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    from amazme_backend.contracts.accounts import AccountsView
    from amazme_backend.contracts import BackendError
    seen = []

    class AccountClient:
        async def accounts(self):
            return AccountsView(revision=3, accounts=[])

        async def start_oauth(self, request):
            seen.append(request)
            raise BackendError('oauth_response_lost')

        async def oauth(self, login_id):
            raise BackendError('oauth_login_missing', status=404)

    args = client_cmd._parser().parse_args(['--url','http://local','--token','web','auth','login',
        '--provider','openrouter','--login-id','a' * 32,'--no-wait'])
    with pytest.raises(BackendError, match='oauth_response_lost'):
        await client_cmd._auth(AccountClient(), args)
    assert json.loads(capsys.readouterr().out)['login_id'] == 'a' * 32
    assert len(seen) == 1 and seen[0].expected_revision == 3
