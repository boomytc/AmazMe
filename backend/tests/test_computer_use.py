"""Desktop actions follow the fixed driver: permissions, pixels, freshness, and cleanup."""

import asyncio
import json
import time
from pathlib import Path
from typing import Literal

import httpx
import pytest
from helpers.computer_probe import start_driver as start_probe

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import (
    BackendError,
    ComputerActionRequest,
    ComputerPolicy,
    CreateSession,
    HostFence,
    ProcessLease,
)
from amazme_backend.host import Host, application
from amazme_backend.storage import session_database

SESSION = "a" * 32
OTHER = "b" * 32
SCENARIOS: dict[Path, str] = {}


@pytest.fixture(autouse=True)
def fixed_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    SCENARIOS.clear()
    # These tests exercise driver transport, permissions and ownership. Semantic gates have their own tests.
    async def permit(*args):
        return {"status":"allowed","calls":[]}
    monkeypatch.setattr(Host,"_computer_risk",permit)
    monkeypatch.setattr("amazme_backend.host.start_driver", lambda directory:
                        start_probe(directory, SCENARIOS[directory.parents[1]]))


def _host(tmp_path: Path, scenario: Literal["unconfigured", "denied", "granted", "plain", "hold", "drop"]) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "desk", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux"}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:12345"
    SCENARIOS[tmp_path] = scenario
    return host


def _actions(host: Host, session: str) -> list[dict[str, object]]:
    path = session_database(host.profile.path, session).parent / "computer-actions.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]


async def _stop(host: Host) -> None:
    for driver in list(host.computer_drivers.values()):
        await asyncio.to_thread(driver.stop)
    host.computer_drivers.clear()
    await host.supervisor.close()
    await host.store.db.close()


def _client(host: Host) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
        "Authorization": "Bearer web-only", "x-amazme-build": host.build,
        "x-amazme-epoch": str(host.fence.host_epoch),
    })


async def _open(host: Host, client: httpx.AsyncClient, session: str) -> None:
    await host.store.create_session(session, CreateSession(title="桌面"))
    attached = await client.post(f"/api/v1/sessions/{session}/attachments")
    assert attached.status_code == 201
    client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]


async def test_missing_permission_sends_no_click_and_pixels_follow_the_driver(tmp_path: Path) -> None:
    host = _host(tmp_path, "denied")
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        async with _client(host) as client:
            await _open(host, client, SESSION)
            blocked = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "early", "capture_id": "missing", "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 1, "y": 4}}})
            assert blocked.status_code == 409 and blocked.json()["code"] == "computer_disabled"
            assert _actions(host, SESSION) == []
            enabled = await client.post(f"/api/v1/sessions/{SESSION}/computer", json={"enabled": True, "allow_foreground": True})
            assert enabled.status_code == 200 and enabled.json()["enabled"] is True
            denied = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe", json={})
            assert denied.status_code == 200 and denied.json()["error"] == "permission_required"
            assert denied.json()["permitted"] is False and denied.json()["capture"] is None
            assert denied.json()["identity"] == "fixed-computer-driver"
            stale = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "nope", "capture_id": "missing", "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 1, "y": 4}},
                "accessibility": True})
            assert stale.status_code == 422 and _actions(host, SESSION) == []
            SCENARIOS[tmp_path] = "granted"
            seen = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe", json={})
            assert seen.status_code == 200 and seen.json()["permitted"] is True
            capture = seen.json()["capture"]["capture_id"]
            assert seen.json()["capture"]["width"] == 10 and seen.json()["capture"]["height"] == 20
            acted = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "click", "capture_id": capture, "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 1, "y": 4}}})
            assert acted.status_code == 200 and acted.json()["phase"] == "done"
            assert acted.json()["driver_x"] == 8 and acted.json()["driver_y"] == 16
            assert _actions(host, SESSION) == [{"op": "act", "capture_id": capture, "x": 8, "y": 16}]
            again = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "click", "capture_id": capture, "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 1, "y": 4}}})
            changed = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "click", "capture_id": capture, "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 2, "y": 4}}})
            assert again.json()["driver_x"] == 8 and changed.status_code == 409
            assert changed.json()["code"] == "computer_action_conflict"
            fresh = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe", json={})
            old = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "old", "capture_id": capture, "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 1, "y": 4}}})
            assert old.status_code == 409 and old.json()["code"] == "computer_stale"
            assert _actions(host, SESSION) == [{"op": "act", "capture_id": capture, "x": 8, "y": 16}]
            assert fresh.json()["capture"]["capture_id"] != capture
    finally:
        await _stop(host)


