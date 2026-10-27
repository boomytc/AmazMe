"""Run a separate Python process that uses amazme_backend.sdk.Client."""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from resource_budget import ResourceBudget
from resource_census import apply_cleanup, raise_pending, release_named_slot
from verify_runtime import ROOT, Runtime

SECRET = re.compile(r"(KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)", re.IGNORECASE)
TERMINAL = {"succeeded", "cancelled", "interrupted", "failed", "unknown"}
MCP_TERMINAL = {"done", "denied", "unknown", "conflict"}


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _emit(result: object) -> None:
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))


async def _drive(url: str, token: str, method: str, params: dict[str, object]) -> None:
    from amazme_backend.contracts import BackendError
    from amazme_backend.sdk import Client

    def need(name: str) -> str:
        value = params.get(name)
        if not isinstance(value, str) or not value:
            raise BackendError("binding_required")
        return value

    async with Client(url, token) as client:
        if method == "create":
            session = await client.create_session(title=need("title"), workspace=need("workspace"))
            _emit(session.model_dump(mode="json"))
            return
        if method == "attach":
            _emit((await client.attach(need("session_id"))).model_dump(mode="json"))
            return
        if method == "release":
            await client.release(session_id=need("session_id"), attachment_id=need("attachment_id"))
            _emit({"detached": True, "cancelled": False})
            return
        if method == "submit":
            receipt = await client.submit(
                session_id=need("session_id"), workspace=need("workspace"), attachment_id=need("attachment_id"),
                request_id=need("request_id"), text=need("text"), not_before_ms=int(params.get("not_before_ms") or 0))
            _emit(receipt.model_dump(mode="json"))
            return
        if method == "lookup":
            _emit((await client.request(session_id=need("session_id"), request_id=need("request_id"))).model_dump(mode="json"))
            return
        if method == "pending":
            receipt, approval = await client.await_user_decision(
                session_id=need("session_id"), request_id=need("request_id"), attempts=400)
            body: dict[str, object] = {"status": receipt.status, "error": receipt.error}
            if approval is not None:
                body.update(approval_id=approval.approval_id, revision=approval.revision, proposal_digest=approval.proposal_digest)
            _emit(body)
            return
        if method == "decide":
            if not isinstance(params.get("approve"), bool):
                raise BackendError("decision_required")
            receipt = await client.decide(
                session_id=need("session_id"), attachment_id=need("attachment_id"), decision_id=need("decision_id"),
                approval_id=need("approval_id"), expected_revision=need("expected_revision"),
                proposal_digest=need("proposal_digest"), approve=params["approve"] is True)
            if receipt.status not in TERMINAL:
                receipt = await client.wait(session_id=need("session_id"), request_id=need("request_id"), attempts=400)
            _emit(receipt.model_dump(mode="json"))
            return
        if method == "file":
            _emit((await client.read_file(need("path"))).model_dump(mode="json"))
            return
        if method == "checkpoint":
            saved = await client.save_checkpoint(
                checkpoint_id=need("checkpoint_id"), workspace=need("workspace"), path=need("path"))
            _emit(saved.model_dump(mode="json"))
            return
        if method == "terminal_open":
            view = await client.open_terminal(
                session_id=need("session_id"), attachment_id=need("attachment_id"), terminal_id=need("terminal_id"),
                command=need("command"), cols=int(params.get("cols") or 80), rows=int(params.get("rows") or 24),
                workspace=need("workspace"))
            _emit(view.model_dump(mode="json"))
            return
        if method == "terminal_write":
            view = await client.write_terminal(
                session_id=need("session_id"), attachment_id=need("attachment_id"), terminal_id=need("terminal_id"),
                input_id=need("input_id"), data=need("data"))
            _emit(view.model_dump(mode="json"))
            return
        if method == "terminal_wait":
            needle = need("needle")
            view = await client.read_terminal(
                session_id=need("session_id"), attachment_id=need("attachment_id"), terminal_id=need("terminal_id"))
            for _ in range(200):
                if needle in view.output:
                    break
                await asyncio.sleep(0.05)
                view = await client.read_terminal(
                    session_id=need("session_id"), attachment_id=need("attachment_id"), terminal_id=need("terminal_id"))
            else:
                raise BackendError("request_pending")
            _emit(view.model_dump(mode="json"))
            return
        if method == "terminal_resize":
            view = await client.resize_terminal(
                session_id=need("session_id"), attachment_id=need("attachment_id"), terminal_id=need("terminal_id"),
                cols=int(params["cols"]), rows=int(params["rows"]))
            _emit(view.model_dump(mode="json"))
            return
        if method == "terminal_list":
            _emit((await client.list_terminals(need("session_id"))).model_dump(mode="json"))
            return
        if method == "terminal_close":
            view = await client.close_terminal(
                session_id=need("session_id"), attachment_id=need("attachment_id"), terminal_id=need("terminal_id"))
            _emit(view.model_dump(mode="json"))
            return
        if method == "mcp_open":
            view = await client.open_mcp(
                session_id=need("session_id"), attachment_id=need("attachment_id"), server_id=need("server_id"),
                command=need("command"), workspace=need("workspace"))
            _emit(view.model_dump(mode="json"))
            return
        if method == "mcp_call":
            arguments = params.get("arguments")
            if not isinstance(arguments, dict):
                raise BackendError("invalid_tool_arguments")
            view = await client.request_mcp(
                session_id=need("session_id"), attachment_id=need("attachment_id"), server_id=need("server_id"),
                call_id=need("call_id"), name=need("name"), arguments=arguments)
            _emit(view.model_dump(mode="json"))
            return
        if method == "mcp_decide":
            if not isinstance(params.get("approve"), bool):
                raise BackendError("decision_required")
            view = await client.decide_mcp(
                session_id=need("session_id"), attachment_id=need("attachment_id"), server_id=need("server_id"),
                call_id=need("call_id"), decision_id=need("decision_id"), digest=need("digest"),
                approve=params["approve"] is True)
            if view.phase not in MCP_TERMINAL:
                view = await client.await_mcp(need("session_id"), need("call_id"), attempts=400)
            _emit(view.model_dump(mode="json"))
            return
        if method == "mcp_state":
            _emit((await client.mcp_state(need("session_id"))).model_dump(mode="json"))
            return
        if method == "mcp_close":
            view = await client.close_mcp(
                session_id=need("session_id"), attachment_id=need("attachment_id"), server_id=need("server_id"))
            _emit(view.model_dump(mode="json"))
            return
        raise BackendError("method_not_found")


