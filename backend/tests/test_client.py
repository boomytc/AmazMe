"""CLI, RPC, and the async SDK name the host, session, and workspace."""

import json
import os
import secrets
import select
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import cast

from runtime_cleanup import stop_and_destroy

from amazme_backend.contracts import BackendError
from amazme_backend.sdk import Client

TOKEN_FILE = "web.token"


def _serve(tmp_path: Path) -> tuple[subprocess.Popen[bytes], str, Path]:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    profile = tmp_path / "profile"
    provider = tmp_path / "provider.json"
    provider.write_text(json.dumps({
        "provider": "faux", "model": "faux", "base_url": "", "api_key": "",
        "max_tokens": 2048, "proxy": "", "headers": {},
    }))
    init = subprocess.run(
        [sys.executable, "-m", "amazme_backend", "init", "--profile", str(profile),
         "--workspace", str(workspace), "--provider-config", str(provider)],
        check=False, capture_output=True, text=True)
    assert init.returncode == 0, init.stderr
    err_path = tmp_path / "serve.err"
    err_file = err_path.open("wb")
    proc = subprocess.Popen(
        [sys.executable, "-m", "amazme_backend", "serve", "--profile", str(profile), "--port", "0"],
        stdout=subprocess.PIPE, stderr=err_file)
    err_file.close()
    assert proc.stdout is not None
    ready = _ready(proc, time.monotonic() + 30)
    if "url" not in ready:
        proc.kill()
        proc.wait(timeout=10)
        raise AssertionError(err_path.read_text(errors="replace")[-2000:])
    return proc, str(ready["url"]), profile


def _ready(proc: subprocess.Popen[bytes], deadline: float) -> dict[str, object]:
    assert proc.stdout is not None
    fd = proc.stdout.fileno()
    os.set_blocking(fd, False)
    pending = ""
    while time.monotonic() < deadline:
        if proc.poll() is not None and not pending:
            break
        readable, _, _ = select.select([fd], [], [], 0.05)
        if not readable:
            continue
        chunk = os.read(fd, 4096)
        if not chunk:
            if proc.poll() is not None:
                break
            continue
        pending += chunk.decode()
        if "\n" not in pending:
            continue
        line, pending = pending.split("\n", 1)
        if not line.startswith("{"):
            continue
        loaded = json.loads(line)
        if isinstance(loaded, dict) and "url" in loaded:
            return {str(key): value for key, value in cast(dict[object, object], loaded).items()}
    return {}


def _stop(proc: subprocess.Popen[bytes], profile: Path) -> None:
    try:
        stop_and_destroy([sys.executable, "-m", "amazme_backend"], profile)
    finally:
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        if proc.stdout is not None:
            proc.stdout.close()


def _cli(url: str, token: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "amazme_backend", "client", "--url", url, "--token", token, *args],
        check=False, capture_output=True, text=True, timeout=60)


async def _rejects(action, code: str) -> None:
    try:
        await action()
    except BackendError as exc:
        assert exc.code == code
    else:
        raise AssertionError(code + " was accepted")


