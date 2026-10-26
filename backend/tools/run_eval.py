"""Run one eval on the real native Python Host; stdout is one credential-free result."""

from __future__ import annotations

import asyncio
import json
import shutil
import signal
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import Field, JsonValue, SecretStr, TypeAdapter
from verify_runtime import Runtime

from amazme_backend.accounts.store import AccountStore
from amazme_backend.platform.private_files import private_write
from amazme_backend.contracts import BackendError, CredentialUpdate, Message, Model, PluginDraft, PluginToolCall, ProfileConfig, ProviderConfig, UpdateModelSettings, plugin_alias
from amazme_backend.ai.catalog import INDEX
from amazme_backend.accounts.oauth.flow import OAuthCredential
from amazme_backend.sdk import Client

ROOT = Path(__file__).resolve().parents[2]
JSON = TypeAdapter(JsonValue)
RECORD = TypeAdapter(dict[str, JsonValue])


class ProviderProbe(Model):
    path: str = 'provider.json'
    provider: str
    model: str
    api: Literal['openai-completions','anthropic-messages']
    base_url: str
    api_key: SecretStr
    prompt: str


class EvalInput(Model):
    provider: str
    model: str
    prompts: list[str] = Field(min_length=1,max_length=16)
    credential_profile: str = ''
    tools: list[str] | None = None
    system_prompt: str | None = None
    append_system_prompt: str = ''
    workspace_files: dict[str,str] = Field(default_factory=dict)
    documentation: Literal['with_docs','without_docs'] | None = None
    plugin_entry: str = ''
    provider_probe: ProviderProbe | None = None
    timeout_ms: int = Field(default=300000,ge=100,le=300000)


def inside(workspace: Path, name: str) -> Path:
    path = (workspace / name).resolve()
    if not path.is_relative_to(workspace.resolve()) or path == workspace.resolve():
        raise BackendError('eval_workspace_path')
    return path


def actor_config(value: EvalInput) -> ProviderConfig:
    if value.provider == 'faux':
        return ProviderConfig(provider='faux',model='faux',base_url='')
    if not value.credential_profile:
        raise BackendError('eval_credential_profile_required')
    source = ProfileConfig.model_validate_json((Path(value.credential_profile).resolve() / 'config.json').read_bytes()).provider
    if source.provider == value.provider:
        return source.model_copy(update={'model':value.model,'api_key':SecretStr(''),'headers':{},'proxy':''})
    metadata = INDEX.get((value.provider,value.model))
    if metadata is None:
        raise BackendError('model_not_available')
    return ProviderConfig(provider=value.provider,model=value.model,api=metadata.api,base_url=metadata.base_url)


async def borrow_credential(value: EvalInput, profile: Path) -> None:
    if value.provider == 'faux':
        return
    source = AccountStore(Path(value.credential_profile).resolve())
    transport = source.read().transports.get(value.provider)
    credential = await source.resolve(value.provider,proxy=transport.proxy if transport else '')
    if credential is None:
        raise BackendError('provider_not_configured')
    if isinstance(credential,OAuthCredential):
        # The source vault alone owns refresh-token rotation. This temporary run borrows access only.
        credential = credential.model_copy(update={'refresh':SecretStr('')})
    target = AccountStore(profile)
    async with target.locked():
        document = target.read()
        document.credentials[value.provider] = credential
        if transport is not None:
            document.transports[value.provider] = transport
        else:
            document.transports.pop(value.provider,None)
        document.revision += 1
        target.write(document)


def transcript(messages: list[Message]) -> list[dict[str, JsonValue]]:
    events: list[dict[str, JsonValue]] = []
    calls: dict[str,str] = {}
    for message in messages:
        if message.role in {'user','assistant'}:
            if message.content:
                events.append({'type':'message','role':message.role,'content':message.content})
            for call in message.tool_calls:
                args = RECORD.validate_json(call.arguments)
                name = call.name
                if name == 'plugin_tool':
                    plugin = PluginToolCall.model_validate(args)
                    name,args = plugin_alias(plugin.plugin_id,plugin.name),plugin.arguments
                calls[call.id] = name
                events.append({'type':'tool_call','id':call.id,'name':name,'arguments':args})
        elif message.role == 'tool':
            try:
                content = JSON.validate_json(message.content)
            except ValueError:
                content = message.content
            event: dict[str,JsonValue] = {'type':'tool_result','toolCallId':message.tool_call_id,
                'name':calls.get(message.tool_call_id,''),'content':content}
            if isinstance(content,dict) and content.get('is_error') is True:
                event['error'] = {'message':'tool_error'}
            events.append(event)
    return events


