"""Native grounding uses the real Host/SQLite boundaries and a protocol driver, without desktop actions."""

import asyncio
import base64

import pytest
from test_classifiers import image
from test_computer_use import SESSION, _client, _host, _open, _stop

from amazme_backend.ai.classification.types import BoolAnswer, ChoiceAnswer, ClassifierResult
from amazme_backend.contracts import BackendError, ComputerGroundRequest, ComputerInspect, ComputerPolicy, ComputerWindow, HostFence, ProcessLease


class Driver:
    def __init__(self):
        self.hello = {'accessibility':True,'screen':True,'identity':'protocol-test','raw_width':800,'raw_height':600,'orientation':1,'scale':1}
        self.alive = True
        self.actions = []
    def stop(self):
        self.alive = False
        return 0
    def request(self,payload):
        if payload['op'] == 'observe':
            return {'capture_id':payload['capture_id'],'snapshot_id':'snapshot','image_base64':base64.b64encode(image()).decode(),
                'tree':'Success' if self.actions else 'Continue','window_bounds':{'x':0,'y':0,'width':800,'height':600},'elements':[
                    {'element_index':0,'role':'AXWindow','label':'Test'},
                    {'element_index':1,'parent_index':0,'role':'AXButton','label':'Continue','element_token':'snapshot:1',
                     'frame':{'x':10,'y':10,'width':100,'height':50}}]}
        self.actions.append(payload)
        return {'op':'acted'}


@pytest.fixture
async def native(tmp_path,monkeypatch):
    owner = _host(tmp_path,'granted')
    driver = Driver()
    async def start(directory):
        return driver
    monkeypatch.setattr(owner.computer,'_computer_start',start)
    lease = ProcessLease(instance_id='host',role='host',profile_path=str(tmp_path),path=str(tmp_path / 'lease'),device=1,inode=1)
    owner.lifecycle.fence = HostFence(host_epoch=await owner.lifecycle.store.initialize(owner.lifecycle.instance,owner.lifecycle.build,lease),build_id=owner.lifecycle.build)
    owner.lifecycle.initialized = True
    async with _client(owner) as client:
        await _open(owner,client,SESSION)
        await owner.computer.save_computer_policy(SESSION,ComputerPolicy(enabled=True))
        try:
            yield owner,driver,client
        finally:
            await _stop(owner)


async def test_grounding_selects_assesses_then_verifies_without_repeating(native,monkeypatch):
    owner,driver,client = native
    calls = []
    async def classify(context):
        calls.append(context)
        answers = {key:BoolAnswer(probability=.01) for key in context.questions if key.startswith('risk_')}
        if 'candidate' in context.questions:
            assert not driver.actions
            criteria = context.questions['candidate'].criteria
            selected = next(key for key in criteria if key.startswith('ax_'))
            answers.update(goal_satisfied=BoolAnswer(probability=.01),candidate=ChoiceAnswer(choice=selected,confidence=.99,
                probabilities={key:1 if key == selected else 0 for key in criteria}))
        elif 'verified' in context.questions:
            assert len(driver.actions) == 1 and context.state['observation']['tree'] == 'Success'
            answers['verified'] = BoolAnswer(probability=.99)
        else:
            assert not driver.actions and context.assets
        return ClassifierResult(provider='typesafe',model='jev',answers=answers)
    monkeypatch.setattr(owner.computer,'_computer_classifier',lambda policy:classify)
    request = ComputerGroundRequest(action_id='stable',target=ComputerWindow(pid=123,window_id=4),goal='Continue',verification='Success is visible')
    response = await client.post(f'/api/v1/sessions/{SESSION}/computer/ground',json=request.model_dump())
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['phase'] == 'done' and result['result']['status'] == 'verified', result
    assert len(driver.actions) == 1 and len(calls) == 3
    assert driver.actions[0]['target'] == {'pid':123,'window_id':4} and driver.actions[0]['delivery_mode'] == 'background'
    assert (await client.post(f'/api/v1/sessions/{SESSION}/computer/ground',json=request.model_dump())).json() == result
    assert len(driver.actions) == 1 and len(calls) == 3
    conflict = await client.post(f'/api/v1/sessions/{SESSION}/computer/ground',json={**request.model_dump(),'goal':'Other'})
    assert conflict.status_code == 409 and len(calls) == 3