async def test_release_does_not_cancel_and_cli_reads_the_answer(tmp_path: Path) -> None:
    proc, url, profile = _serve(tmp_path)
    token = (profile / TOKEN_FILE).read_text().strip()
    future = int(time.time() * 1000) + 60_000
    try:
        async with Client(url, token) as client:
            created = await client.rpc("session.create", workspace="primary", title="命令")
            session_id = str(created["session_id"])
            assert created["workspace"] == "primary"
            attachment = await client.attach(session_id)
            held = await client.submit(
                session_id=session_id, workspace="primary", attachment_id=attachment.attachment_id,
                request_id="held", text="稍后", not_before_ms=future)
            assert held.status in {"queued", "waiting_time"}
            assert held.cancel_requested is False
            await client.release(session_id=session_id, attachment_id=attachment.attachment_id)
            still = await client.request(session_id=session_id, request_id="held")
            assert still.status == held.status
            assert still.cancel_requested is False
            await _rejects(lambda: client.submit(
                session_id=session_id, workspace="primary", attachment_id=attachment.attachment_id,
                request_id="after-release", text="再来"), "stale_client_binding")

            second = await client.attach(session_id)
            released = await client.rpc(
                "session.release", session_id=session_id, attachment_id=second.attachment_id)
            assert released == {"detached": True, "cancelled": False}
            still = await client.request(session_id=session_id, request_id="held")
            assert still.status == held.status
            assert still.cancel_requested is False
            await _rejects(lambda: client.cancel(
                session_id=session_id, workspace="primary", attachment_id=second.attachment_id,
                request_id="held"), "stale_client_binding")

            third = await client.attach(session_id)
            await _rejects(lambda: client.rpc(
                "request.submit", session_id=session_id, workspace="other",
                attachment_id=third.attachment_id, request_id="nope", text="不要"), "workspace_mismatch")
            cancelled = await client.cancel(
                session_id=session_id, workspace="primary", attachment_id=third.attachment_id,
                request_id="held")
            finished = await client.wait(session_id=session_id, request_id=cancelled.request_id)
            assert finished.status == "cancelled"

        created_cli = _cli(url, token, "create", "--workspace", "primary", "--title", "命令行")
        assert created_cli.returncode == 0, created_cli.stderr
        cli_session = str(json.loads(created_cli.stdout)["session_id"])
        assert token not in created_cli.stdout and token not in created_cli.stderr
        submitted = _cli(url, token, "submit", "--session", cli_session, "--workspace", "primary",
                         "--request-id", "cli-1", "--text", "你好")
        assert submitted.returncode == 0, submitted.stderr
        answer = json.loads(submitted.stdout)
        assert answer["status"] == "succeeded"
        assert answer["answer"] == "已收到：你好"
        assert token not in submitted.stdout and token not in submitted.stderr
        rejected = _cli(url, token, "rpc", "--method", "request.submit", "--params", json.dumps({
            "session_id": cli_session, "workspace": "other", "attachment_id": "none",
            "request_id": "nope", "text": "不要"}))
        assert rejected.returncode == 1
        assert rejected.stderr.strip() == "workspace_mismatch"
        assert token not in rejected.stdout and token not in rejected.stderr

        async with Client(url, token) as client:
            parked_attachment = await client.attach(cli_session)
            parked = await client.submit(
                session_id=cli_session, workspace="primary", attachment_id=parked_attachment.attachment_id,
                request_id="parked", text="等一下", not_before_ms=future)
            assert parked.status in {"queued", "waiting_time"}
        released_cli = _cli(url, token, "release", "--session", cli_session,
                            "--attachment", parked_attachment.attachment_id)
        assert released_cli.returncode == 0, released_cli.stderr
        assert json.loads(released_cli.stdout) == {"detached": True, "cancelled": False}
        assert token not in released_cli.stdout and token not in released_cli.stderr
        async with Client(url, token) as client:
            still = await client.request(session_id=cli_session, request_id="parked")
            assert still.status == parked.status
            assert still.cancel_requested is False
            await _rejects(lambda: client.submit(
                session_id=cli_session, workspace="primary", attachment_id=parked_attachment.attachment_id,
                request_id="after-cli-release", text="再来"), "stale_client_binding")
            fresh = await client.attach(cli_session)
            await client.cancel(
                session_id=cli_session, workspace="primary", attachment_id=fresh.attachment_id,
                request_id="parked")
            done = await client.wait(session_id=cli_session, request_id="parked")
            assert done.status == "cancelled"
    finally:
        _stop(proc, profile)


def test_decide_rejects_bad_targets_before_connect() -> None:
    token = "not-a-real-token"
    base = ["decide", "--session", "s", "--workspace", "primary"]
    cases = [
        ([*base, "--decision", "yes"], "invalid_decision"),
        ([*base, "--request", "a", "--decision", "批准"], "approval_id_required"),
        ([*base, "--decision", "批准"], "decision_target_conflict"),
        ([*base, "--request", "a", "--call", "b", "--decision", "批准"], "decision_target_conflict"),
        ([*base, "--call", "b", "--decision", "批准"], "decision_target_conflict"),
        ([*base, "--request", "a", "--server", "c", "--decision", "拒绝"], "decision_target_conflict"),
    ]
    for args, code in cases:
        result = _cli("http://127.0.0.1:1", token, *args)
        assert result.returncode == 1, result.stderr
        assert result.stderr.strip() == code
        assert token not in result.stdout and token not in result.stderr


