import ast
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from native_file_fixture import run_file

from amazme_backend.common import unix_listener
from amazme_backend.contracts import RunTool, Stream, ToolCall, WriteFile
from amazme_backend.native_execution import LocalPermit

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("tool", ["verify_p2.py", "measure_runtime.py", "verify_relocated_bundle.py"])
def test_retired_vm_verifiers_refuse_before_creating_resources(tool, tmp_path):
    result = subprocess.run([sys.executable, str(ROOT / "tools" / tool), "--help"],
                            cwd=tmp_path, capture_output=True, text=True, timeout=10)
    assert result.returncode != 0
    assert "retired" in result.stderr.lower()
    assert not list(tmp_path.iterdir())


def test_generated_event_contracts_do_not_drift():
    schema = Stream.model_json_schema()
    assert json.loads((ROOT / "contracts/events.schema.json").read_text()) == schema
    assert json.loads((ROOT / "src/amazme_backend/web/events.schema.json").read_text()) == schema


def test_business_modules_cannot_spawn_native_processes():
    # Only the registered native execution module and fixed service owners may spawn.
    permitted = {"host.py", "supervisor.py", "native_execution.py", "pty_gate.py", "mcp_gate.py", "codemode_run.py",
                 "plugin_run.py", "computer_run.py"}
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
    tool = RunTool(session_id="s", worker_id="w", execution_epoch=1, build_id="b", call_id="c",
                   command="write_file", file=value, expected_digest="")
    assert len(tool.model_dump_json().encode()) < 262144
    permit = LocalPermit(call_id="c", cwd="/local/project", command="write_file", file=value,
                         expected_digest="", timeout_seconds=30)
    assert len(permit.model_dump_json().encode()) < 262144
    assert LocalPermit.model_validate_json(permit.model_dump_json()).file == value


def _run_file_tool(root: Path, call: ToolCall) -> subprocess.CompletedProcess[str]:
    import hashlib
    path = root / json.loads(call.arguments)["path"]
    digest = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else ""
    return run_file(root, call, digest)


def test_local_file_tool_does_not_follow_links_out_of_the_workspace(tmp_path: Path) -> None:
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
