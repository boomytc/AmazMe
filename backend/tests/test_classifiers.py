"""System One classification requests and authentication are tested without paid model calls."""

import base64
import io
from unittest.mock import AsyncMock

import httpx
from PIL import Image
from pydantic import SecretStr

from amazme_backend.ai.classification.catalog import INDEX
from amazme_backend.ai.classification.client import classify
from amazme_backend.ai.classification.system_one import wire_request
from amazme_backend.ai.classification.types import (
    BoolQuestion,
    BoxQuestion,
    ClassifierContext,
)
from amazme_backend.ai.types import Auth
from amazme_backend.contracts import ImagePart


def image(width=800,height=600):
    stream = io.BytesIO()
    with Image.new('RGB',(width,height),'white') as picture:
        picture.save(stream,format='PNG')
    return stream.getvalue()


def test_wire_keeps_named_assets_structured_questions_and_pi_image_opt_in():
    context = ClassifierContext(state={'observation':{'picture':'shot'}},assets={'shot':ImagePart(media_type='image/png',data_base64=base64.b64encode(image()).decode())},
        questions={'present':BoolQuestion(instructions={'question':'Visible?'}),'target':BoxQuestion(instructions='The target in observation.picture')})
    body,headers = wire_request(INDEX[('typesafe','jev-latest')],context)
    assert body['questions']['present']['type'] == 'noul'
    assert body['state'] == context.state and body['assets']['shot']['format'] == 'png'
    assert headers['TypeSafe-Danger-Zone-Images'] == 'true'
    assert body['questions']['target']['type'] == 'box'


async def test_classifier_auth_stays_in_request_and_errors_never_echo_key(monkeypatch):
    secret = 'private-classifier-key'
    resolve_auth = AsyncMock(return_value=Auth(api_key=SecretStr(secret)))
    requests = []
    def respond(request):
        requests.append(request)
        assert request.headers['Authorization'] == 'Bearer '+secret
        if len(requests) == 1:
            return httpx.Response(200,json={'answers':{'yes':{'type':'noul','noul':.99}},'usage':{'input_tokens':12}})
        return httpx.Response(400,json={'message':secret})
    factory = httpx.AsyncClient
    monkeypatch.setattr('amazme_backend.ai.classification.client.httpx.AsyncClient',lambda **kwargs:factory(**kwargs,transport=httpx.MockTransport(respond)))
    context = ClassifierContext(state={'text':'test'},questions={'yes':BoolQuestion(instructions='Is it visible?')})
    good = await classify('typesafe','jev-latest',context,auth=resolve_auth)
    assert good.stop_reason == 'stop' and good.answers['yes'].probability == .99
    assert good.usage['input_tokens'] == 12
    bad = await classify('typesafe','jev-latest',context,auth=resolve_auth)
    assert bad.stop_reason == 'error' and secret not in bad.model_dump_json()
    assert len(requests) == 2
    assert resolve_auth.await_count == 2