def _child() -> None:
    from amazme_backend.contracts import BackendError

    url, token, method, raw = sys.argv[2:6]
    params = json.loads(raw)
    if not isinstance(params, dict):
        raise SystemExit("invalid_rpc")
    try:
        asyncio.run(_drive(url, token, method, params))
    except BackendError as exc:
        print(json.dumps({"ok": False, "error": exc.code}))


def _env() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not SECRET.search(key)}
    for name in ("AMAZME_PYTHON_URL", "AMAZME_PYTHON_TOKEN", "AMAZME_PYTHON_SESSION", "AMAZME_PYTHON_BACKEND",
                 "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(name, None)
    return env


def _invoke(url: str, token: str, method: str, params: dict[str, object]) -> dict[str, object]:
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--drive", url, token, method, json.dumps(params)],
        cwd=ROOT, env=_env(), capture_output=True, text=True, timeout=60, check=False)
    lines = [line for line in proc.stdout.splitlines() if line.startswith("{")]
    assert proc.returncode == 0 and lines, f"{proc.returncode}\n{proc.stderr[-800]}\n{proc.stdout[-400]}"
    loaded = json.loads(lines[-1])
    assert isinstance(loaded, dict)
    assert token not in proc.stdout and token not in proc.stderr
    return loaded


def _ok(body: dict[str, object]) -> dict[str, object]:
    assert body.get("ok") is True, body.get("error")
    result = body["result"]
    assert isinstance(result, dict)
    return result


