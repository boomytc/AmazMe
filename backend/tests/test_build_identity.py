"""Source and package identity include the helper and plugin bytes."""

import importlib.util
import json
from pathlib import Path

import pytest

from amazme_backend.platform.identity import frozen_identity, rewrite_frozen_manifest, source_identity_files
from amazme_backend.contracts import BackendError

TOOL = Path(__file__).resolve().parents[1] / "tools" / "package_backend.py"


def load_packager() -> object:
    spec = importlib.util.spec_from_file_location("package_backend", TOOL)
    if spec is None or spec.loader is None:
        raise RuntimeError("package_backend could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_source_identity_includes_helper_and_plugin_bytes() -> None:
    root = Path(__file__).parents[1] / "src/amazme_backend"
    names = {path.relative_to(root).as_posix() for path in source_identity_files() if path.is_relative_to(root)}
    assert {"execution/codemode/helper.mjs", "execution/plugins/gate.py", "execution/mcp/gate.py",
            "assets/model_catalog.json", "platform/resources.py", "sdk/client.py"} <= names


def test_package_identity_requires_helpers_without_vm_tools() -> None:
    module = load_packager()
    missing_identity = getattr(module, "missing_identity")
    required = getattr(module, "REQUIRED_IDENTITY")
    assert "runtime/node/bin/node" in missing_identity({})
    assert not any("lima" in name or "docker" in name for name in required)
    assert missing_identity({name: "abc" for name in required}) == []
    nested = {
        "_internal/amazme_backend/execution/codemode/helper.mjs": "abc",
        "_internal/amazme_backend/execution/plugins/gate.py": "abc",
        "_internal/amazme_backend/execution/pty/gate.py": "abc",
        "_internal/amazme_backend/execution/mcp/gate.py": "abc",
        "_internal/amazme_backend/execution/remote/daemon.py": "abc",
        "_internal/amazme_backend/assets/model_catalog.json": "abc",
        "_internal/amazme_backend/assets/classifier_catalog.json": "abc",
        "_internal/amazme_backend/assets/web/events.schema.json": "abc",
        "_internal/amazme_backend/assets/web/xterm-terminal.js": "abc",
        "_internal/amazme_backend/assets/web/xterm.css": "abc",
        "_internal/amazme_backend/assets/web/client/index.html": "abc",
        "_internal/amazme_backend/assets/web/client/page.js": "abc",
        "_internal/amazme_backend/execution/codemode/node_modules/quickjs-wasi/quickjs.wasm": "abc",
        "runtime/node/bin/node": "abc",
        "_internal/amazme_backend/execution/codemode/node_modules/@amazme/codemode/dist/index.js": "abc",
    }
    assert missing_identity(nested) == []


def test_rewritten_manifest_matches_bytes_changed_by_signing(tmp_path: Path) -> None:
    root = tmp_path / "AmazMe Python 0.1.0"
    binary = root / "_internal" / "Python"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"unsigned")
    (root / "build.json").write_text(json.dumps({
        "version": "0.1.0", "nonce": "ab", "files": {"_internal/Python": "0" * 64}, "build_id": "0" * 64,
    }))
    first = rewrite_frozen_manifest(root)
    assert frozen_identity(root) == first
    binary.write_bytes(b"signed")
    with pytest.raises(BackendError) as caught:
        frozen_identity(root)
    assert caught.value.code == "build_resource_mismatch"
    assert caught.value.message == "_internal/Python"
    second = rewrite_frozen_manifest(root)
    assert second != first
    assert frozen_identity(root) == second
    saved = json.loads((root / "build.json").read_text())
    assert saved["nonce"] == "ab"
    assert saved["version"] == "0.1.0"
