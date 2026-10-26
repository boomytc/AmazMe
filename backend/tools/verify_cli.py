"""Run the coding-agent print CLI against the local Python host."""

from __future__ import annotations

import json
import os
import re
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
    env["AMAZME_PYTHON_BACKEND"] = str(ROOT / "backend/.venv/bin/amazme-backend")
    return env


def _cli(agent: Path, url: str, token: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [NODE, str(CLI), "--python-url", url, "--python-token", token, "--workspace", "primary", *args],
        cwd=ROOT, env=_env(agent), input="", capture_output=True, text=True, timeout=90, check=False)


def _expect(proc: subprocess.CompletedProcess[str], code: int) -> subprocess.CompletedProcess[str]:
    assert proc.returncode == code, f"{proc.returncode}\n{proc.stderr[-1200:]}\n{proc.stdout[-600:]}"
    return proc


def _json_line(proc: subprocess.CompletedProcess[str]) -> dict[str, object]:
    lines = [line for line in proc.stdout.splitlines() if line.startswith("{")]
    assert lines, proc.stderr or proc.stdout
    loaded = json.loads(lines[-1])
    assert isinstance(loaded, dict)
    return loaded


def main() -> None:
    assert CLI.is_file(), "build @amazme/coding-agent before this verifier"
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "cli-", 2)
    root = Path(tempfile.mkdtemp(prefix="cli-", dir=parent))
    provider = root / "provider.json"
    provider.write_text('{"provider":"faux"}')
    checks: list[str] = []
    report: dict[str, object] = {"status": "running", "execution": "cli-source", "vm_created": False, "checks": checks}
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

            printed = _expect(_cli(agent, url, token, "--print", "CLI_TEXT_PROBE"), 0)
            assert "已收到：CLI_TEXT_PROBE" in printed.stdout and token not in printed.stdout
            assert token not in printed.stderr
            checks.append("text print mode completed a faux model request through the same Python Host")

            refused = _expect(_cli(agent, url, token, "--decision", "不要", "/shell printf y > cli-shell.txt"), 1)
            assert "invalid_decision" in refused.stderr
            conflict = _expect(_cli(
                agent, url, token, "--decision", "拒绝", "--request", "ab" * 16, "--call", "cd" * 16), 1)
            assert "decision_target_conflict" in conflict.stderr
            assert token not in refused.stdout and token not in refused.stderr
            checks.append("a decision aimed at both a request and a call was refused before any call")
            assert not (runtime.workspace / "cli-shell.txt").exists()
            checks.append("a decision other than the two exact words was refused before any call")

            waiting = _expect(_cli(agent, url, token, "--mode", "json", "/shell printf y > cli-shell.txt"), 2)
            body = _json_line(waiting)
            assert body["status"] == "waiting_approval"
            assert "printf y > cli-shell.txt" in str(body["summary"])
            assert not (runtime.workspace / "cli-shell.txt").exists()
            session = str(body["session_id"])
            request = str(body["request_id"])
            checks.append("print mode left a shell approval pending and wrote no file")

            denied = _expect(_cli(agent, url, token, "--mode", "json", "--python-session", session, "--decision", "拒绝", "--request", request, "--approval-id", str(body["approval_id"])), 1)
            denied_body = _json_line(denied)
            assert denied_body["status"] == "failed" and denied_body["error"] == "approval_denied"
            assert not (runtime.workspace / "cli-shell.txt").exists()
            checks.append("a later explicit refusal finished the same request with no side effect")

            approved = _expect(_cli(agent, url, token, "--mode", "json", "--decision", "批准", "/shell printf y > cli-shell.txt"), 0)
            approved_body = _json_line(approved)
            assert approved_body["status"] == "succeeded"
            assert (runtime.workspace / "cli-shell.txt").read_text() == "y"
            session = str(approved_body["session_id"])
            checks.append("an explicit approval in the same print run wrote the file once")

            read = _expect(_cli(agent, url, token, "--mode", "json", "--python-session", session, "/file cli-shell.txt"), 0)
            assert _json_line(read)["content"] == "y"
            saved = _expect(_cli(agent, url, token, "--mode", "json", "--python-session", session, "/checkpoint cli-shell.txt"), 0)
            assert len(str(_json_line(saved)["digest"])) == 64
            checks.append("the same session read the file and saved a checkpoint")

            opened = _expect(_cli(
                agent, url, token, "--mode", "json", "--python-session", session,
                "/pty printf x > cli-term.txt; printf 'CLI_TERM_OK\\n'"), 0)
            terminal = _json_line(opened)
            assert terminal["status"] == "accepted" and "CLI_TERM_OK" in str(terminal["output"])
            assert (runtime.workspace / "cli-term.txt").read_text() == "x"
            _expect(_cli(agent, url, token, "--mode", "json", "--python-session", session, "/pty-size 100 40"), 0)
            size = _expect(_cli(agent, url, token, "--mode", "json", "--python-session", session, "/pty stty size"), 0)
            assert "40 100" in str(_json_line(size)["output"])
            checks.append("terminal input was accepted, then resize was visible, without claiming command success")

            command = shlex.join([
                str(ROOT / "backend/.venv/bin/python"), str(ROOT / "backend/tools/mcp_probe_server.py"),
                "--workspace", str(runtime.workspace)])
            connected = _expect(_cli(agent, url, token, "--mode", "json", "--python-session", session, "/mcp " + command), 0)
            assert _json_line(connected)["status"] == "ready"
            pending = _expect(_cli(
                agent, url, token, "--mode", "json", "--python-session", session,
                '/mcp-call native_echo {"text":"denied","numbers":[1]}'), 2)
            pending_body = _json_line(pending)
            assert pending_body["status"] == "waiting_approval"
            assert not (runtime.workspace / "mcp-effect.txt").exists()
            refused_call = _expect(_cli(
                agent, url, token, "--mode", "json", "--python-session", session,
                "--decision", "拒绝", "--call", str(pending_body["call_id"])), 1)
            assert _json_line(refused_call)["status"] == "denied"
            assert not (runtime.workspace / "mcp-effect.txt").exists()
            accepted = _expect(_cli(
                agent, url, token, "--mode", "json", "--python-session", session, "--decision", "批准",
                '/mcp-call native_echo {"text":"x","numbers":[2,3]}'), 0)
            assert _json_line(accepted)["status"] == "done"
            assert (runtime.workspace / "mcp-effect.txt").read_text() == "x"
            checks.append("MCP stayed pending without a decision, a refusal had no effect, and one approval wrote once")

            other = _expect(_cli(agent, url, token, "--mode", "json", "你好"), 0)
            assert str(_json_line(other)["session_id"]) != session
            terminals = runtime.client.get(f"/api/v1/sessions/{session}/terminals").json()["terminals"]
            servers = runtime.client.get(f"/api/v1/sessions/{session}/mcp").json()["servers"]
            assert len(terminals) == 1 and terminals[0]["phase"] == "running"
            assert len(servers) == 1 and servers[0]["phase"] == "ready"
            checks.append("another CLI session stayed separate and did not stop the first terminal or MCP service")

            request_id = "ab" * 16
            parked = runtime.client.post(
                f"/api/v1/sessions/{session}/submissions", headers=runtime.attach(session),
                json={"request_id": request_id, "text": "仍在", "not_before_ms": int(time.time() * 1000) + 3_600_000}).json()
            assert parked["status"] == "waiting_time" and parked["cancel_requested"] is False
            _expect(_cli(agent, url, token, "--mode", "json", "--python-session", session, "/file cli-shell.txt"), 0)
            still = runtime.client.get(f"/api/v1/sessions/{session}/requests/{request_id}").json()
            assert still["status"] == "waiting_time" and still["cancel_requested"] is False
            checks.append("leaving the CLI kept the host, the parked request, the terminal, and the MCP service")

            closed = _expect(_cli(agent, url, token, "--mode", "json", "--python-session", session, "/pty-close"), 0)
            assert _json_line(closed)["status"] == "exited" and _json_line(closed)["clean"] is True
            stopped = _expect(_cli(agent, url, token, "--mode", "json", "--python-session", session, "/mcp-close"), 0)
            assert _json_line(stopped)["status"] == "exited" and _json_line(stopped)["clean"] is True
            after = runtime.client.get(f"/api/v1/sessions/{session}/requests/{request_id}").json()
            assert after["status"] == "waiting_time" and after["cancel_requested"] is False
            checks.append("rejoining the same session explicitly stopped that terminal and MCP service")
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