async def test_client_decide_records_one_shell_and_mcp_effect(tmp_path: Path) -> None:
    proc, url, profile = _serve(tmp_path)
    token = (profile / TOKEN_FILE).read_text().strip()
    workspace = tmp_path / "workspace"
    probe = Path(__file__).resolve().parents[1] / "tools" / "mcp_probe_server.py"
    try:
        created = _cli(url, token, "create", "--workspace", "primary", "--title", "决定")
        assert created.returncode == 0, created.stderr
        session_id = str(json.loads(created.stdout)["session_id"])
        waiting = _cli(url, token, "submit", "--session", session_id, "--workspace", "primary",
                       "--request-id", "hold-shell", "--text", "/shell printf u > undecided.txt")
        assert waiting.returncode == 2, waiting.stdout
        held_approval_id = str(json.loads(waiting.stdout)["approval_id"])
        assert not (workspace / "undecided.txt").exists()
        assert token not in waiting.stdout and token not in waiting.stderr

        denied = _cli(url, token, "decide", "--session", session_id, "--workspace", "primary",
                      "--request", "hold-shell", "--approval-id", held_approval_id, "--decision", "拒绝")
        assert denied.returncode == 0, denied.stderr
        denied_receipt = json.loads(denied.stdout)
        assert denied_receipt["status"] == "failed"
        assert denied_receipt["error"] == "approval_denied"
        assert not (workspace / "undecided.txt").exists()
        assert token not in denied.stdout and token not in denied.stderr

        async with Client(url, token) as client:
            attachment = await client.attach(session_id)
            held = await client.submit(
                session_id=session_id, workspace="primary", attachment_id=attachment.attachment_id,
                request_id="run-shell", text="/shell printf y > decided.txt")
            assert held.status in {"queued", "running", "waiting_approval"}
            _, pending_approval = await client.await_user_decision(session_id=session_id, request_id="run-shell")
            assert pending_approval is not None
            run_approval_id = pending_approval.approval_id
            await client.release(session_id=session_id,attachment_id=attachment.attachment_id)
        granted = _cli(url, token, "decide", "--session", session_id, "--workspace", "primary",
                       "--request", "run-shell", "--approval-id", run_approval_id, "--decision", "批准")
        assert granted.returncode == 0, granted.stderr
        assert json.loads(granted.stdout)["status"] == "succeeded"
        assert (workspace / "decided.txt").read_text() == "y"
        assert token not in granted.stdout and token not in granted.stderr

        mismatch = _cli(url, token, "decide", "--session", session_id, "--workspace", "other",
                        "--request", "run-shell", "--approval-id", run_approval_id, "--decision", "批准")
        assert mismatch.returncode == 1
        assert mismatch.stderr.strip() == "workspace_mismatch"
        repeated = _cli(url, token, "decide", "--session", session_id, "--workspace", "primary",
                        "--request", "run-shell", "--approval-id", run_approval_id, "--decision", "批准")
        assert repeated.returncode == 0, repeated.stderr
        assert json.loads(repeated.stdout)["status"] == "succeeded"
        opposite = _cli(url, token, "decide", "--session", session_id, "--workspace", "primary",
                        "--request", "hold-shell", "--approval-id", held_approval_id, "--decision", "批准")
        assert opposite.returncode == 1
        assert json.loads(opposite.stdout)["error"] == "approval_denied"
        assert (workspace / "decided.txt").read_text() == "y"
        assert not (workspace / "undecided.txt").exists()

        prompt = _cli(url, token, "submit", "--session", session_id, "--workspace", "primary",
                      "--request-id", "word", "--text", "批准")
        assert prompt.returncode == 0, prompt.stderr
        assert json.loads(prompt.stdout)["answer"] == "已收到：批准"
        assert (workspace / "decided.txt").read_text() == "y"
        assert not (workspace / "undecided.txt").exists()

        command = shlex.join([sys.executable, str(probe), "--workspace", str(workspace)])
        server_id = secrets.token_hex(16)
        async with Client(url, token) as client:
            attachment = await client.attach(session_id)
            opened = await client.open_mcp(
                session_id=session_id, attachment_id=attachment.attachment_id, server_id=server_id,
                command=command, workspace="primary")
            assert opened.phase == "ready"
            assert any(tool.name == "native_echo" for tool in opened.tools)
            refused_id = secrets.token_hex(16)
            refused = await client.request_mcp(
                session_id=session_id, attachment_id=attachment.attachment_id, server_id=server_id,
                call_id=refused_id, name="native_echo", arguments={"text": "no", "numbers": [1]})
            assert refused.phase == "waiting_approval"
        refused_cli = _cli(url, token, "decide", "--session", session_id, "--workspace", "primary",
                           "--server", server_id, "--call", refused_id, "--decision", "拒绝")
        assert refused_cli.returncode == 0, refused_cli.stderr
        assert json.loads(refused_cli.stdout)["phase"] == "denied"
        assert not (workspace / "mcp-effect.txt").exists()

        accepted_id = secrets.token_hex(16)
        async with Client(url, token) as client:
            attachment = await client.attach(session_id)
            accepted = await client.request_mcp(
                session_id=session_id, attachment_id=attachment.attachment_id, server_id=server_id,
                call_id=accepted_id, name="native_echo", arguments={"text": "from-client", "numbers": [1, 2]})
            assert accepted.phase == "waiting_approval"
        accepted_cli = _cli(url, token, "decide", "--session", session_id, "--workspace", "primary",
                            "--server", server_id, "--call", accepted_id, "--decision", "批准")
        assert accepted_cli.returncode == 0, accepted_cli.stderr
        body = json.loads(accepted_cli.stdout)
        assert body["phase"] == "done"
        assert body["is_error"] is False
        assert (workspace / "mcp-effect.txt").read_text() == "from-client"
        again = _cli(url, token, "decide", "--session", session_id, "--workspace", "primary",
                     "--server", server_id, "--call", accepted_id, "--decision", "批准")
        assert again.returncode == 0, again.stderr
        assert json.loads(again.stdout)["phase"] == "done"
        flipped = _cli(url, token, "decide", "--session", session_id, "--workspace", "primary",
                       "--server", server_id, "--call", refused_id, "--decision", "批准")
        assert flipped.returncode == 1
        assert json.loads(flipped.stdout)["phase"] == "denied"
        assert (workspace / "mcp-effect.txt").read_text() == "from-client"

        async with Client(url, token) as client:
            attachment = await client.attach(session_id)
            closed = await client.close_mcp(
                session_id=session_id, attachment_id=attachment.attachment_id, server_id=server_id)
            assert closed.phase == "exited"
            assert closed.clean is True
            state = await client.mcp_state(session_id)
            assert state.servers[0].phase == "exited"
    finally:
        _stop(proc, profile)