async def test_dropped_action_stays_unknown_until_cleanup_proof(tmp_path: Path) -> None:
    host = _host(tmp_path, "drop")
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        async with _client(host) as client:
            await _open(host, client, SESSION)
            await client.post(f"/api/v1/sessions/{SESSION}/computer", json={"enabled": True, "allow_foreground": True})
            seen = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe", json={})
            capture = seen.json()["capture"]["capture_id"]
            dropped = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "drop", "capture_id": capture, "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 1, "y": 4}}})
            assert dropped.status_code == 200 and dropped.json()["phase"] == "unknown"
            assert dropped.json()["driver_x"] is None and _actions(host, SESSION) == []
            retry = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "drop", "capture_id": capture, "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 1, "y": 4}}})
            assert retry.json()["phase"] == "unknown" and _actions(host, SESSION) == []
            blocked = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "next", "capture_id": capture, "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 1, "y": 4}}})
            assert blocked.status_code == 409 and blocked.json()["code"] == "computer_blocked"
            observe = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe", json={})
            assert observe.status_code == 409 and observe.json()["code"] == "computer_blocked"
            cleaned = await client.post(f"/api/v1/sessions/{SESSION}/computer/cleanup")
            assert cleaned.status_code == 200 and cleaned.json()["cleared"] is True and cleaned.json()["proof"]
            repeat = await client.post(f"/api/v1/sessions/{SESSION}/computer/cleanup")
            assert repeat.json()["proof"] == cleaned.json()["proof"]
            resumed = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe", json={})
            assert resumed.status_code == 200 and resumed.json()["permitted"] is True
            assert resumed.json()["capture"]["capture_id"] != capture
    finally:
        await _stop(host)


