"""The product CUA path uses native capture identity and lets CUA map Retina coordinates."""

import base64
import json
from pathlib import Path

import pytest

from amazme_backend.computer_run import APP, PIN, ComputerDriver
from amazme_backend.contracts import BackendError

PNG = base64.b64encode(bytes.fromhex(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
    '0000000b49444154789c636000020000050001a5f645400000000049454e44ae426082')).decode()


def test_capture_bound_native_click_does_not_rescale_retina_twice(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    driver = ComputerDriver(tmp_path / APP, tmp_path / 'driver', tmp_path)
    driver.tools = {name: {'properties': {field: {} for field in fields}} for name, fields in {
        'get_desktop_state': ['session'], 'click': ['session', 'target', 'delivery_mode', 'capture_id']}.items()}
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
    driver.request({'op': 'act', 'capture_id': 'host-frame', 'x': 0, 'y': 0})
    arguments = sent[-1][1]['arguments']
    assert arguments == {'target': {'kind': 'desktop', 'display_id': 'primary'}, 'delivery_mode': 'foreground',
                         'capture_id': 'native-frame', 'x': 0, 'y': 0, 'session': driver.session}
    with pytest.raises(BackendError, match='computer_stale'):
        driver.request({'op': 'act', 'capture_id': 'old-frame', 'x': 0, 'y': 0})
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
    source = (Path(__file__).parents[2] / 'packages/coding-agent/plugins/computer-use/src/runtime-pin.ts').read_text()
    assert all(value in source for value in PIN.values())
