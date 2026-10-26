"""Disposable native CLI profiles never own or copy the original account vault."""
import asyncio
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

from amazme_backend.accounts.store import AccountDocument, AccountStore, ApiKeyCredential
from amazme_backend.profiles.profile import Profile
from amazme_backend.platform.private_files import private_write
from pydantic import SecretStr
from amazme_backend.contracts import BackendError, CredentialUpdate, HostFence, ProcessLease, Submit
from amazme_backend.host.service import Host
from amazme_backend.host.store import HostStore
from amazme_backend.execution.processes import ProcessReservation
from amazme_backend.sessions.types import Continue, ModelInvocation
from amazme_backend.sessions.service import SessionStore
from amazme_backend.profiles.layout import session_database
from amazme_backend.bootstrap.transient import create_profile, reclaim, settled, verify_owned


def source_profile(tmp_path: Path) -> Profile:
    source, workspace = tmp_path / "source", tmp_path / "workspace"
    source.mkdir()
    workspace.mkdir()
    private_write(source / "config.json", json.dumps({"format":2, "profile_id":"original",
        "workspace":str(workspace), "resources":"unused", "user_resources":str(tmp_path / "agent"),
        "provider":{"provider":"faux", "api_key":"vault-only-secret"}}))
    private_write(source / "control.token", "original-control")
    private_write(source / "web.token", "original-web")
    AccountStore(source).write(AccountDocument(credentials={"faux":ApiKeyCredential(key=SecretStr("vault-only-secret"))}))
    return Profile(source)


def test_source_vault_is_shared_without_copy_and_owned_profile_can_be_removed(tmp_path: Path) -> None:
    source = source_profile(tmp_path)
    profile, identity = create_profile(source, Path(source.config.workspace))
    before = (source.path / "accounts.json").read_bytes()
    try:
        assert profile.account_path == source.path
        assert "vault-only-secret" not in (profile.path / "config.json").read_text()
        assert not (profile.path / "accounts.json").exists()
        assert AccountStore(profile.account_path).secrets() == ("vault-only-secret",)
        assert reclaim(profile, identity)
        assert not profile.path.exists()
        assert (source.path / "accounts.json").read_bytes() == before
        assert Path(source.config.workspace).is_dir()
    finally:
        if profile.path.exists():
            shutil.rmtree(profile.path)
        source.ipc.rmdir()


def test_replaced_identity_and_live_lease_prevent_deletion(tmp_path: Path) -> None:
    source = source_profile(tmp_path)
    profile, identity = create_profile(source, Path(source.config.workspace))
    try:
        with pytest.raises(BackendError, match="transient_profile_replaced"):
            verify_owned(profile, (identity[0],identity[1]+1))
        with ProcessReservation(profile.path, "worker", "still-owned"):
            with pytest.raises(BackendError, match="transient_exit_unproven"):
                reclaim(profile, identity)
            assert profile.path.exists()
        assert reclaim(profile, identity)
    finally:
        if profile.path.exists():
            shutil.rmtree(profile.path)
        source.ipc.rmdir()


async def test_account_updates_from_transient_use_original_revision_and_lock(tmp_path: Path) -> None:
    source = source_profile(tmp_path)
    profile, identity = create_profile(source, Path(source.config.workspace))
    host = Host(profile)
    try:
        lease = ProcessLease(instance_id=host.lifecycle.instance, role="host", profile_path=str(profile.path), path="lease", device=1, inode=1)
        host.lifecycle.fence = HostFence(host_epoch=await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, lease), build_id=host.lifecycle.build)
        revision = host.accounts.accounts.read().revision
        await host.accounts.update_account("deepseek", CredentialUpdate(expected_revision=revision, api_key=SecretStr("new-source-key")))
        saved = AccountStore(source.path).read().credentials["deepseek"]
        assert isinstance(saved, ApiKeyCredential)
        assert saved.key.get_secret_value() == "new-source-key"
        assert not (profile.path / "accounts.json").exists()
    finally:
        await host.lifecycle.store.db.close()
        await host.lifecycle.supervisor.close()
        assert reclaim(profile, identity)
        source.ipc.rmdir()


async def test_shipped_cli_no_session_finishes_with_no_saved_conversation(tmp_path: Path) -> None:
    source = source_profile(tmp_path)
    agent = tmp_path / "agent"
    agent.mkdir()
    (agent / "python-host").symlink_to(source.path, target_is_directory=True)
    root = Path(__file__).resolve().parents[2]
    cli = root / "packages/coding-agent/dist/bundle/cli.js"
    command = root / "backend/.venv/bin/amazme-backend"
    original = (source.path / "accounts.json").read_bytes()
    child = await asyncio.create_subprocess_exec(shutil.which("node") or "node", str(cli), "--no-session", "--mode", "json", "--print", "hello",
        cwd=source.config.workspace, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "AMAZME_CODING_AGENT_DIR":str(agent), "AMAZME_PYTHON_BACKEND":str(command)})
    try:
        stdout, stderr = await asyncio.wait_for(child.communicate(), 60)
        assert child.returncode == 0, stderr.decode()
        result = json.loads(stdout)
        assert result["status"] == "succeeded"
        assert not (source.path / "host.sqlite").exists()
        assert not (source.path / "sessions").exists()
        assert (source.path / "accounts.json").read_bytes() == original
        assert not stderr.strip(), stderr.decode()
    finally:
        if child.returncode is None:
            child.terminate()
            await asyncio.wait_for(child.wait(), 40)
        source.ipc.rmdir()


