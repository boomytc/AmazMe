"""Declared image payloads cross both real HTTP boundaries; small operations stay bounded."""
import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from amazme_backend.contracts import HostFence, Receipt
from amazme_backend.host.service import Host
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.host.sessions import SessionOperations
from amazme_backend.interfaces.http.application import application as host_app
from amazme_backend.agent.driver import Worker
from amazme_backend.interfaces.worker import application as worker_app

SESSION = "a" * 32
IMAGE = {"media_type": "image/png", "data_base64": base64.b64encode(b"x" * 300000).decode()}
SUBMIT = {"request_id": "original-image-id", "text": "look", "images": [IMAGE]}


@pytest.mark.parametrize("boundary", ["host", "worker"])
async def test_declared_image_body_is_accepted_without_relaxing_auth_or_other_routes(boundary):
    received = Receipt(request_id=SUBMIT["request_id"], text="look", status="queued", image_count=1)
    if boundary == "host":
        owner = Mock(spec=Host)
        owner.lifecycle = Mock(spec=HostLifecycle)
        owner.lifecycle.profile = SimpleNamespace(token="control")
        owner.origin, owner.web_token, owner.lifecycle.build = "http://test", "web", "build"
        owner.lifecycle.fence = HostFence(host_epoch=1, build_id="build")
        owner.sessions = Mock(spec=SessionOperations)
        owner.sessions.deliver = AsyncMock(return_value=received)
        app, path, body = host_app(owner), f"/api/v1/sessions/{SESSION}/submissions", SUBMIT
        headers = {"Authorization": "Bearer web", "x-amazme-build": "build", "x-amazme-epoch": "1", "x-amazme-attachment": "binding"}
        method, small_path = owner.sessions.deliver, "/api/v1/models"
    else:
        owner = Mock(spec=Worker)
        owner.context = SimpleNamespace(token="control")
        owner.submit = AsyncMock(return_value=received)
        app, path, body = worker_app(owner), "/submissions", {"host_epoch": 1, "build_id": "build", "value": SUBMIT}
        headers = {"Authorization": "Bearer control"}
        method, small_path = owner.submit, "/fence"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        denied = await client.post(path, headers={**headers, "Authorization": "Bearer wrong"}, json=body)
        assert denied.status_code == 401 and method.await_count == 0
        accepted = await client.post(path, headers=headers, json=body)
        assert accepted.status_code in {200, 202} and accepted.json()["request_id"] == SUBMIT["request_id"]
        assert method.await_count == 1
        bounded = await client.post(small_path, headers=headers, json=body)
        assert bounded.status_code == 413 and method.await_count == 1
