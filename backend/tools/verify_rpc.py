"""Run coding-agent RPC mode against the local Python host."""

from __future__ import annotations

import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from resource_budget import ResourceBudget
from resource_census import apply_cleanup, raise_pending, release_named_slot
from verify_runtime import ROOT, Runtime

NODE = shutil.which("node") or "node"
CLI = ROOT / "packages/coding-agent/dist/bundle/cli.js"
SECRET = re.compile(r"(KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)", re.IGNORECASE)


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _env(agent: Path) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not SECRET.search(key)}
    env["AMAZME_CODING_AGENT_DIR"] = str(agent)
    for name in ("AMAZME_PYTHON_URL", "AMAZME_PYTHON_TOKEN", "AMAZME_PYTHON_SESSION", "AMAZME_PYTHON_BACKEND"):
        env.pop(name, None)
    return env


def _invoke(agent: Path, url: str, token: str, method: str, params: dict[str, object]) -> dict[str, object]:
    payload = json.dumps({"jsonrpc": "2.0", "id": method, "method": method, "params": params})
    proc = subprocess.run(
        [NODE, str(CLI), "--mode", "rpc", "--python-url", url, "--python-token", token, "--workspace", "primary"],
        cwd=ROOT, env=_env(agent), input=payload + "\n", capture_output=True, text=True, timeout=90, check=False)
    lines = [line for line in proc.stdout.splitlines() if line.startswith("{")]
    assert proc.returncode == 0 and lines, f"{proc.returncode}\n{proc.stderr[-800]}\n{proc.stdout[-400]}"
    loaded = json.loads(lines[-1])
    assert isinstance(loaded, dict)
    assert token not in proc.stdout and token not in proc.stderr
    return loaded


def _ok(body: dict[str, object]) -> dict[str, object]:
    assert "error" not in body, body.get("error")
    result = body["result"]
    assert isinstance(result, dict)
    return result


def _error(body: dict[str, object]) -> str:
    error = body["error"]
    assert isinstance(error, dict)
    return str(error.get("message"))


def _hid() -> str:
    return secrets.token_hex(16)