async def test_a_second_action_does_not_start_while_the_first_is_unanswered(tmp_path: Path) -> None:
    host = _host(tmp_path, "hold")
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    try:
        async with _client(host) as client:
            await _open(host, client, SESSION)
            await client.post(f"/api/v1/sessions/{SESSION}/computer", json={"enabled": True, "allow_foreground": True, "max_age_ms": 55000})
            seen = await client.post(f"/api/v1/sessions/{SESSION}/computer/observe", json={})
            capture = seen.json()["capture"]["capture_id"]
            first = asyncio.create_task(client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "first", "capture_id": capture, "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 1, "y": 4}}}))
            for _ in range(50):
                if SESSION in host.computer_held:
                    break
                await asyncio.sleep(0.01)
            assert SESSION in host.computer_held
            second = await client.post(f"/api/v1/sessions/{SESSION}/computer/actions", json={
                "action_id": "second", "capture_id": capture, "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 1, "y": 4}}})
            assert second.status_code == 409 and second.json()["code"] == "computer_busy"
            done = await first
            assert done.status_code == 200 and done.json()["driver_x"] == 8
            assert len(_actions(host, SESSION)) == 1
            await host.store.create_session(OTHER, CreateSession(title="过期"))
            SCENARIOS[tmp_path] = "plain"
            attached = await client.post(f"/api/v1/sessions/{OTHER}/attachments")
            client.headers["x-amazme-attachment"] = attached.json()["attachment_id"]
            await client.post(f"/api/v1/sessions/{OTHER}/computer", json={"enabled": True, "allow_foreground": True, "max_age_ms": 1})
            aged = await client.post(f"/api/v1/sessions/{OTHER}/computer/observe", json={})
            old_capture = aged.json()["capture"]["capture_id"]
            await asyncio.sleep(0.05)
            expired = await client.post(f"/api/v1/sessions/{OTHER}/computer/actions", json={
                "action_id": "late", "capture_id": old_capture, "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 3, "y": 4}}})
            assert expired.status_code == 409 and expired.json()["code"] == "computer_stale"
            assert _actions(host, OTHER) == []
            await client.post(f"/api/v1/sessions/{OTHER}/computer", json={"enabled": True, "allow_foreground": True, "max_age_ms": 55000})
            fresh = await client.post(f"/api/v1/sessions/{OTHER}/computer/observe", json={})
            clicked = await client.post(f"/api/v1/sessions/{OTHER}/computer/actions", json={
                "action_id": "plain", "capture_id": fresh.json()["capture"]["capture_id"], "delivery_mode": "foreground", "action": {"action": "click", "point": {"x": 3, "y": 4}}})
            assert clicked.json()["driver_x"] == 6 and clicked.json()["driver_y"] == 8
            assert _actions(host, OTHER) == [{
                "op": "act", "capture_id": fresh.json()["capture"]["capture_id"], "x": 6, "y": 8}]
    finally:
        await _stop(host)


async def test_cancelled_start_waits_and_reclaims_the_returned_driver(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    host = _host(tmp_path, 'granted')
    drivers = []

    def delayed(directory):
        time.sleep(0.05)
        driver = start_probe(directory, 'granted')
        drivers.append(driver)
        return driver

    monkeypatch.setattr('amazme_backend.host.start_driver', delayed)
    pending = asyncio.create_task(host._computer_start(tmp_path / 'desk'))
    await asyncio.sleep(0.01)
    pending.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert len(drivers) == 1 and drivers[0].process.poll() is not None
    finally:
        await _stop(host)


async def test_sdk_and_rpc_use_the_same_bound_computer_action_ledger(tmp_path: Path) -> None:
    from amazme_backend.rpc import RpcCall, RpcParams, handle_rpc
    from amazme_backend.sdk import Client
    host = _host(tmp_path, 'granted')
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, ProcessLease(
        instance_id='host', role='host', profile_path=str(tmp_path), path=str(tmp_path / 'lease'), device=1, inode=1))
    client = Client(host.origin, 'web-only')
    await client._http.aclose()
    client._http = httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin)
    try:
        await client.bootstrap()
        await host.store.create_session(SESSION, CreateSession(title='desktop'))
        binding = await host.attach_session(SESSION)
        await client.configure_computer(SESSION, binding.attachment_id, ComputerPolicy(enabled=True))
        view = await client.observe_computer(SESSION, binding.attachment_id)
        assert view.capture is not None
        action = ComputerActionRequest(action_id='shared', capture_id=view.capture.capture_id, delivery_mode='foreground', action={'action':'click','point':{'x':1,'y':4}})
        with pytest.raises(BackendError, match='computer_foreground_disabled'):
            await client.act_computer(SESSION, binding.attachment_id, action)
        assert _actions(host, SESSION) == []
        await client.configure_computer(SESSION, binding.attachment_id, ComputerPolicy(enabled=True, allow_foreground=True))
        assert (await client.act_computer(SESSION, binding.attachment_id, action)).phase == 'done'
        rpc = await handle_rpc(host, RpcCall(id='retry', method='computer.act', params=RpcParams(
            session_id=SESSION, workspace='primary', attachment_id=binding.attachment_id, computer_action=action)))
        assert rpc['result']['phase'] == 'done' and len(_actions(host, SESSION)) == 1
        await client.configure_computer(SESSION, binding.attachment_id, ComputerPolicy(enabled=False))
        assert SESSION not in host.computer_drivers
        assert (await client.act_computer(SESSION, binding.attachment_id, action)).phase == 'done'
        assert len(_actions(host, SESSION)) == 1
    finally:
        await client._http.aclose()
        await _stop(host)