def _hid() -> str:
    return secrets.token_hex(16)


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--drive":
        _child()
        return
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "sdk-", 2)
    root = Path(tempfile.mkdtemp(prefix="sdk-", dir=parent))
    provider = root / "provider.json"
    provider.write_text('{"provider":"faux"}')
    checks: list[str] = []
    report: dict[str, object] = {"status": "running", "execution": "sdk-source", "vm_created": False, "checks": checks}
    runtime: Runtime | None = None
    decoy = subprocess.Popen(["/bin/sleep", "600"])
    budget = ResourceBudget([ROOT / ".artifacts"], limit_bytes=512 * 1024**2, deadline_seconds=240)
    token = ""
    try:
        with budget:
            runtime = Runtime([sys.executable, "-m", "amazme_backend"], root, provider, approval_policy="mutations")
            runtime.start()
            assert runtime.process is not None and runtime.client is not None and runtime.ready is not None
            token = (runtime.profile / "web.token").read_text().strip()
            url = str(runtime.ready["url"])
            report["identity"] = {"build_id": runtime.ready["build_id"], "url": url, "host_pid": runtime.process.pid}

            def call(method: str, **params: object) -> dict[str, object]:
                return _ok(_invoke(url, token, method, params))

            def reject(method: str, code: str, **params: object) -> None:
                body = _invoke(url, token, method, params)
                assert body.get("ok") is False and body.get("error") == code, body

            created = call("create", title="命令", workspace="primary")
            session = str(created["session_id"])
            attachment = str(call("attach", session_id=session)["attachment_id"])
            bound = {"session_id": session, "attachment_id": attachment, "workspace": "primary"}
            shell = runtime.workspace / "sdk-shell.txt"
            reject("submit", "workspace_mismatch", **{**bound, "workspace": "other", "request_id": _hid(), "text": "不要"})
            request = _hid()
            call("submit", **bound, request_id=request, text="/shell printf y > sdk-shell.txt")
            pending = call("pending", session_id=session, request_id=request)
            assert pending["status"] == "waiting_approval" and not shell.exists()
            reject("decide", "decision_required", **bound, request_id=request, decision_id=_hid(),
                   approval_id=pending["approval_id"], expected_revision=pending["revision"], proposal_digest=pending["proposal_digest"])
            assert not shell.exists()
            reject(
                "decide", "stale_approval", **bound, request_id=request, decision_id=_hid(), approve=True,
                approval_id=pending["approval_id"], expected_revision=pending["revision"], proposal_digest="0" * 64)
            assert not shell.exists()
            still = call("pending", session_id=session, request_id=request)
            assert still["status"] == "waiting_approval"
            denied = call(
                "decide", **bound, request_id=request, decision_id=_hid(), approve=False,
                approval_id=still["approval_id"], expected_revision=still["revision"],
                proposal_digest=still["proposal_digest"])
            assert denied["status"] == "failed" and denied["error"] == "approval_denied" and not shell.exists()
            checks.append("the SDK process left the shell pending, a mismatched digest did nothing, and a refusal wrote nothing")

            request = _hid()
            call("submit", **bound, request_id=request, text="/shell printf y > sdk-shell.txt")
            pending = call("pending", session_id=session, request_id=request)
            granted = call(
                "decide", **bound, request_id=request, decision_id=_hid(), approve=True,
                approval_id=pending["approval_id"], expected_revision=pending["revision"],
                proposal_digest=pending["proposal_digest"])
            assert granted["status"] == "succeeded" and shell.read_text() == "y"
            assert call("file", path="sdk-shell.txt")["content"] == "y"
            assert len(str(call("checkpoint", checkpoint_id=_hid(), workspace="primary", path="sdk-shell.txt")["digest"])) == 64
            checks.append("an explicit approval wrote the file once, and the same client read it and saved a checkpoint")

            terminal = _hid()
            opened = call("terminal_open", **bound, terminal_id=terminal, command="sh", cols=80, rows=24)
            assert opened["phase"] == "running"
            typed = call(
                "terminal_write", **bound, terminal_id=terminal, input_id=_hid(),
                data="printf x > sdk-term.txt; printf 'SDK_TERM_OK\\n'\n")
            assert typed["input_status"] == "accepted"
            seen = call("terminal_wait", **bound, terminal_id=terminal, needle="SDK_TERM_OK")
            assert "SDK_TERM_OK" in str(seen["output"])
            assert (runtime.workspace / "sdk-term.txt").read_text() == "x"
            resized = call("terminal_resize", **bound, terminal_id=terminal, cols=100, rows=40)
            assert resized["cols"] == 100 and resized["rows"] == 40
            call("terminal_write", **bound, terminal_id=terminal, input_id=_hid(), data="stty size\n")
            sized = call("terminal_wait", **bound, terminal_id=terminal, needle="40 100")
            assert "40 100" in str(sized["output"])
            checks.append("terminal input was accepted, then resize was visible, without claiming command success")

            command = shlex.join([
                str(ROOT / "backend/.venv/bin/python"), str(ROOT / "backend/tools/mcp_probe_server.py"),
                "--workspace", str(runtime.workspace)])
            server = _hid()
            assert call("mcp_open", **bound, server_id=server, command=command)["phase"] == "ready"
            waiting = call(
                "mcp_call", **bound, server_id=server, call_id=_hid(), name="native_echo",
                arguments={"text": "denied", "numbers": [1]})
            assert waiting["phase"] == "waiting_approval"
            assert not (runtime.workspace / "mcp-effect.txt").exists()
            reject(
                "mcp_decide", "decision_required", **bound, server_id=server, call_id=waiting["call_id"],
                decision_id=_hid(), digest=waiting["digest"])
            assert not (runtime.workspace / "mcp-effect.txt").exists()
            reject(
                "mcp_decide", "mcp_call_conflict", **bound, server_id=server, call_id=waiting["call_id"],
                decision_id=_hid(), approve=False, digest="0" * 64)
            assert not (runtime.workspace / "mcp-effect.txt").exists()
            refused = call(
                "mcp_decide", **bound, server_id=server, call_id=waiting["call_id"],
                decision_id=_hid(), approve=False, digest=waiting["digest"])
            assert refused["phase"] == "denied"
            accepted = call(
                "mcp_call", **bound, server_id=server, call_id=_hid(), name="native_echo",
                arguments={"text": "x", "numbers": [2, 3]})
            finished = call(
                "mcp_decide", **bound, server_id=server, call_id=accepted["call_id"],
                decision_id=_hid(), approve=True, digest=accepted["digest"])
            assert finished["phase"] == "done"
            assert (runtime.workspace / "mcp-effect.txt").read_text() == "x"
            checks.append("MCP waited for an explicit decision, a mismatched digest had no effect, and one approval wrote once")

            other = str(call("create", title="另一个", workspace="primary")["session_id"])
            assert other != session
            call("attach", session_id=other)
            foreign = call("terminal_list", session_id=other)["terminals"]
            assert foreign == []
            owned = call("terminal_list", session_id=session)["terminals"]
            assert isinstance(owned, list) and len(owned) == 1 and owned[0]["phase"] == "running"
            servers = call("mcp_state", session_id=session)["servers"]
            assert isinstance(servers, list) and len(servers) == 1 and servers[0]["phase"] == "ready"
            checks.append("another SDK session stayed separate and did not stop the first terminal or MCP service")

            parked_id = "ab" * 16
            parked = call("submit", **bound, request_id=parked_id, text="仍在", not_before_ms=int(time.time() * 1000) + 3_600_000)
            assert parked["status"] in {"queued", "waiting_time"} and parked["cancel_requested"] is False
            released = call("release", session_id=session, attachment_id=attachment)
            assert released == {"detached": True, "cancelled": False}
            still_parked = call("lookup", session_id=session, request_id=parked_id)
            assert still_parked["status"] == parked["status"] and still_parked["cancel_requested"] is False
            rebound = str(call("attach", session_id=session)["attachment_id"])
            bound["attachment_id"] = rebound
            assert call("terminal_list", session_id=session)["terminals"][0]["phase"] == "running"
            assert call("mcp_state", session_id=session)["servers"][0]["phase"] == "ready"
            checks.append("leaving the SDK process kept the host, the parked request, the terminal, and the MCP service")

            closed = call("terminal_close", **bound, terminal_id=terminal)
            assert closed["phase"] == "exited" and closed["clean"] is True
            stopped = call("mcp_close", **bound, server_id=server)
            assert stopped["phase"] == "exited" and stopped["clean"] is True
            after = call("lookup", session_id=session, request_id=parked_id)
            assert after["status"] == parked["status"] and after["cancel_requested"] is False
            checks.append("an explicit close stopped that terminal and MCP service")
            assert alive(decoy.pid or -1)
            report["status"] = "passed"
    except BaseException as error:
        message = f"{type(error).__name__}: {error}"
        if token:
            message = message.replace(token, "[redacted]")
        report.update(status="failed", error=message)
        raise
    finally:
        report["budget"] = budget.snapshot()
        if decoy.poll() is None:
            decoy.kill()
            decoy.wait(timeout=5)
        pending = apply_cleanup(runtime, report)
        text = json.dumps(report, indent=2, ensure_ascii=False)
        if token:
            text = text.replace(token, "[redacted]")
        (root / "report.json").write_text(text + "\n")
        print(root / "report.json")
        raise_pending(pending)


if __name__ == "__main__":
    from workspace_lock import run_locked

    run_locked(main)