def main() -> None:
    assert CLI.is_file(), "build @amazme/coding-agent before this verifier"
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "rpc-", 2)
    root = Path(tempfile.mkdtemp(prefix="rpc-", dir=parent))
    provider = root / "provider.json"
    provider.write_text('{"provider":"faux"}')
    checks: list[str] = []
    report: dict[str, object] = {"status": "running", "execution": "rpc-source", "vm_created": False, "checks": checks}
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
            agent = root / "agent"
            bound = {"workspace": "primary"}

            def call(method: str, **params: object) -> dict[str, object]:
                return _ok(_invoke(agent, url, token, method, {**bound, **params}))

            def reject(method: str, code: str, **params: object) -> None:
                assert _error(_invoke(agent, url, token, method, {**bound, **params})) == code

            created = call("session.create", title="命令")
            session = str(created["session_id"])
            attached = call("session.attach", session_id=session)
            attachment = str(attached["attachment_id"])
            bound.update(session_id=session, attachment_id=attachment)
            shell = runtime.workspace / "rpc-shell.txt"
            request = _hid()
            submitted = call("request.submit", request_id=request, text="/shell printf y > rpc-shell.txt")
            assert submitted["status"] in {"queued", "waiting_approval"}
            receipt = submitted
            for _ in range(40):
                if receipt["status"] == "waiting_approval":
                    break
                time.sleep(0.05)
                receipt = call("request.lookup", request_id=request)
            assert receipt["status"] == "waiting_approval"
            assert not shell.exists()
            snapshot = call("session.snapshot")
            approvals = snapshot["approvals"]
            assert isinstance(approvals, list)
            pending = next(item for item in approvals if isinstance(item, dict) and item.get("request_id") == request and item.get("state") == "pending")
            pins = {
                "approval_id": pending["approval_id"], "expected_revision": pending["revision"],
                "proposal_digest": pending["proposal_digest"],
            }
            reject("approval.decide", "decision_required", decision_id=_hid(), **pins)
            assert not shell.exists()
            reject("approval.decide", "stale_approval", decision_id=_hid(), approve=True, **{**pins, "proposal_digest": "0" * 64})
            assert not shell.exists() and call("request.lookup", request_id=request)["status"] == "waiting_approval"
            denied = call("approval.decide", decision_id=_hid(), approve=False, **pins)
            for _ in range(40):
                if denied["status"] in {"failed", "succeeded"}:
                    break
                time.sleep(0.05)
                denied = call("request.lookup", request_id=request)
            assert denied["status"] == "failed" and denied["error"] == "approval_denied"
            assert not shell.exists()
            checks.append("RPC left the shell pending, ignored a missing or mismatched decision, and a refusal wrote nothing")

            request = _hid()
            approved = call("request.submit", request_id=request, text="/shell printf y > rpc-shell.txt")
            for _ in range(40):
                if approved["status"] == "waiting_approval":
                    break
                time.sleep(0.05)
                approved = call("request.lookup", request_id=request)
            assert approved["status"] == "waiting_approval"
            snapshot = call("session.snapshot")
            approvals = snapshot["approvals"]
            assert isinstance(approvals, list)
            pending = next(item for item in approvals if isinstance(item, dict) and item.get("request_id") == request and item.get("state") == "pending")
            granted = call(
                "approval.decide", decision_id=_hid(), approve=True, approval_id=pending["approval_id"],
                expected_revision=pending["revision"], proposal_digest=pending["proposal_digest"])
            for _ in range(40):
                if granted["status"] == "succeeded":
                    break
                time.sleep(0.05)
                granted = call("request.lookup", request_id=request)
            assert granted["status"] == "succeeded" and shell.read_text() == "y"
            assert call("file.read", path="rpc-shell.txt")["content"] == "y"
            saved = call("checkpoint.create", checkpoint_id=_hid(), path="rpc-shell.txt")
            assert len(str(saved["digest"])) == 64
            checks.append("an explicit approval wrote the file once, and the same binding read it and saved a checkpoint")

            terminal = _hid()
            opened = call("terminal.open", terminal_id=terminal, command="sh", cols=80, rows=24)
            assert opened["phase"] == "running"
            typed = call("terminal.write", terminal_id=terminal, input_id=_hid(), data="printf x > rpc-term.txt; printf 'RPC_TERM_OK\\n'\n")
            assert typed["input_status"] == "accepted"
            view = typed
            for _ in range(40):
                if "RPC_TERM_OK" in str(view.get("output")):
                    break
                time.sleep(0.05)
                view = call("terminal.read", terminal_id=terminal)
            assert "RPC_TERM_OK" in str(view["output"])
            assert (runtime.workspace / "rpc-term.txt").read_text() == "x"
            resized = call("terminal.resize", terminal_id=terminal, cols=100, rows=40)
            assert resized["cols"] == 100 and resized["rows"] == 40
            call("terminal.write", terminal_id=terminal, input_id=_hid(), data="stty size\n")
            sized = view
            for _ in range(40):
                if "40 100" in str(sized.get("output")):
                    break
                time.sleep(0.05)
                sized = call("terminal.read", terminal_id=terminal)
            assert "40 100" in str(sized["output"])
            checks.append("terminal input was accepted, then resize was visible, without claiming command success")

            command = shlex.join([
                str(ROOT / "backend/.venv/bin/python"), str(ROOT / "backend/tools/mcp_probe_server.py"),
                "--workspace", str(runtime.workspace)])
            server = _hid()
            connected = call("mcp.open", server_id=server, command=command)
            assert connected["phase"] == "ready"
            waiting = call("mcp.call", server_id=server, call_id=_hid(), name="native_echo", arguments={"text": "denied", "numbers": [1]})
            assert waiting["phase"] == "waiting_approval"
            assert not (runtime.workspace / "mcp-effect.txt").exists()
            reject("mcp.decide", "decision_required", server_id=server, call_id=waiting["call_id"], digest=waiting["digest"])
            reject("mcp.decide", "mcp_call_conflict", server_id=server, call_id=waiting["call_id"], decision_id=_hid(), approve=False, digest="0" * 64)
            assert not (runtime.workspace / "mcp-effect.txt").exists()
            refused = call("mcp.decide", server_id=server, call_id=waiting["call_id"], decision_id=_hid(), approve=False, digest=waiting["digest"])
            assert refused["phase"] == "denied"
            accepted = call(
                "mcp.call", server_id=server, call_id=_hid(), name="native_echo", arguments={"text": "x", "numbers": [2, 3]})
            assert accepted["phase"] == "waiting_approval"
            finished = call(
                "mcp.decide", server_id=server, call_id=accepted["call_id"], decision_id=_hid(),
                approve=True, digest=accepted["digest"])
            for _ in range(40):
                if finished["phase"] in {"done", "denied", "unknown", "conflict"}:
                    break
                time.sleep(0.05)
                state = call("mcp.state")
                calls = state["calls"]
                assert isinstance(calls, list)
                finished = next(item for item in calls if isinstance(item, dict) and item.get("call_id") == accepted["call_id"])
            assert finished["phase"] == "done"
            assert (runtime.workspace / "mcp-effect.txt").read_text() == "x"
            checks.append("MCP stayed pending until an explicit decision, a refusal had no effect, and one approval wrote once")

            other = call("session.create", title="另一个")
            other_id = str(other["session_id"])
            assert other_id != session
            other_attachment = str(call("session.attach", session_id=other_id)["attachment_id"])
            foreign = call("terminal.list", session_id=other_id, attachment_id=other_attachment)
            assert foreign["terminals"] == []
            owned = call("terminal.list")
            terminals = owned["terminals"]
            assert isinstance(terminals, list) and len(terminals) == 1 and terminals[0]["phase"] == "running"
            servers = call("mcp.state")["servers"]
            assert isinstance(servers, list) and len(servers) == 1 and servers[0]["phase"] == "ready"
            checks.append("another RPC session stayed separate and did not stop the first terminal or MCP service")

            parked_id = "ab" * 16
            parked = call("request.submit", request_id=parked_id, text="仍在", not_before_ms=int(time.time() * 1000) + 3_600_000)
            assert parked["status"] in {"queued", "waiting_time"} and parked["cancel_requested"] is False
            released = _ok(_invoke(agent, url, token, "session.release", {"session_id": session, "attachment_id": attachment}))
            assert released == {"detached": True, "cancelled": False}
            rebound = str(call("session.attach", session_id=session)["attachment_id"])
            bound["attachment_id"] = rebound
            still = call("request.lookup", request_id=parked_id)
            assert still["status"] == parked["status"] and still["cancel_requested"] is False
            assert call("terminal.list")["terminals"][0]["phase"] == "running"
            assert call("mcp.state")["servers"][0]["phase"] == "ready"
            checks.append("releasing the RPC binding kept the host, the parked request, the terminal, and the MCP service")

            closed = call("terminal.close", terminal_id=terminal)
            assert closed["phase"] == "exited" and closed["clean"] is True
            stopped = call("mcp.close", server_id=server)
            assert stopped["phase"] == "exited" and stopped["clean"] is True
            after = call("request.lookup", request_id=parked_id)
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
    main()