async def probe_provider(client: Client, workspace: Path, value: ProviderProbe) -> dict[str, JsonValue]:
    # Only the declared fixture endpoint may receive this probe's key. Actor credentials never enter the fixture.
    config = ProviderConfig.model_validate_json(inside(workspace,value.path).read_bytes())
    if (config.provider,config.model,config.api,config.base_url.rstrip('/')) != (value.provider,value.model,value.api,value.base_url.rstrip('/')):
        raise BackendError('eval_provider_identity')
    catalog = await client.models()
    previous = {(item.provider,item.model) for item in catalog.models}
    accounts = await client.accounts()
    await client.update_account(value.provider,CredentialUpdate(expected_revision=accounts.revision,api_key=value.api_key))
    settings = await client.update_model(UpdateModelSettings(provider=config.provider,model=config.model,
        base_url=config.base_url,api=config.api,max_tokens=config.max_tokens))
    session = await client.create_session(title='Provider probe',workspace='primary')
    attachment = await client.attach(session.session_id)
    request = await client.submit(session_id=session.session_id,workspace='primary',attachment_id=attachment.attachment_id,
        request_id='provider-probe',text=value.prompt,allowed_tools=[])
    request = await client.wait(session_id=session.session_id,request_id=request.request_id,attempts=6000)
    if request.status != 'succeeded':
        raise BackendError(request.error or 'eval_provider_probe_failed')
    current = await client.models()
    return {'settings':settings.model_dump(mode='json'),'response':request.answer,
        'existing_models_preserved':previous.issubset({(item.provider,item.model) for item in current.models})}