async def test_transient_manager_obeys_stdin_lifetime_and_cleans_owned_profile(tmp_path: Path) -> None:
    source = source_profile(tmp_path)
    before = (source.path / "accounts.json").read_bytes()
    child = await asyncio.create_subprocess_exec(sys.executable, "-m", "amazme_backend", "transient",
        "--source-profile", str(source.path), "--workspace", source.config.workspace,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    path: Path | None = None
    try:
        assert child.stdout is not None and child.stdin is not None
        ready = json.loads(await asyncio.wait_for(child.stdout.readline(), 40))
        path = Path(ready["profile"])
        assert path.is_dir() and settled(Profile(path))
        child.stdin.close()
        await asyncio.wait_for(child.wait(), 40)
        assert child.stderr is not None
        assert child.returncode == 0, (await child.stderr.read()).decode()
        assert not path.exists()
        assert (source.path / "accounts.json").read_bytes() == before
    finally:
        if child.returncode is None:
            child.terminate()
            await asyncio.wait_for(child.wait(), 40)
        if path and path.exists():
            pytest.fail(f"Owned transient profile was retained: {path}")
        source.ipc.rmdir()


async def test_unknown_outcome_retains_ledger_and_replaced_authority_is_rejected(tmp_path: Path) -> None:
    source = source_profile(tmp_path)
    profile, identity = create_profile(source, Path(source.config.workspace))
    database = session_database(profile.path, "b" * 32)
    database.parent.mkdir(parents=True)
    store = SessionStore(database, "b" * 32)
    try:
        await store.initialize()
        fence = HostFence(build_id="test-build", host_epoch=1)
        await store.fence(fence)
        await store.accept(Submit(request_id="original-id", text="test-only input"), fence)
        for _ in range(12):
            action = await store.advance()
            if not isinstance(action, Continue):
                break
        assert isinstance(action, ModelInvocation)
        # A persisted intent without a model response is an unknown operation;
        # this fixture invokes no model and performs no user side effect.
        await store.close()
        assert reclaim(profile, identity) is False
        assert database.is_file()
        replacement = profile.config.model_copy(update={"account_profile":str(profile.path)})
        private_write(profile.path / "config.json", replacement.model_dump_json())
        with pytest.raises(BackendError, match="profile_identity_mismatch"):
            profile.reload_provider()
    finally:
        await store.close()
        verify_owned(profile, identity)
        shutil.rmtree(profile.path)
        profile.ipc.rmdir()
        source.ipc.rmdir()


async def test_pending_host_delivery_keeps_the_original_request_ledger(tmp_path: Path) -> None:
    from amazme_backend.contracts import CreateSession

    source = source_profile(tmp_path)
    profile, identity = create_profile(source, Path(source.config.workspace))
    store = HostStore(profile.path / "host.sqlite")
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(profile.path), path="lease", device=1, inode=1)
    await store.initialize("host", "test-build", lease)
    try:
        session = "c" * 32
        await store.create_session(session, CreateSession())
        value = Submit(request_id="received-only", text="never delivered")
        pending = await store.enqueue(session, "submit", value.request_id, value)
        assert settled(profile) is False
        assert reclaim(profile, identity) is False
        await store.rejected(pending.delivery_id, BackendError("cancelled_before_dispatch"))
        await store.db.close()
        assert reclaim(profile, identity)
    finally:
        await store.db.close()
        if profile.path.exists():
            verify_owned(profile, identity)
            shutil.rmtree(profile.path)
            profile.ipc.rmdir()
        source.ipc.rmdir()


def test_persistent_session_directory_links_original_vault_and_never_overwrites(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from amazme_backend.bootstrap.commands import main

    source = source_profile(tmp_path)
    destination = tmp_path / "history" / "python-host"
    source_history = source.path / "host.sqlite"
    source_history.write_bytes(b"original history")
    before = (source.path / "accounts.json").read_bytes()
    monkeypatch.setattr(sys, "argv", ["amazme-backend", "init", "--profile", str(destination),
        "--workspace", source.config.workspace, "--source-profile", str(source.path)])
    profile: Profile | None = None
    try:
        main()
        profile = Profile(destination)
        assert profile.account_path == source.path
        assert profile.config.profile_id != source.config.profile_id
        assert profile.config.workspace == source.config.workspace
        assert profile.config.user_resources == source.config.user_resources
        assert "vault-only-secret" not in (destination / "config.json").read_text()
        assert not (destination / "accounts.json").exists()
        assert not (destination / "host.sqlite").exists()
        assert (destination / "web.token").read_text() != (source.path / "web.token").read_text()
        assert AccountStore(profile.account_path).secrets() == ("vault-only-secret",)
        config = (destination / "config.json").read_bytes()
        with pytest.raises(FileExistsError):
            main()
        assert (destination / "config.json").read_bytes() == config
        assert source_history.read_bytes() == b"original history"
        assert (source.path / "accounts.json").read_bytes() == before
    finally:
        source.ipc.rmdir()
        if profile:
            profile.ipc.rmdir()