async def test_cancel_during_classification_retires_driver_and_keeps_unknown_id(native,monkeypatch):
    owner,driver,client = native
    started = asyncio.Event()
    async def classify(context):
        started.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(owner.computer,'_computer_classifier',lambda policy:classify)
    request = ComputerGroundRequest(action_id='cancelled',target=ComputerWindow(pid=123,window_id=4),goal='Continue',verification='Success')
    task = asyncio.create_task(owner.computer.computer_ground(SESSION,request))
    await asyncio.wait_for(started.wait(),5)
    with pytest.raises(BackendError,match='computer_busy'):
        await owner.computer.computer_observe(SESSION,ComputerInspect())
    task.cancel()
    await asyncio.gather(task,return_exceptions=True)
    assert not driver.alive and not driver.actions and not owner.computer.computer_held
    again = await owner.computer.computer_ground(SESSION,request)
    assert again.phase == 'unknown' and not driver.actions


async def test_repeated_waiter_cancellation_keeps_ownership_until_driver_exit(native,monkeypatch):
    import threading

    from amazme_backend.contracts import ComputerActionRequest, ComputerClick, ComputerElement

    owner,driver,_client = native
    observed = await owner.computer.computer_observe(SESSION,ComputerInspect(action='window',target=ComputerWindow(pid=123,window_id=4)))
    started,allow_result,stopping,allow_exit = (threading.Event() for _ in range(4))
    request = driver.request
    def held(payload):
        if payload['op'] == 'act':
            started.set()
            assert allow_result.wait(3)
        return request(payload)
    def stop():
        stopping.set()
        assert allow_exit.wait(3)
        driver.alive = False
        return 0
    monkeypatch.setattr(driver,'request',held)
    monkeypatch.setattr(driver,'stop',stop)
    async def permit(*args):
        return {'status':'allowed','calls':[]}
    monkeypatch.setattr(owner.computer,'_computer_risk',permit)
    value = ComputerActionRequest(action_id='held',capture_id=observed.capture.capture_id,target=observed.capture.target,
        action=ComputerClick(action='click',point=ComputerElement(element_token='snapshot:1')))
    task = asyncio.create_task(owner.computer.computer_action(SESSION,value))
    try:
        assert await asyncio.to_thread(started.wait,2)
        task.cancel()
        allow_result.set()
        assert await asyncio.to_thread(stopping.wait,2)
        task.cancel()
        await asyncio.sleep(.01)
        assert not task.done() and SESSION in owner.computer.computer_held and driver.alive
        allow_exit.set()
        await asyncio.gather(task,return_exceptions=True)
        assert not driver.alive and not owner.computer.computer_held
        assert (await owner.computer.computer_action(SESSION,value)).phase == 'unknown'
        assert len(driver.actions) == 1
    finally:
        allow_result.set()
        allow_exit.set()
        await asyncio.gather(task,return_exceptions=True)


async def test_timeout_returns_the_original_unknown_receipt_without_another_model_call(native,monkeypatch):
    owner,driver,_client = native
    calls = []
    async def classify(context):
        calls.append(context)
        await asyncio.Event().wait()
    monkeypatch.setattr(owner.computer,'_computer_classifier',lambda policy:classify)
    await owner.computer.save_computer_policy(SESSION,ComputerPolicy(enabled=True,timeout_ms=100))
    value = ComputerGroundRequest(action_id='timed',target=ComputerWindow(pid=123,window_id=4),goal='Continue',verification='Success')
    result = await owner.computer.computer_ground(SESSION,value)
    assert result.phase == 'unknown' and result.error == 'computer_timeout'
    assert not driver.alive and not driver.actions and not owner.computer.computer_held
    assert await owner.computer.computer_ground(SESSION,value) == result
    assert len(calls) == 1