async def run(value: EvalInput, runtime: Runtime) -> dict[str, JsonValue]:
    await borrow_credential(value,runtime.profile)
    await asyncio.to_thread(runtime.start)
    for name,content in value.workspace_files.items():
        path = inside(runtime.workspace,name)
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(content)
    append = value.append_system_prompt
    if value.documentation == 'with_docs':
        directory = runtime.workspace / 'docs'
        directory.mkdir(exist_ok=True)
        for name in ['python-backend-plan.md']:
            shutil.copy2(ROOT / 'docs' / name,directory / name)
        append += '\nAmazMe Python backend documentation (read only): docs/python-backend-plan.md. Read it when configuring models or Python plugins.\n'
    if value.documentation is not None:
        actual = (runtime.workspace / 'docs' / 'python-backend-plan.md').is_file()
        if actual != (value.documentation == 'with_docs'):
            raise BackendError('eval_documentation_variant')
    token = (runtime.profile / 'web.token').read_text()
    async with Client(runtime.ready['url'],token) as client:
        session = await client.create_session(title='Native eval',workspace='primary')
        attachment = await client.attach(session.session_id)
        plugin_view = None
        response = ''
        errors: list[str] = []
        try:
            for index,prompt in enumerate(value.prompts):
                # Each new turn checks the source vault again, including logout and refresh ownership.
                await borrow_credential(value,runtime.profile)
                request_id = 'eval-'+str(index)
                await client.submit(session_id=session.session_id,workspace='primary',attachment_id=attachment.attachment_id,
                    request_id=request_id,text=prompt,system_prompt=value.system_prompt,append_system_prompt=append,allowed_tools=value.tools)
                receipt = await client.wait(session_id=session.session_id,request_id=request_id,attempts=6000)
                if receipt.status != 'succeeded':
                    errors.append(receipt.error or 'eval_'+receipt.status)
                    break
                response = receipt.answer
                if value.plugin_entry and plugin_view is None:
                    entry = inside(runtime.workspace,value.plugin_entry)
                    if entry.is_file():
                        plugin_view = await client.register_plugin(PluginDraft(plugin_id='e'*32,session_id=session.session_id,
                            name='eval-extension',entry=str(entry)))
                        if plugin_view.phase != 'ready':
                            raise BackendError(plugin_view.error or 'eval_plugin_load_failed')
        except (Exception,asyncio.CancelledError) as error:
            errors.append(error.code if isinstance(error,BackendError) else 'eval_cancelled' if isinstance(error,asyncio.CancelledError) else 'eval_failed')
        # This verifier owns the profile. Read the full committed history, not the bounded UI snapshot.
        from amazme_backend.profiles.layout import session_database
        with sqlite3.connect(session_database(runtime.profile,session.session_id).as_uri() + '?mode=ro',uri=True) as db:
            rows = db.execute('SELECT m.payload FROM messages m JOIN requests r ON r.id=m.request_id ORDER BY r.ordinal,m.ordinal').fetchall()
        events = transcript([Message.model_validate_json(row[0]) for row in rows])
        evidence: dict[str, JsonValue] = {'build_id':runtime.ready['build_id'],'documentation':value.documentation,
            'plugin':plugin_view.model_dump(mode='json') if plugin_view else None}
        if value.plugin_entry and plugin_view is None:
            errors.append('eval_plugin_missing')
        if value.provider_probe is not None and not errors:
            try:
                evidence['provider_probe'] = await probe_provider(client,runtime.workspace,value.provider_probe)
            except (BackendError,ValueError,OSError) as error:
                errors.append(error.code if isinstance(error,BackendError) else 'eval_provider_configuration')
        report = await client.session_usage(session.session_id)
        return {'response':response,'session':{'events':events},'evidence':evidence,'errors':errors,
            'usage':{'provider':value.provider,'model':value.model,'inputTokens':report.input_tokens,'outputTokens':report.output_tokens,
                'totalTokens':report.input_tokens+report.output_tokens+report.cache_read_tokens+report.cache_write_tokens,
                'toolCalls':sum(event['type'] == 'tool_call' for event in events),
                'metadata':{'cacheReadTokens':report.cache_read_tokens,'cacheWriteTokens':report.cache_write_tokens,
                    'estimatedCostUsd':report.cost_micro_usd / 1000000 if report.cost_micro_usd is not None else None}}}


def main() -> None:
    raw = sys.stdin.buffer.readline(1024*1024+1)
    if len(raw) > 1024*1024:
        raise BackendError('eval_input_limit')
    value = EvalInput.model_validate_json(raw)
    root = Path(tempfile.mkdtemp(prefix='amazme-eval-'))
    identity = root.stat()
    runtime: Runtime | None = None
    result: dict[str, JsonValue]
    try:
        config = actor_config(value)
        provider = root / 'provider.json'
        private_write(provider,json.dumps({**config.model_dump(mode='json'),'api_key':''}))
        runtime = Runtime([sys.executable,'-m','amazme_backend'],root,provider)
        async def bounded() -> dict[str, JsonValue]:
            async with asyncio.timeout(value.timeout_ms / 1000) as deadline:
                partial = await run(value,runtime)
            if deadline.expired():
                errors = partial['errors']
                assert isinstance(errors,list)
                errors.append('eval_timeout')
            return partial
        result = asyncio.run(bounded())
    except (Exception,KeyboardInterrupt) as error:
        code = error.code if isinstance(error,BackendError) else 'eval_cancelled' if isinstance(error,KeyboardInterrupt) else 'eval_failed'
        result = {'response':'','session':{'events':[]},'usage':{},'evidence':{},'errors':[code]}
    finally:
        # Finish the owned cleanup even if the caller repeats cancellation while leases are closing.
        signal.signal(signal.SIGINT,signal.SIG_IGN)
        signal.signal(signal.SIGTERM,signal.SIG_IGN)
        if runtime is not None:
            runtime.close()
        current = root.stat()
        if root.is_symlink() or (current.st_dev,current.st_ino) != (identity.st_dev,identity.st_ino):
            raise BackendError('eval_owner_changed')
        shutil.rmtree(root)
    print(json.dumps(result,ensure_ascii=False))


if __name__ == '__main__':
    def interrupt(signum,frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,interrupt)
    main()
