"""Use neutral chat and classification APIs without product actors or account storage."""

import argparse
import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import patch


async def verify() -> dict[str, object]:
    import httpx
    from pydantic import SecretStr

    from amazme_backend.ai.classification.client import classify
    from amazme_backend.ai.classification.types import BoolQuestion, ClassifierContext
    from amazme_backend.ai.client import stream
    from amazme_backend.ai.types import Auth, Completion, ModelMessage, ModelRequest, ModelSpec, ToolDefinition

    sent: list[dict[str, object]] = []

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers['Authorization'] == 'Bearer boundary-fixture'
        body = json.loads(request.content)
        sent.append({'path': request.url.path, 'body': body})
        if request.url.path.endswith('/systemone'):
            assert body['questions']['visible']['type'] == 'noul'
            return httpx.Response(200, json={'answers': {'visible': {'type': 'noul', 'noul': .99}}})
        assert request.url.path == '/responses'
        assert body['instructions'] == 'Explicit caller prompt'
        assert body['tools'][0]['name'] == 'send_weather'
        events = [
            {'type': 'response.output_text.delta', 'delta': 'weather'},
            {'type': 'response.completed', 'response': {'id': 'neutral-response', 'output': [
                {'type': 'function_call', 'call_id': 'neutral-call', 'name': 'send_weather',
                 'arguments': '{"city":"Nanjing"}'}], 'usage': {'input_tokens': 7, 'output_tokens': 2}}},
        ]
        wire = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events)
        return httpx.Response(200, text=wire, headers={'content-type': 'text/event-stream'})

    client_type = httpx.AsyncClient

    def client(**options: object) -> httpx.AsyncClient:
        return client_type(**options, transport=httpx.MockTransport(respond))

    auth = Auth(api_key=SecretStr('boundary-fixture'))
    request = ModelRequest(messages=[ModelMessage(role='user', content='weather request')],
        system_prompt='Explicit caller prompt',
        tools=[ToolDefinition(name='weather_report', description='A caller-defined tool',
            parameters={'type': 'object', 'properties': {'city': {'type': 'string'}}})],
        wire_names={'weather_report': 'send_weather'})
    with patch('httpx.AsyncClient', client):
        values = [item async for item in stream(
            ModelSpec(provider='fixture', model='neutral', api='openai-responses', base_url='http://fixture'),
            request, auth)]
        completion = next(item for item in values if isinstance(item, Completion))
        assert completion.message.tool_calls[0].name == 'weather_report'
        assert completion.message.tool_calls[0].id == 'neutral-call'
        assert completion.input_tokens == 7 and ''.join(item for item in values if isinstance(item, str)) == 'weather'
        classified = await classify('typesafe', 'jev-latest',
            ClassifierContext(state={'text': 'test'}, questions={'visible': BoolQuestion(instructions='Visible?')}),
            auth=auth)
        assert classified.stop_reason == 'stop' and classified.answers['visible'].probability == .99
    forbidden = ('amazme_backend.host', 'amazme_backend.agent', 'amazme_backend.sessions',
                 'amazme_backend.execution', 'amazme_backend.accounts', 'amazme_backend.profiles')
    implementations = sorted(name for name in sys.modules if any(name == prefix or name.startswith(prefix + '.') for prefix in forbidden))
    assert not implementations, implementations
    return {'passed': True, 'evidence': 'in-process HTTP substitute; no real provider calls',
            'chat': 'caller prompt/custom tool/wire alias/stream/usage',
            'classification': 'explicit auth/noul probability', 'requests': sent,
            'server_implementations_loaded': implementations}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    result = asyncio.run(verify())
    text = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.report:
        args.report.write_text(text)
    print(text, end='')


if __name__ == '__main__':
    main()
