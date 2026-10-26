"""Stored transcript pages remain stable while new turns arrive; images use authenticated byte routes."""

import base64
from pathlib import Path

import httpx
from test_management import _client, _host

from amazme_backend.contracts import CreateSession, HostFence, ImagePart, ProcessLease, Submit
from amazme_backend.interfaces.http.application import application
from amazme_backend.profiles.layout import session_database
from amazme_backend.sessions.service import SessionStore

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fU0AAAAASUVORK5CYII=")


async def test_history_pages_keep_original_order_and_do_not_start_a_worker(tmp_path: Path) -> None:
    host = _host(tmp_path)
    session = "a" * 32
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, ProcessLease(
        instance_id="host", role="host", profile_path=str(tmp_path), path=str(tmp_path / "lease"), device=1, inode=1))
    await host.sessions.create_session(CreateSession(session_id=session))
    path = session_database(tmp_path, session)
    path.parent.mkdir(parents=True)
    store = SessionStore(path, session, build=host.lifecycle.build)
    await store.initialize()
    try:
        await store.import_transcript([(f"turn-{index:02}", role, f"{role}-{index:02}")
                                       for index in range(45) for role in ("user", "assistant")])
        async with _client(host) as client:
            first = (await client.get(f"/api/v1/sessions/{session}/history")).json()
            assert [row["request_id"] for row in first["requests"]] == [f"turn-{index:02}" for index in range(25, 45)]
            assert first["cursor"] == "turn-25" and first["more"] is True
            assert first["requests"][-1]["answer"] == "assistant-44"
            await store.accept(Submit(request_id="new", text="after first page"), HostFence(host_epoch=0, build_id=host.lifecycle.build))
            second = (await client.get(f"/api/v1/sessions/{session}/history", params={"before": first["cursor"]})).json()
            assert [row["request_id"] for row in second["requests"]] == [f"turn-{index:02}" for index in range(5, 25)]
            third = (await client.get(f"/api/v1/sessions/{session}/history", params={"before": second["cursor"]})).json()
            assert [row["request_id"] for row in third["requests"]] == [f"turn-{index:02}" for index in range(5)]
            assert third["more"] is False
            assert len({row["request_id"] for page in (first, second, third) for row in page["requests"]}) == 45
            invalid = await client.get(f"/api/v1/sessions/{session}/history", params={"before": "not-present"})
            assert invalid.status_code == 404 and invalid.json()["code"] == "history_cursor_missing"
            assert await host.lifecycle.store.service() is None
    finally:
        await store.close()
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


async def test_prompt_image_bytes_stay_separate_from_events_and_require_authentication(tmp_path: Path) -> None:
    host = _host(tmp_path)
    session = "b" * 32
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, ProcessLease(
        instance_id="host", role="host", profile_path=str(tmp_path), path=str(tmp_path / "lease"), device=1, inode=1))
    await host.sessions.create_session(CreateSession(session_id=session))
    path = session_database(tmp_path, session)
    path.parent.mkdir(parents=True)
    store = SessionStore(path, session, build=host.lifecycle.build)
    await store.initialize()
    encoded = base64.b64encode(PNG).decode()
    try:
        await store.accept(Submit(request_id="picture", text="", images=[ImagePart(media_type="image/png", data_base64=encoded)]),
                           HostFence(host_epoch=0, build_id=host.lifecycle.build))
        route = f"/api/v1/sessions/{session}/requests/picture/images/0"
        async with _client(host) as client:
            image = await client.get(route)
            assert image.status_code == 200 and image.content == PNG
            assert image.headers["content-type"] == "image/png" and image.headers["cache-control"] == "no-store"
            assert (await client.get(route.replace("/0", "/-1"))).status_code == 404
            page = await client.get(f"/api/v1/sessions/{session}/history")
            assert page.json()["requests"][0]["image_count"] == 1 and encoded not in page.text
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin) as client:
            assert (await client.get(route)).status_code == 401
        assert await host.lifecycle.store.service() is None
    finally:
        await store.close()
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()
