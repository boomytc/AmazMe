import ast
import base64
import json
import os
import shlex
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from amazme_backend.common import unix_listener
from amazme_backend.contracts import RunTool, Stream, ToolCall, WriteFile
from amazme_backend.worker import command_for

ROOT = Path(__file__).resolve().parents[1]


def test_generated_event_contracts_do_not_drift():
    schema = Stream.model_json_schema()
    assert json.loads((ROOT / "contracts/events.schema.json").read_text()) == schema
    assert json.loads((ROOT / "src/amazme_backend/web/events.schema.json").read_text()) == schema


def test_business_modules_cannot_spawn_native_processes():
    # gate.py and pty_gate.py run as container PID 1. Other business modules must not fork or exec.
    permitted = {"host.py", "supervisor.py", "vm.py", "gate.py", "pty_gate.py", "mcp_gate.py"}
    for path in (ROOT / "src/amazme_backend").glob("*.py"):
        if path.name in permitted:
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                assert all(alias.name != "subprocess" for alias in node.names), path
            if isinstance(node, ast.Call):
                name = node.func.attr if isinstance(node.func, ast.Attribute) else ""
                assert name not in {"create_subprocess_exec", "create_subprocess_shell", "system", "fork", "popen", "execve"}, path


def test_private_listener_is_owner_only(tmp_path):
    # Keep this separate from umask: the server must not broaden inherited socket permissions.
    import tempfile
    with tempfile.TemporaryDirectory(prefix="am-ipc-", dir="/tmp") as directory:
        path = Path(directory) / "private.sock"
        listener = unix_listener(path)
        try:
            assert stat.S_IMODE(path.stat().st_mode) == 0o600
        finally:
            listener.close()


@pytest.mark.parametrize("content", ["\U0001f600" * 32000, ("'\n" * 16000)])
def test_maximum_file_content_fits_all_transport_and_gate_boundaries(content):
    value = WriteFile(path="\U0001f600" * 1024, content=content)
    command = command_for(ToolCall(id="call", name="write_file", arguments=value.model_dump_json()))
    tool = RunTool(session_id="s", worker_id="w", execution_epoch=1, build_id="b", call_id="c", **command.model_dump())
    assert len(tool.model_dump_json().encode()) < 262144
    assert len(json.dumps({"command": tool.command, "uid": 501, "gid": 20}).encode()) < 262144
    tokens = shlex.split(command.command)
    assert tokens[-1] == "/workspace"
    assert json.loads(base64.b64decode(tokens[-2]))["content"] == content


def _run_file_tool(root: Path, call: ToolCall) -> subprocess.CompletedProcess[str]:
    tokens = shlex.split(command_for(call).command)
    return subprocess.run([sys.executable, "-I", "-c", tokens[3], tokens[4], str(root)],
                          capture_output=True, text=True, check=False)


def test_guest_file_tool_does_not_follow_links_out_of_the_workspace(tmp_path: Path) -> None:
    root = tmp_path / "work"
    root.mkdir()
    (root / "note.txt").write_text("alpha\n")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret")
    (root / "escape").symlink_to(outside / "secret.txt")
    escaped = _run_file_tool(root, ToolCall(id="read", name="read_file", arguments='{"path":"escape"}'))
    assert escaped.returncode != 0 and "workspace_path_escape" in escaped.stderr
    assert (outside / "secret.txt").read_text() == "secret"
    read = _run_file_tool(root, ToolCall(id="read", name="read_file", arguments='{"path":"note.txt"}'))
    assert read.returncode == 0 and "alpha" in read.stdout
    (root / "via").symlink_to(root, target_is_directory=True)
    linked = _run_file_tool(root, ToolCall(
        id="write", name="write_file", arguments='{"path":"via/child.txt","content":"no"}'))
    assert linked.returncode != 0 and "workspace_symlink" in linked.stderr
    assert not (root / "child.txt").exists()
    os.link(root / "note.txt", root / "linked.txt")
    hard = _run_file_tool(root, ToolCall(
        id="write", name="write_file", arguments='{"path":"note.txt","content":"beta\\n"}'))
    assert hard.returncode != 0 and "workspace_hardlink" in hard.stderr
    assert (root / "note.txt").read_text() == "alpha\n"
    (root / "linked.txt").unlink()
    saved = _run_file_tool(root, ToolCall(
        id="write", name="write_file", arguments='{"path":"note.txt","content":"beta\\n"}'))
    assert saved.returncode == 0 and (root / "note.txt").read_text() == "beta\n"


def test_fixed_native_owners_cannot_reexec_or_unlock_lifetime_descriptors():
    forbidden = {"fork", "forkpty", "execv", "execve", "execl", "execvp", "execvpe", "posix_spawn", "posix_spawnp"}
    for path in (ROOT / "src/amazme_backend").glob("*.py"):
        if path.name in {"gate.py", "pty_gate.py", "mcp_gate.py"}:
            continue
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = node.func.attr if isinstance(node.func, ast.Attribute) else ""
                assert name not in forbidden, (path, name)
            if isinstance(node, ast.Attribute):
                assert node.attr != "LOCK_UN", path
        if path.name == "processes.py":
            retain = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "retain_inherited")
            for node in ast.walk(retain):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                    assert node.func.attr not in {"close", "fdopen", "dup2", "closerange", "close_range"}