async def test_cli_retry_of_consumed_proposal_cannot_approve_the_next_tool(capsys) -> None:
    from types import SimpleNamespace

    from amazme_backend.interfaces.cli import _apply_decision
    from amazme_backend.contracts import Approval, Receipt, ToolCall

    receipt = Receipt(request_id="original",text="task",status="waiting_approval")
    old = Approval(approval_id="old",request_id="original",run_id="original",call_id="first",
        call=ToolCall(id="first",name="shell",arguments='{"command":"first"}'),build_id="build",
        proposal_digest="first-digest",revision="1",state="consumed")
    next_approval = old.model_copy(update={"approval_id":"next","revision":"2","state":"pending"})

    class FakeClient:
        released = False
        async def session(self, _session): return SimpleNamespace(workspace="primary")
        async def attach(self, _session): return SimpleNamespace(attachment_id="attachment")
        async def request(self, **_kwargs): return receipt
        async def snapshot(self, _session): return SimpleNamespace(approvals=[old,next_approval])
        async def decide(self, **_kwargs): raise AssertionError("A settled proposal must only be queried")
        async def await_user_decision(self, **_kwargs): return receipt,next_approval
        async def release(self, **_kwargs): self.released = True

    client = FakeClient()
    status = await _apply_decision(client,session_id="session",workspace="primary",request="original",
        call="",server="",approve=True,approval_id="old")
    assert status == 2 and client.released
    assert json.loads(capsys.readouterr().out)["approval_id"] == "next"
