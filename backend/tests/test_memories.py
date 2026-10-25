"""Memories stay inside one workspace and are injected only into that session's model call."""

import json
import shutil
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import CreateSession, HostFence, Message, ProcessLease, ProviderConfig
from amazme_backend.host import Host, application
from amazme_backend.memories import remember
from amazme_backend.providers import Completion
from amazme_backend.session_domain import ModelInvocation
from amazme_backend.worker import Worker

PRIMARY_SESSION = "a" * 32
DOCS_SESSION = "b" * 32
MEMORY = "c" * 32
KEY = "sk-test-not-real"


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "mem", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux"}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.fence = HostFence(host_epoch=1, build_id=host.build)
    host.origin = "http://127.0.0.1:12345"
    return host


async def test_model_call_injects_only_the_session_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    host = _host(tmp_path)
    other = tmp_path.parent / f"mem-{tmp_path.name}"
    other.mkdir()
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    captured: list[list[Message]] = []

    async def fake_stream(config: ProviderConfig, messages: list[Message], offers=None, plugins=None):
        del config, offers
        captured.append(messages)
        yield Completion(message=Message(role="assistant", content="ok"), response_id="faux")

    monkeypatch.setattr("amazme_backend.worker.stream", fake_stream)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
            "Authorization": "Bearer web-only", "x-amazme-build": host.build,
            "x-amazme-epoch": str(host.fence.host_epoch),
        }) as client:
            granted = await client.post("/api/v1/workspaces", json={"name": "docs", "host_path": str(other)})
            assert granted.status_code == 200
            saved = await client.post("/api/v1/memories", json={
                "memory_id": MEMORY, "workspace": "primary", "text": "use alpha"})
            assert saved.status_code == 200
            other_memory = await client.post("/api/v1/memories", json={
                "memory_id": "d" * 32, "workspace": "docs", "text": "use beta"})
            assert other_memory.status_code == 200
            conflict = await client.post("/api/v1/memories", json={
                "memory_id": MEMORY, "workspace": "primary", "text": "use gamma"})
            assert conflict.status_code == 409 and conflict.json()["code"] == "memory_conflict"
            kept = await client.get("/api/v1/memories", params={"workspace": "primary", "q": "alpha"})
            assert [item["text"] for item in kept.json()["memories"]] == ["use alpha"]
            leaked = await client.get("/api/v1/memories", params={"workspace": "docs", "q": "alpha"})
            assert leaked.json()["memories"] == []
            await host.store.create_session(PRIMARY_SESSION, CreateSession(title="主", workspace="primary"))
            await host.store.create_session(DOCS_SESSION, CreateSession(title="文档", workspace="docs"))
            primary_preview = await client.get(f"/api/v1/sessions/{PRIMARY_SESSION}/memories", params={"q": "please use alpha"})
            assert [item["text"] for item in primary_preview.json()["memories"]] == ["use alpha"]
            docs_preview = await client.get(f"/api/v1/sessions/{DOCS_SESSION}/memories", params={"q": "please use beta"})
            assert [item["text"] for item in docs_preview.json()["memories"]] == ["use beta"]
            assert primary_preview.json()["workspace"] == "primary"
        primary = Worker(host.profile, PRIMARY_SESSION, "worker-primary")
        await primary.perform(ModelInvocation(
            "step", "request", 1, [Message(role="user", content="please use alpha")],
            ProviderConfig(provider="faux")))
        docs = Worker(host.profile, DOCS_SESSION, "worker-docs")
        await docs.perform(ModelInvocation(
            "step", "request", 1, [Message(role="user", content="please use beta")],
            ProviderConfig(provider="faux")))
        assert "use alpha" in captured[0][0].content and "use beta" not in captured[0][0].content
        assert captured[0][1].content == "please use alpha"
        assert "use beta" in captured[1][0].content and "use alpha" not in captured[1][0].content
    finally:
        shutil.rmtree(other, ignore_errors=True)
        await host.supervisor.close()
        await host.store.db.close()


async def test_provider_secret_is_not_stored_or_sent_as_memory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    host = _host(tmp_path)
    host.profile.save_provider(host.profile.config.provider.model_copy(update={"api_key": SecretStr(KEY)}))
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    host.fence.host_epoch = await host.store.initialize(host.instance, host.build, lease)
    captured: list[list[Message]] = []

    async def fake_stream(config: ProviderConfig, messages: list[Message], offers=None, plugins=None):
        del config, offers
        captured.append(messages)
        yield Completion(message=Message(role="assistant", content="ok"), response_id="faux")

    monkeypatch.setattr("amazme_backend.worker.stream", fake_stream)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin, headers={
            "Authorization": "Bearer web-only", "x-amazme-build": host.build,
            "x-amazme-epoch": str(host.fence.host_epoch),
        }) as client:
            kept = await client.post("/api/v1/memories", json={
                "memory_id": MEMORY, "workspace": "primary", "text": "use alpha"})
            assert kept.status_code == 200
            rejected = await client.post("/api/v1/memories", json={
                "memory_id": "e" * 32, "workspace": "primary", "text": f"prefix {KEY} suffix"})
            assert rejected.status_code == 409 and rejected.json()["code"] == "memory_secret"
            assert KEY not in rejected.text
            listed = await client.get("/api/v1/memories", params={"workspace": "primary"})
            assert [item["text"] for item in listed.json()["memories"]] == ["use alpha"]
        secret = f"prefix {KEY} suffix"
        await host.store.save_memory("f" * 32, "primary", secret, remember("primary", secret))
        await host.store.create_session(PRIMARY_SESSION, CreateSession(title="主"))
        worker = Worker(host.profile, PRIMARY_SESSION, "worker-secret")
        await worker.perform(ModelInvocation(
            "step", "request", 1, [Message(role="user", content="please use alpha")],
            ProviderConfig(provider="faux")))
        await worker.perform(ModelInvocation(
            "step-2", "request-2", 1, [Message(role="user", content="prefix")],
            ProviderConfig(provider="faux")))
        sent = "\n".join(message.content for call in captured for message in call)
        assert "use alpha" in sent and KEY not in sent
    finally:
        await host.supervisor.close()
        await host.store.db.close()
