"""Eval tools reuse the credential vault without acquiring refresh-token ownership."""
import importlib.util
import sys
import time
from pathlib import Path

import pytest
from pydantic import SecretStr

from amazme_backend.accounts.store import AccountDocument, AccountStore, ProviderTransport
from amazme_backend.contracts import BackendError, Message, PluginToolCall, ToolCall
from amazme_backend.accounts.oauth.flow import OAuthCredential

TOOLS = Path(__file__).parents[1] / 'tools'
spec = importlib.util.spec_from_file_location('native_eval_runner',TOOLS / 'run_eval.py')
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
# run_eval and verify_runtime are siblings when invoked as scripts; scope this import path change.
sys.path.insert(0,str(TOOLS))
try:
    spec.loader.exec_module(module)
finally:
    sys.path.remove(str(TOOLS))


async def test_eval_borrows_access_and_current_transport_without_refresh_ownership(tmp_path: Path) -> None:
    source_path = tmp_path / 'source'
    source_path.mkdir()
    target = tmp_path / 'target'
    target.mkdir()
    AccountStore(target).write(AccountDocument())
    source = AccountStore(source_path)
    original = AccountDocument(credentials={'openai-codex':OAuthCredential(
        access=SecretStr('test-access'),refresh=SecretStr('source-refresh'),expires=int(time.time()*1000)+3600000)},
        transports={'openai-codex':ProviderTransport(headers={'x-fixture':'private-header'})})
    source.write(original)
    value = module.EvalInput(provider='openai-codex',model='test',prompts=['hello'],credential_profile=str(source_path))
    await module.borrow_credential(value,target)
    saved = AccountStore(target).read()
    assert saved.credentials['openai-codex'].refresh.get_secret_value() == ''
    assert saved.credentials['openai-codex'].access.get_secret_value() == 'test-access'
    assert saved.transports == original.transports
    assert source.read() == original
    source.write(AccountDocument())
    with pytest.raises(BackendError,match='provider_not_configured'):
        await module.borrow_credential(value,target)


def test_eval_transcript_preserves_canonical_plugin_call_identity_and_structured_error() -> None:
    call = PluginToolCall(plugin_id='e'*32,call_id='a'*32,workspace='primary',fingerprint='b'*64,
        load_id='register',name='hello',schema_digest='c'*64,arguments={'name':'中文😀'})
    events = module.transcript([Message(role='assistant',content='',tool_calls=[ToolCall(id='call-one',name='plugin_tool',arguments=call.model_dump_json())]),
        Message(role='tool',tool_call_id='call-one',content='{"is_error":true,"content":[]}')])
    assert events[0]['arguments'] == {'name':'中文😀'}
    call_alias = module.plugin_alias('e'*32,'hello')
    assert events[0]['name'] == call_alias
    assert events[1]['name'] == call_alias and events[1]['toolCallId'] == 'call-one'
    assert events[1]['error'] == {'message':'tool_error'}
