"""Verifier cleanup follows its newly-created profile, never a replacement or source credential."""

import importlib.util
import io
import json
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

from amazme_backend.accounts import AccountStore

SOURCE = Path(__file__).parents[1] / 'tools/verify_runtime.py'
spec = importlib.util.spec_from_file_location('native_verify_runtime', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_owned_verifier_clears_the_authoritative_vault_and_transport_secrets(tmp_path: Path) -> None:
    source = tmp_path / 'source.json'
    original = {'provider':'openai', 'model':'test', 'api_key':'copied-key',
                'proxy':'http://user:secret@localhost:8080', 'headers':{'x-token':'copied-header'}}
    source.write_text(json.dumps(original))
    runtime = module.Runtime([sys.executable, '-m', 'amazme_backend'], tmp_path, source)
    assert AccountStore(runtime.profile).read().credentials
    runtime.close()
    assert AccountStore(runtime.profile).read().credentials == {}
    assert AccountStore(runtime.profile).read().transports == {}
    assert AccountStore(runtime.profile).read().logins == {}
    saved = (runtime.profile / 'config.json').read_text()
    assert all(secret not in saved for secret in ['copied-key', 'copied-header', 'user:secret'])
    assert json.loads(source.read_text()) == original
    assert runtime.resource_report['owned_reclaimed'] is True


def test_replaced_profile_is_preserved_and_census_still_runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runtime = module.Runtime.__new__(module.Runtime)
    runtime.profile = tmp_path / 'profile'
    runtime.profile.mkdir()
    identity = runtime.profile.stat()
    runtime._profile_identity = (identity.st_dev, identity.st_ino)
    runtime.profile.rename(tmp_path / 'original')
    runtime.profile.mkdir()
    marker = runtime.profile / 'accounts.json'
    marker.write_text('unknown credentials')
    runtime.log = io.StringIO()
    runtime.stop = Mock()
    runtime.root = tmp_path
    census = Mock()
    census.scan.return_value = ({}, [])
    census.owned_after.return_value = {'owned_reclaimed':True}
    monkeypatch.setattr(module, '_census', lambda:census)
    with pytest.raises(RuntimeError, match='identity changed'):
        runtime.close()
    assert marker.read_text() == 'unknown credentials'
    census.scan.assert_called_once()
    census.record.assert_called_once()
