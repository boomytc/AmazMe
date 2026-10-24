"""System One and the native plugin's decisions are tested without paid model calls."""

import base64
import io
from unittest.mock import AsyncMock, Mock

import httpx
from PIL import Image
from pydantic import SecretStr

from amazme_backend.accounts import AccountDocument, AccountStore, ApiKeyCredential
from amazme_backend.classifiers import (
    INDEX,
    BoolAnswer,
    BoolQuestion,
    Box,
    BoxAnswer,
    BoxQuestion,
    ChoiceAnswer,
    ClassifierContext,
    ClassifierResult,
    classify,
    wire_request,
)
from amazme_backend.computer_candidates import blocked_risks, extract_candidates
from amazme_backend.computer_grounding import closed_choice, locate, risks_accepted
from amazme_backend.contracts import ComputerCaptureView, ComputerPolicy, ComputerRect, ImagePart


def image(width=800,height=600):
    stream = io.BytesIO()
    with Image.new('RGB',(width,height),'white') as picture:
        picture.save(stream,format='PNG')
    return stream.getvalue()


def box_result():
    return ClassifierResult(provider='typesafe',model='jev',answers={
        'present':BoolAnswer(probability=.99),'target':BoxAnswer(box=Box(left=.25,top=.25,right=.75,bottom=.75),confidence=.95)})


def test_wire_keeps_named_assets_structured_questions_and_pi_image_opt_in():
    context = ClassifierContext(state={'observation':{'picture':'shot'}},assets={'shot':ImagePart(media_type='image/png',data_base64=base64.b64encode(image()).decode())},
        questions={'present':BoolQuestion(instructions={'question':'Visible?'}),'target':BoxQuestion(instructions='The target in observation.picture')})
    body,headers = wire_request(INDEX[('typesafe','jev-1.14.0')],context)
    assert body['questions']['present']['type'] == 'noul'
    assert body['state'] == context.state and body['assets']['shot']['format'] == 'png'
    assert headers['TypeSafe-Danger-Zone-Images'] == 'true'
    assert body['questions']['target']['type'] == 'box'


async def test_classifier_auth_stays_in_request_and_errors_never_echo_key(monkeypatch):
    secret = 'private-classifier-key'
    accounts = Mock(spec=AccountStore)
    accounts.read.return_value = AccountDocument()
    accounts.resolve = AsyncMock(return_value=ApiKeyCredential(key=SecretStr(secret)))
    requests = []
    def respond(request):
        requests.append(request)
        assert request.headers['Authorization'] == 'Bearer '+secret
        if len(requests) == 1:
            return httpx.Response(200,json={'answers':{'yes':{'type':'noul','noul':.99}},'usage':{'input_tokens':12}})
        return httpx.Response(400,json={'message':secret})
    factory = httpx.AsyncClient
    monkeypatch.setattr('amazme_backend.classifiers.httpx.AsyncClient',lambda **kwargs:factory(**kwargs,transport=httpx.MockTransport(respond)))
    context = ClassifierContext(state={'text':'test'},questions={'yes':BoolQuestion(instructions='Is it visible?')})
    good = await classify(accounts,'typesafe','jev-1.14.0',context)
    assert good.stop_reason == 'stop' and good.answers['yes'].probability == .99
    assert good.usage['input_tokens'] == 12
    bad = await classify(accounts,'typesafe','jev-1.14.0',context)
    assert bad.stop_reason == 'error' and secret not in bad.model_dump_json()
    assert len(requests) == 2


def test_candidates_omit_risks_chrome_ambiguity_and_keep_identity_across_snapshots():
    frame = {'x':0,'y':0,'width':100,'height':50}
    elements = [
        {'element_index':0,'role':'AXWindow','label':'App'},
        {'element_index':1,'parent_index':0,'role':'AXButton','label':'  Continue  ','frame':frame,'element_token':'snap:1'},
        {'element_index':2,'parent_index':0,'role':'AXButton','label':'Delete','frame':frame,'element_token':'snap:2'},
        {'element_index':3,'parent_index':0,'role':'AXButton','label':'Close','frame':frame,'element_token':'snap:3'},
        {'element_index':4,'parent_index':0,'role':'AXButton','label':'Same','frame':frame,'element_token':'snap:4'},
        {'element_index':5,'parent_index':0,'role':'AXButton','label':'Same','frame':frame,'element_token':'snap:5'},
    ]
    capture = ComputerCaptureView(capture_id='c',width=100,height=50,raw_width=100,raw_height=50,orientation=1,scale=1,observed_ms=1,
        elements=elements,window_bounds=ComputerRect(x=0,y=0,width=100,height=50))
    policy = ComputerPolicy()
    candidates = extract_candidates(capture,policy)
    assert [item.label for item in candidates] == ['Continue']
    capture.elements[1]['element_token'] = 'new-snap:8'
    newer = extract_candidates(capture,policy)
    assert newer[0].id == candidates[0].id and newer[0].element_token != candidates[0].element_token
    assert blocked_risks('sendable reorder',policy) == []
    assert set(blocked_risks('删除 and send',policy)) == {'destructive','send'}


async def test_coarse_fine_localization_preserves_pixels_and_confidence_gates():
    calls = []
    async def decide(context):
        calls.append(context)
        return box_result()
    result = await locate(image(),'Continue','look_closer',decide,ComputerPolicy())
    assert result.status == 'located' and result.box == (280,210,520,390)
    assert (result.x,result.y) == (400,300) and len(calls) == 2
    assert result.crop.media_type == 'image/png'
    with Image.open(io.BytesIO(base64.b64decode(result.crop.data_base64))) as crop:
        assert crop.size == (240,180)
    async def uncertain(context):
        return ClassifierResult(provider='typesafe',model='jev',stop_reason='error')
    rejected = await locate(image(),'Continue','look_closer',uncertain,ComputerPolicy())
    assert rejected.status == 'review' and rejected.crop is None and len(rejected.calls) == 2


async def test_tiled_localization_requires_a_closed_distribution():
    calls = []
    async def decide(context):
        calls.append(context)
        if 'tile' in context.questions:
            criteria = context.questions['tile'].criteria
            return ClassifierResult(provider='typesafe',model='jev',answers={'tile':ChoiceAnswer(choice='tile_0_0',
                confidence=.95,probabilities={key:1 if key == 'tile_0_0' else 0 for key in criteria})})
        return box_result()
    result = await locate(image(),'Continue','tiled',decide,ComputerPolicy())
    assert result.status == 'located' and len(calls) == 2 and len(calls[0].assets) == 4
    malformed = ClassifierResult(provider='typesafe',model='jev',answers={'pick':ChoiceAnswer(choice='a',confidence=.99,probabilities={'a':.1,'b':.9})})
    assert closed_choice(malformed,'pick',{'a':'A','b':'B'},ComputerPolicy()) is None
    assert not risks_accepted(box_result(),ComputerPolicy())
