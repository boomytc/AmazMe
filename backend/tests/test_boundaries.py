import ast
import base64
import json
import shlex
import stat
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
    permitted = {"host.py", "supervisor.py", "vm.py", "gate.py"}
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
    payload = shlex.split(command.command)[-1]
    assert json.loads(base64.b64decode(payload))["content"] == content
