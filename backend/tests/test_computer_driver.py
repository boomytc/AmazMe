"""The product CUA path uses native capture identity and lets CUA map Retina coordinates."""

import base64
import json
from pathlib import Path

import pytest

from amazme_backend.execution.computer.driver import APP, PIN, ComputerDriver
from amazme_backend.contracts import BackendError

PNG = base64.b64encode(bytes.fromhex(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
    '0000000b49444154789c636000020000050001a5f645400000000049454e44ae426082')).decode()


def test_capture_bound_native_click_does_not_rescale_retina_twice(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    driver = ComputerDriver(tmp_path / APP, tmp_path / 'driver', tmp_path)
    driver.tools = {name: {'properties': {field: {} for field in fields}} for name, fields in {
        'get_desktop_state': ['session'], 'click': ['session', 'target', 'delivery_mode', 'capture_id', 'x', 'y']}.items()}
    sent = []

    def rpc(method, params):
        sent.append((method, params))
        if params.get('name') == 'get_desktop_state':
            return {'structuredContent': {'capture_id': 'native-frame', 'screenshot_width': 1, 'screenshot_height': 1},
                    'content': [{'type': 'image', 'data': PNG, 'mimeType': 'image/png'}]}
        return {'content': [{'type': 'text', 'text': json.dumps({'success': True})}]}

    monkeypatch.setattr(driver, 'rpc', rpc)
    view = driver.request({'op': 'observe', 'capture_id': 'host-frame'})
    assert view['image_base64'] == PNG and view['capture_id'] == 'host-frame'
    assert (driver.hello['scale'], driver.hello['orientation']) == (1, 1)
    driver.request({'op':'act', 'capture_id':'host-frame', 'target':None, 'delivery_mode':'foreground', 'action':{'action':'click', 'point':{'x':0,'y':0}}})
    arguments = sent[-1][1]['arguments']
    assert arguments == {'target': {'kind': 'desktop', 'display_id': 'primary'}, 'delivery_mode': 'foreground',
                         'capture_id': 'native-frame', 'x': 0, 'y': 0, 'session': driver.session}
    assert driver.request({'op': 'act', 'capture_id': 'old-frame'}) == {'op':'rejected','error':'computer_stale'}
    assert len(sent) == 2


def test_native_capture_rejects_dimension_mismatch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    driver = ComputerDriver(tmp_path / APP, tmp_path / 'driver', tmp_path)
    monkeypatch.setattr(driver, 'call', lambda *args: {
        'data': {'capture_id': 'frame', 'screenshot_width': 2, 'screenshot_height': 1},
        'content': [{'type': 'image', 'data': PNG, 'mimeType': 'image/png'}]})
    with pytest.raises(BackendError, match='computer_capture_invalid'):
        driver.request({'op': 'observe', 'capture_id': 'host-frame'})
    assert not driver.driver_capture


def test_runtime_pin_matches_existing_recipe() -> None:
    source = (Path(__file__).parents[2] / 'tools/native/computer-use/src/runtime-pin.ts').read_text()
    assert all(value in source for value in PIN.values())


@pytest.mark.parametrize(('action', 'tool', 'expected'), [
    ({'action':'double_click','point':{'x':4,'y':5}}, 'click', {'x':4,'y':5,'count':2,'capture_id':'native'}),
    ({'action':'right_click','point':{'element_token':'snapshot:1'}}, 'click', {'element_token':'snapshot:1','button':'right'}),
    ({'action':'type_text','element_token':'snapshot:2','text':'你好🙂'}, 'type_text', {'element_token':'snapshot:2','text':'你好🙂'}),
    ({'action':'set_value','element_token':'snapshot:2','text':'新值'}, 'set_value', {'element_token':'snapshot:2','value':'新值'}),
    ({'action':'press_key','key':'Return'}, 'press_key', {'key':'Return'}),
    ({'action':'hotkey','keys':['Meta','A']}, 'hotkey', {'keys':['Meta','A']}),
    ({'action':'scroll','x':4,'y':5,'direction':'down','amount':3}, 'scroll', {'x':4,'y':5,'direction':'down','amount':3}),
    ({'action':'drag','x':4,'y':5,'to_x':6,'to_y':7}, 'drag', {'from_x':4,'from_y':5,'to_x':6,'to_y':7}),
])
def test_window_actions_preserve_the_original_driver_arguments(tmp_path: Path, action, tool, expected) -> None:
    from amazme_backend.contracts import ComputerMutation, ComputerWindow
    driver = ComputerDriver(tmp_path / APP, tmp_path / 'driver', tmp_path)
    driver.target = ComputerWindow(pid=10, window_id=20)
    driver.snapshot_id, driver.driver_capture = 'snapshot', 'native'
    driver.elements = [{'element_token':'snapshot:1', 'role':'AXButton'},
                       {'element_token':'snapshot:2', 'role':'AXTextField'}]
    driver.tools[tool] = {'properties':{name:{} for name in ['target','delivery_mode','session',*expected]}}
    value = ComputerMutation.model_validate({'capture_id':'host', 'target':{'pid':10,'window_id':20}, 'action':action})
    name, args = driver.plan(value)
    assert name == tool and args == {**expected, 'target':{'kind':'window','pid':10,'window_id':20}, 'delivery_mode':'background'}


def test_wrong_window_or_stale_element_never_reaches_native_call(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    driver = ComputerDriver(tmp_path / APP, tmp_path / 'driver', tmp_path)
    driver.capture_id, driver.driver_capture, driver.snapshot_id = 'host', 'native', 'snapshot'
    from amazme_backend.contracts import ComputerWindow
    driver.target = ComputerWindow(pid=10, window_id=20)
    driver.tools['type_text'] = {'properties':{'target':{},'delivery_mode':{},'element_token':{},'text':{}}}
    sent = []
    monkeypatch.setattr(driver, 'call', lambda *args: sent.append(args))
    payload = {'op':'act','capture_id':'host','target':{'pid':10,'window_id':20},'delivery_mode':'background',
               'action':{'action':'type_text','text':'hello','element_token':'old:1'}}
    assert driver.request(payload) == {'op':'rejected','error':'computer_element_stale'}
    assert sent == [] and driver.driver_capture == 'native'
    payload['target'] = {'pid':10,'window_id':21}
    assert driver.request(payload) == {'op':'rejected','error':'computer_target_mismatch'}
    assert sent == []


def test_window_observation_preserves_exact_target_and_native_tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    driver = ComputerDriver(tmp_path / APP, tmp_path / 'driver', tmp_path)
    driver.tools['get_window_state'] = {'properties':{'tree_format':{}}}
    sent = []

    def call(name, args):
        sent.append((name,args))
        return {'data':{'capture_id':'native', 'snapshot_id':'snapshot','pid':10,'window_id':20,
                        'screenshot_width':1,'screenshot_height':1,'tree_markdown':'Text field',
                        'elements':[{'role':'AXTextField','element_token':'snapshot:1'}]},
                'content':[{'type':'image','mimeType':'image/png','data':PNG}]}

    monkeypatch.setattr(driver, 'call', call)
    result = driver.request({'op':'observe','capture_id':'host','target':{'pid':10,'window_id':20}})
    assert sent[0] == ('get_window_state',{'pid':10,'window_id':20,'include_accessibility_tree':True,
        'include_screenshot':True,'max_elements':500,'max_image_dimension':1400,'tree_format':'both'})
    assert result['snapshot_id'] == 'snapshot' and result['tree'] == 'Text field'
