"""Plugin tools use the model's pinned session catalog, never raw model-owned identities."""

import json

import pytest

from amazme_backend.contracts import (
    BackendError,
    PluginOffer,
    PluginTool,
    PluginToolCall,
    PluginView,
    ToolCall,
)
from amazme_backend.session_domain import resolve_model_call


def offer() -> PluginOffer:
    view = PluginView(plugin_id='a'*32, session_id='b'*32, name='user-plugin', capabilities=['hello'],
        config={}, entry='/user/extension.py', fingerprint='f'*64, load_id='register:'+'a'*32, phase='ready',
        tools=[PluginTool(name='hello',label='Greeting',description='Say hello',parameters={'type':'object',
            'properties':{'name':{'type':'string'}},'required':['name']}),
            PluginTool(name='hello',label='/hello',description='User command',parameters={'type':'object'},kind='command')])
    values = PluginOffer.from_view(view,'primary')
    assert len(values) == 1
    return values[0]


def test_only_the_bound_alias_supplies_execution_identity():
    chosen = offer()
    raw = ToolCall(id='provider-call',name=chosen.alias,arguments='{"name":"Bob"}')
    catalog = json.dumps([chosen.model_dump()])
    mapped = resolve_model_call('[]',raw,'c'*32,catalog)
    assert mapped.id == raw.id and mapped.name == 'plugin_tool'
    args = PluginToolCall.model_validate_json(mapped.arguments)
    assert args.plugin_id == chosen.plugin_id and args.fingerprint == chosen.fingerprint
    assert args.call_id == 'c'*32 and args.load_id == chosen.load_id and args.schema_digest == chosen.schema_digest
    assert args.arguments == {'name':'Bob'}
    for invalid in [raw.model_copy(update={'name':'plugin_tool'}),raw.model_copy(update={'name':'plugin_'+'0'*20})]:
        with pytest.raises(BackendError,match='plugin_tool_unknown'):
            resolve_model_call('[]',invalid,'c'*32,catalog)
    with pytest.raises(BackendError,match='plugin_tool_unknown'):
        resolve_model_call('[]',raw,'c'*32)


def test_plugin_only_selection_reaches_all_provider_wire_formats():
    from amazme_backend.contracts import ProviderConfig
    from amazme_backend.provider_wire import anthropic_body, google_body, responses_body
    from amazme_backend.providers import tool_definitions
    config = ProviderConfig(provider='faux',allowed_tools=['plugin_*'])
    chosen = offer()
    assert [tool['function']['name'] for tool in tool_definitions([],config,[chosen])] == [chosen.alias]
    assert [tool['name'] for tool in responses_body(config,[],[],[chosen])['tools']] == [chosen.alias]
    assert [tool['name'] for tool in anthropic_body(config,[],[],[chosen])[0]['tools']] == [chosen.alias]
    assert [tool['name'] for tool in google_body(config,[],[],[chosen])['tools'][0]['functionDeclarations']] == [chosen.alias]
    assert tool_definitions([],config.model_copy(update={'allowed_tools':[]}),[chosen]) == []


def test_google_projects_schema_consts_without_changing_literal_data_or_other_protocols():
    from copy import deepcopy

    from amazme_backend.contracts import ProviderConfig
    from amazme_backend.provider_wire import anthropic_body, google_body, responses_body

    literal = {'const': 'literal', 'properties': {'const': 7}, '__proto__': {'const': 'data'}}
    schema = {
        'type': 'object',
        'properties': {
            'kind': {'type': 'string', 'const': 'write'},
            'count': {'type': 'integer', 'const': 0},
            'enabled': {'type': 'boolean', 'const': False},
            'preset': {'const': literal},
            'existing': {'const': 'keep', 'enum': ['keep', 'other']},
            'const': {'type': 'string', 'const': 'property-name'},
            '__proto__': {'const': 'schema'},
            'list': {'type': 'array', 'items': {'anyOf': [{'const': 'a'}, {'const': 'b'}]}},
        },
        '$defs': {'const': {'const': 'definition'}},
        'allOf': [{'properties': {'version': {'const': 1}}}],
        'default': literal, 'examples': [literal], 'enum': [literal],
        'x-metadata': {'properties': {'const': 'untouched'}},
    }
    original = deepcopy(schema)
    chosen = offer().model_copy(update={'parameters': schema})
    config = ProviderConfig(provider='faux', allowed_tools=['plugin_*'])
    declaration = google_body(config, [], [], [chosen])['tools'][0]['functionDeclarations'][0]
    projected = declaration['parametersJsonSchema']
    assert projected['properties']['kind'] == {'type': 'string', 'enum': ['write']}
    assert projected['properties']['count'] == {'type': 'integer', 'enum': [0]}
    assert projected['properties']['const'] == {'type': 'string', 'enum': ['property-name']}
    assert projected['properties']['__proto__'] == {'enum': ['schema']}
    assert projected['properties']['list']['items']['anyOf'] == [{'enum': ['a']}, {'enum': ['b']}]
    assert projected['$defs'] == {'const': {'enum': ['definition']}}
    assert projected['allOf'][0]['properties']['version'] == {'enum': [1]}
    for key in ['enabled', 'preset', 'existing']:
        assert projected['properties'][key] == original['properties'][key]
    for key in ['default', 'examples', 'enum', 'x-metadata']:
        assert projected[key] == original[key]
    assert responses_body(config, [], [], [chosen])['tools'][0]['parameters'] == original
    assert anthropic_body(config, [], [], [chosen])[0]['tools'][0]['input_schema'] == original
    assert chosen.parameters == original
