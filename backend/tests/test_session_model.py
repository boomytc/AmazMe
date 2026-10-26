"""A session remembers the model that was selected for it, including across a reopened host store."""

import json
from pathlib import Path

from amazme_backend.contracts import HostFence, ProcessLease, SessionModel
from amazme_backend.host.service import Host
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.profile import Profile


def _host(tmp_path: Path) -> Host:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "models", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux", "api_key": ""}}))
    (tmp_path / "primary").mkdir(exist_ok=True)
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    host = Host(Profile(tmp_path))
    host.lifecycle.fence = HostFence(host_epoch=1, build_id=host.lifecycle.build)
    host.origin = "http://127.0.0.1:9"
    return host


async def test_session_model_is_per_session_and_survives_reopen(tmp_path: Path) -> None:
    host = _host(tmp_path)
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease)
    try:
        first = await host.accounts.save_session_model(SessionModel(session_id="demo-1", provider="anthropic", model="claude-opus-4-6"))
        second = await host.accounts.save_session_model(SessionModel(session_id="demo-2", provider="anthropic", model="claude-sonnet-4-5"))
        assert first.model == "claude-opus-4-6"
        assert (await host.accounts.session_model("demo-2")).model == second.model
        changed = await host.accounts.save_session_model(SessionModel(session_id="demo-1", provider="faux", model="faux"))
        assert changed.model == "faux"
        assert (await host.accounts.session_model("demo-2")).model == "claude-sonnet-4-5"
    finally:
        await host.lifecycle.store.db.close()
    reopened = _host(tmp_path)
    await reopened.lifecycle.store.initialize(reopened.lifecycle.instance, reopened.lifecycle.build, lease)
    try:
        assert (await reopened.accounts.session_model("demo-1")).model == "faux"
        assert (await reopened.accounts.session_model("demo-2")).provider == "anthropic"
    finally:
        await reopened.lifecycle.store.db.close()
