"""Native MCP wire behavior; all service processes are explicitly owned."""

import contextlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

from amazme_backend.execution.mcp.client import McpClient
from amazme_backend.execution.processes import ProcessReservation
from amazme_backend.platform.ipc import child_command

ECHO = """
import json, sys
marker = sys.argv[1]
def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"demo","version":"0"}}})
    elif method == "tools/list":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"tools":[{"name":"echo","description":"回声","inputSchema":{"type":"object"}}]}})
    elif method == "tools/call":
        text = msg["params"]["arguments"].get("text", "")
        open(marker, "a").write(text)
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"content":[{"type":"text","text":text}]}})
"""
HOLDER = """
import json, os, sys, time
late = sys.argv[1]
def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"hold","version":"0"}}})
    elif method == "tools/list":
        if os.fork() == 0:
            time.sleep(1)
            open(late, "w").write("late")
            os._exit(0)
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"tools":[{"name":"hold","description":"等待","inputSchema":{"type":"object"}}]}})
"""


@contextlib.contextmanager
def running(command: str):
    root = Path(tempfile.mkdtemp(prefix="amazme-mcp-test-"))
    gate, peer = socket.socketpair()
    with ProcessReservation(root, "execution", "mcp-test") as reservation:
        process = subprocess.Popen(child_command("service-runner", "--kind", "mcp", "--profile", str(root),
            "--instance", "mcp-test", "--lifetime-fd", str(reservation.fd), "--directory", str(root)),
            stdin=gate.fileno(), stdout=gate.fileno(), stderr=subprocess.PIPE, pass_fds=(reservation.fd,))
    gate.close()
    client = McpClient(peer)
    try:
        client.permit(command, os.getuid(), os.getgid(), str(root))
        yield process, client, root
    finally:
        peer.close()
        process.wait(timeout=8)
        report = json.loads((root / "result.json").read_text())
        assert report["stopped"]
        shutil.rmtree(root)


def test_call_hits_the_server_once_and_conflict_does_not(tmp_path: Path) -> None:
    script = tmp_path / "echo_server.py"
    script.write_text(ECHO)
    marker = tmp_path / "calls.txt"
    with running(f"/usr/bin/python3 {script} {marker}") as (_process, mcp, _root):
        assert mcp.tools[0].name == "echo" and mcp.tools[0].input_schema == {"type":"object"}
        assert not marker.exists()
        mcp.call("call-1", "echo", {"text": "hi"})
        mcp.pump(2, lambda: "call-1" in mcp.results)
        assert mcp.results["call-1"].text == "hi"
        assert marker.read_text() == "hi"
        mcp.call("call-1", "echo", {"text": "hi"})
        mcp.pump(0.3)
        assert marker.read_text() == "hi"
        mcp.call("call-1", "echo", {"text": "no"})
        mcp.pump(0.5, lambda: "call-1" in mcp.conflicts)
        assert "call-1" in mcp.conflicts and marker.read_text() == "hi"
        assert mcp.exit_code is None


def test_cancel_waits_for_native_server_and_tracked_descendants(tmp_path: Path) -> None:
    script = tmp_path / "hold_server.py"
    script.write_text(HOLDER)
    late = tmp_path / "late.txt"
    with running(f"/usr/bin/python3 {script} {late}") as (process, mcp, root):
        assert any(item.name == "hold" for item in mcp.tools)
        for _ in range(30):
            if len(json.loads((root / "tracked.json").read_text())) >= 3:
                break
            time.sleep(.01)
        assert len(json.loads((root / "tracked.json").read_text())) >= 3
        mcp.cancel()
        assert mcp.exit_code == 0  # Closing stdin lets this server exit normally.
        process.wait(timeout=5)
        time.sleep(1.1)
        assert not late.exists()


SLOW = """
import json, sys
marker = sys.argv[1]
def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"slow","version":"0"}}})
    elif method == "tools/list":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"tools":[{"name":"slow","description":"慢","inputSchema":{"type":"object"}}]}})
    elif method == "tools/call":
        open(marker, "a").write("called")
    elif method == "notifications/cancelled":
        open(marker, "a").write(" cancelled")
"""


def test_cancel_call_does_not_stop_the_service(tmp_path: Path) -> None:
    script = tmp_path / "slow_server.py"
    script.write_text(SLOW)
    marker = tmp_path / "calls.txt"
    with running(f"/usr/bin/python3 {script} {marker}") as (process, mcp, _root):
        mcp.call("call-1", "slow", {})
        for _ in range(50):
            if marker.exists() and "called" in marker.read_text():
                break
            time.sleep(0.05)
        assert marker.read_text() == "called"
        mcp.cancel_call("call-1")
        for _ in range(50):
            if "cancelled" in marker.read_text():
                break
            time.sleep(0.05)
        assert marker.read_text() == "called cancelled"
        assert process.poll() is None and mcp.exit_code is None
        mcp.cancel()


def test_socket_loss_does_not_emit_an_exit(tmp_path: Path) -> None:
    script = tmp_path / "hold_server.py"
    script.write_text(HOLDER)
    with running(f"/usr/bin/python3 {script} {tmp_path / 'unused.txt'}") as (process, mcp, _root):
        mcp.sock.close()
        process.wait(timeout=5)
        assert mcp.exit_code is None
