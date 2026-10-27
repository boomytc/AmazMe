"""The two backend builds must not read mutable workspace frontend assets."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
import verify_desktop_restart  # noqa: E402


def test_copied_build_assets_are_isolated_from_workspace(tmp_path, monkeypatch):
    source = tmp_path / "source"
    for name, value in {
        "backend/src/amazme_backend/platform/identity.py": "# identity\n",
        "backend/uv.lock": "lock\n",
        "packages/codemode/package.json": "{}\n",
        "packages/codemode/dist/index.js": "old sandbox\n",
        "packages/web/dist/page/index.html": "old page\n",
    }.items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
    monkeypatch.setattr(verify_desktop_restart, "ROOT", source)
    sandbox = tmp_path / "verification"
    sandbox.mkdir()
    verify_desktop_restart.prepare_builds(sandbox, None, None)
    (source / "packages/web/dist/page/index.html").write_text("changed page\n")
    (source / "packages/codemode/dist/index.js").write_text("changed sandbox\n")
    for build in ("previous", "candidate"):
        root = sandbox / build / "packages"
        assert not root.is_symlink()
        assert (root / "web/dist/page/index.html").read_text() == "old page\n"
        assert (root / "codemode/dist/index.js").read_text() == "old sandbox\n"


def test_snapshot_allows_an_unbuilt_codemode_package(tmp_path, monkeypatch):
    source = tmp_path / "source"
    for name in ("backend/src/amazme_backend/platform/identity.py", "backend/uv.lock",
                 "packages/codemode/package.json", "packages/web/dist/page/index.html"):
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture")
    monkeypatch.setattr(verify_desktop_restart, "ROOT", source)
    sandbox = tmp_path / "verification"
    sandbox.mkdir()
    verify_desktop_restart.prepare_builds(sandbox, None, None)
    assert (sandbox / "candidate/packages/codemode/package.json").is_file()
    assert not (sandbox / "candidate/packages/codemode/dist").exists()
