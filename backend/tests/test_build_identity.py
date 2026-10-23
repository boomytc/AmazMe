"""Source and package identity include the helper and plugin bytes."""

import importlib.util
from pathlib import Path

from amazme_backend.common import source_identity_files

TOOL = Path(__file__).resolve().parents[1] / "tools" / "package_backend.py"


def load_packager() -> object:
    spec = importlib.util.spec_from_file_location("package_backend", TOOL)
    if spec is None or spec.loader is None:
        raise RuntimeError("package_backend could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_source_identity_includes_helper_and_plugin_bytes() -> None:
    names = {path.name for path in source_identity_files()}
    assert {"codemode_helper.mjs", "plugin_gate.py", "mcp_gate.py"} <= names


def test_package_identity_requires_node_helper_plugin_and_vm_tools() -> None:
    module = load_packager()
    missing_identity = getattr(module, "missing_identity")
    required = getattr(module, "REQUIRED_IDENTITY")
    assert "resources/node/bin/node" in missing_identity({})
    assert missing_identity({name: "abc" for name in required}) == []
    nested = {
        "_internal/amazme_backend/codemode_helper.mjs": "abc",
        "_internal/amazme_backend/plugin_gate.py": "abc",
        "_internal/amazme_backend/node_modules/quickjs-wasi/quickjs.wasm": "abc",
        "resources/node/bin/node": "abc",
        "resources/docker": "abc",
        "resources/lima/bin/limactl": "abc",
    }
    assert missing_identity(nested) == []
