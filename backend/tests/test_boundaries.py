import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from native_file_fixture import run_file

from amazme_backend.platform.ipc import unix_listener
from amazme_backend.contracts import RunTool, Stream, ToolCall, WriteFile
from amazme_backend.execution.native import LocalPermit

ROOT = Path(__file__).resolve().parents[1]


def test_generated_event_contracts_do_not_drift():
    schema = Stream.model_json_schema()
    assert json.loads((ROOT / "contracts/events.schema.json").read_text()) == schema
    assert json.loads((ROOT / "src/amazme_backend/assets/web/events.schema.json").read_text()) == schema


@pytest.mark.parametrize("module", ["amazme_backend.sdk", "amazme_backend.contracts", "amazme_backend.plugin_api"])
def test_public_imports_do_not_load_services_or_access_business_resources(module):
    result = subprocess.run([sys.executable, "-B", str(ROOT / "tools/verify_imports.py"), "--probe", module],
                            text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["business_operations"] == []


def test_public_import_probe_rejects_io_even_when_importer_catches_the_audit_error(tmp_path):
    package = tmp_path / "amazme_backend"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "sdk.py").write_text(
        'try:\n    open("/tmp/amazme-forbidden-import.json")\nexcept RuntimeError:\n    pass\n')
    code = ('import runpy,sys; sys.path.insert(0,sys.argv[1]); '
            'runpy.run_path(sys.argv[2],run_name="probe_module")["probe"]("amazme_backend.sdk")')
    result = subprocess.run([sys.executable, "-B", "-c", code, str(tmp_path), str(ROOT / "tools/verify_imports.py")],
                            capture_output=True, text=True)
    assert result.returncode != 0
    assert "public import attempted forbidden business I/O" in result.stderr


def test_backend_obeys_recursive_architecture_and_process_rules():
    result = subprocess.run([sys.executable, str(ROOT / "tools/check_architecture.py")],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr


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




def test_public_contract_declarations_remain_available_by_name():
    from amazme_backend import contracts
    from amazme_backend.contracts.plugins import PluginReply

    expected = json.loads((ROOT / "contracts/public-exports.json").read_text())["exports"]
    assert expected
    assert [name for name in expected if not hasattr(contracts, name)] == []
    assert contracts.PluginReply is PluginReply
