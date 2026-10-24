"""Own a disposable local profile for CLI --no-session, using the same backend.

The source vault keeps refresh ownership. The stdin pipe is the CLI lifetime;
EOF requests normal shutdown. A missing exit proof or unknown operation retains
this private profile for explicit recovery instead of discarding its ledger.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import secrets
import shutil
import signal
import sqlite3
import sys
import tempfile
from pathlib import Path

import httpx

from .common import Profile, child_command, lock, private_write
from .contracts import BackendError, HostReady, ProcessLease
from .processes import exited
from .providers import stored_provider
from .workspace_map import load_grants


def create_profile(source: Profile, workspace: Path) -> tuple[Profile, tuple[int, int]]:
    workspace = workspace.resolve(strict=True)
    if not workspace.is_dir():
        raise BackendError("workspace_not_directory")
    path = Path(tempfile.mkdtemp(prefix="am2-no-session-")).resolve()
    info = path.stat()
    config = source.config.model_copy(update={
        "profile_id":secrets.token_hex(16), "workspace":str(workspace), "testing":False,
        "provider":stored_provider(source.config.provider), "account_profile":str(source.account_path),
    })
    private_write(path / "config.json", config.model_dump_json())
    private_write(path / "control.token", secrets.token_hex(32))
    private_write(path / "web.token", secrets.token_hex(24))
    return Profile(path), (info.st_dev, info.st_ino)


def verify_owned(profile: Profile, identity: tuple[int, int]) -> None:
    info = profile.path.lstat()
    if profile.path.is_symlink() or (info.st_dev, info.st_ino) != identity:
        raise BackendError("transient_profile_replaced")
    if not profile.path.name.startswith("am2-no-session-") or profile.path == profile.account_path:
        raise BackendError("transient_profile_owner_mismatch")
    for path in (profile.path / "processes").glob("*.lock"):
        lease = ProcessLease.model_validate_json(path.read_bytes())
        if lease.profile_path != str(profile.path) or not exited(lease):
            raise BackendError("transient_exit_unproven")


def settled(profile: Profile) -> bool:
    host_database = profile.path / "host.sqlite"
    if host_database.exists():
        with contextlib.closing(sqlite3.connect(host_database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            if db.execute("SELECT 1 FROM deliveries WHERE state='pending' LIMIT 1").fetchone():
                return False
    database = profile.path / "execution.sqlite"
    if database.exists():
        with contextlib.closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            queries = (
                "SELECT 1 FROM scopes WHERE outcome!='completed' OR clean=0 LIMIT 1",
                "SELECT 1 FROM terminals WHERE phase!='exited' LIMIT 1",
                "SELECT 1 FROM mcp_servers WHERE clean=0 LIMIT 1",
                "SELECT 1 FROM mcp_calls WHERE phase NOT IN ('done','denied') LIMIT 1",
                "SELECT 1 FROM plugin_calls WHERE phase NOT IN ('done','denied','failed') LIMIT 1",
                "SELECT 1 FROM code_runs WHERE phase NOT IN ('success','failed','cancelled') LIMIT 1",
                "SELECT 1 FROM remote_calls WHERE phase NOT IN ('done','failed') LIMIT 1",
            )
            if any(db.execute(query).fetchone() is not None for query in queries):
                return False
    for database in (profile.path / "sessions").glob("*/session.sqlite"):
        with contextlib.closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            if db.execute("SELECT 1 FROM requests WHERE status NOT IN ('succeeded','cancelled','failed','interrupted') LIMIT 1").fetchone():
                return False
            if db.execute("SELECT 1 FROM effects WHERE json_extract(payload,'$.reconciled')=0 LIMIT 1").fetchone():
                return False
            if db.execute("SELECT 1 FROM computer_actions WHERE json_extract(payload,'$.phase')='unknown' LIMIT 1").fetchone():
                return False
    return True


def reclaim(profile: Profile, identity: tuple[int, int]) -> bool:
    verify_owned(profile, identity)
    with lock(profile.path / "host.lock"), lock(profile.path / "supervisor.lock"):
        verify_owned(profile, identity)
        if not settled(profile):
            return False
        # Everything below this root belongs to the profile created by this run.
        # The real workspace and the borrowed account vault are outside it.
        shutil.rmtree(profile.path)
    with contextlib.suppress(FileNotFoundError, OSError):
        profile.ipc.rmdir()
    return True


async def run(source: Path, workspace: Path, workspace_name: str = "") -> int:
    original = Profile(source)
    if workspace_name:
        location = original.config.workspace if workspace_name == "primary" else dict(load_grants(original.path)).get(workspace_name)
        if location is None:
            raise BackendError("workspace_not_found")
        workspace = Path(location)
    profile, identity = create_profile(original, workspace)
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    def on_stdin() -> None:
        loop.remove_reader(sys.stdin.fileno())
        stopped.set()
    loop.add_reader(sys.stdin.fileno(), on_stdin)
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    process: asyncio.subprocess.Process | None = None
    ready: HostReady | None = None
    result = 0
    try:
        with (profile.path / "serve.log").open("wb") as log:
            process = await asyncio.create_subprocess_exec(*child_command("serve", "--profile", str(profile.path), "--port", "0"),
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=log, start_new_session=True)
            assert process.stdout is not None
            line = await asyncio.wait_for(process.stdout.readline(), 40)
            ready = HostReady.model_validate_json(line)
            print(json.dumps({"url":ready.url, "token":(profile.path / "web.token").read_text().strip(),
                "profile":str(profile.path)}), flush=True)
            gone = asyncio.create_task(process.wait())
            ending = asyncio.create_task(stopped.wait())
            try:
                await asyncio.wait({gone, ending}, return_when=asyncio.FIRST_COMPLETED)
                if gone.done() and process.returncode != 0:
                    result = 1
            finally:
                ending.cancel()
                await asyncio.gather(ending, return_exceptions=True)
            if process.returncode is None:
                async with httpx.AsyncClient(trust_env=False, timeout=30) as client:
                    response = await client.post(ready.url + "/control/shutdown",
                        headers={"Authorization":"Bearer " + profile.token},
                        json={"host_epoch":ready.host_epoch, "build_id":ready.build_id})
                    response.raise_for_status()
                await asyncio.wait_for(asyncio.shield(gone), 90)
    except (OSError, ValueError, BackendError, httpx.HTTPError, TimeoutError) as error:
        result = 1
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
    finally:
        loop.remove_reader(sys.stdin.fileno())
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)
        if process is not None and process.returncode is None:
            # This direct child is still owned by asyncio; an early startup failure
            # can request shutdown, but process exit still needs its lease proof.
            with contextlib.suppress(ProcessLookupError):
                process.send_signal(signal.SIGINT)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(process.wait(), 30)
        try:
            removed = (process is None or process.returncode is not None) and reclaim(profile, identity)
        except (OSError, ValueError, sqlite3.Error, BackendError):
            removed = False
        if not removed:
            print(f"临时会话保留恢复记录：{profile.path}", file=sys.stderr)
            result = 1
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="amazme-backend transient")
    parser.add_argument("--source-profile", required=True, type=Path)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--workspace-name", default="")
    args = parser.parse_args(argv)
    os.umask(0o077)
    return asyncio.run(run(args.source_profile, args.workspace, args.workspace_name))
