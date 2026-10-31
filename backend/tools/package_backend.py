"""Build an immutable onedir with its interpreter, required helpers and Web client."""

import argparse
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from amazme_backend.platform.resource_manifest import (
    CLIENT_DIRECTORY,
    CLIENT_REQUIRED_FILES,
    NODE_MODULES_DIRECTORY,
    REQUIRED_IDENTITY,
    RESOURCE_PATHS,
)

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
OFFICIAL_NODE = Path.home() / "Library/Caches/amazme-release/node-v22.23.3-darwin-arm64/bin/node"


def official_node() -> Path:
    chosen = Path(os.environ["AMAZME_NODE"]) if os.environ.get("AMAZME_NODE") else OFFICIAL_NODE
    if not chosen.is_file():
        raise SystemExit("official Node binary is missing")
    linked = subprocess.check_output(["/usr/bin/otool", "-L", str(chosen)], text=True)
    borrowed = [
        line.strip().split(" (", 1)[0]
        for line in linked.splitlines()[1:]
        if line.strip() and not line.strip().startswith(("/System/", "/usr/lib/", "@"))
    ]
    if borrowed:
        raise SystemExit("Node binary is not self-contained")
    return chosen


def missing_identity(files: dict[str, str]) -> list[str]:
    missing: list[str] = []
    for name in REQUIRED_IDENTITY:
        if not any(path == name or path.endswith("/" + name) for path in files):
            missing.append(name)
    return missing


def install_codemode_runtime(bundle: Path) -> None:
    node_dest = bundle / "runtime" / "node" / "bin" / "node"
    node_dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(official_node(), node_dest)
    node_dest.chmod(0o755)
    package_root = bundle / "_internal" / "amazme_backend"
    helper = package_root / RESOURCE_PATHS["codemode_helper"]
    plugin = package_root / RESOURCE_PATHS["plugin_gate"]
    if not helper.is_file() or not plugin.is_file():
        raise SystemExit("packaged helper or plugin gate is missing")
    modules = package_root / NODE_MODULES_DIRECTORY / "quickjs-wasi"
    shutil.copytree(REPO / "node_modules" / "quickjs-wasi", modules, symlinks=False)
    package = REPO / "packages/codemode"
    if not (package / "dist/index.js").is_file():
        raise SystemExit("build @amazme/codemode before packaging the backend")
    target = package_root / NODE_MODULES_DIRECTORY / "@amazme/codemode"
    target.mkdir(parents=True)
    shutil.copy2(package / "package.json", target / "package.json")
    shutil.copytree(package / "dist", target / "dist", symlinks=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, default=ROOT.parent / ".artifacts/native")
    args = parser.parse_args()
    parent = args.output_root.resolve()
    parent.mkdir(parents=True, exist_ok=True)
    from resource_budget import ResourceBudget, require_budget
    from resource_census import PACKAGE_SLOTS, admit, collect, live_processes, record, retire_unused_packages

    from amazme_backend.platform.private_files import lock

    official_node()  # Fail before allocating a build tree when the required helper is absent.
    lock_path = REPO / ".artifacts/native-package.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock(lock_path):
        roots = [REPO / ".artifacts", parent]
        before = collect(extra_artifact_roots=[parent])
        retired: list[str] = []
        try:
            retire_unused_packages(
                before, live_processes(), keep=PACKAGE_SLOTS - 1, roots=roots, removed=retired,
            )
            if retired:
                before = collect(extra_artifact_roots=[parent])
            admit(before, purpose="package")
            require_budget(roots, reserve_bytes=1024**3)
            with ResourceBudget(roots, deadline_seconds=600):
                build_once(parent)
        finally:
            after = collect(extra_artifact_roots=[parent])
            record(after, purpose="package", event="after", before=before, retired=retired)
            print(json.dumps({
                "event": "package_disk",
                "free_before": before["free_bytes"],
                "free_after": after["free_bytes"],
                "artifact_before": before["artifact_bytes"],
                "artifact_after": after["artifact_bytes"],
                "retired": retired,
                "scope": after["scope"],
                "reclaimed": after["reclaimed"],
            }))


def build_once(parent: Path) -> None:
    client = ROOT.parent / "packages/web/dist/page"
    missing_client = [name for name in CLIENT_REQUIRED_FILES if not (client / name).is_file()]
    if missing_client:
        raise SystemExit(
            "build @amazme/web before freezing the desktop backend; missing page resources: "
            + ", ".join(missing_client)
        )
    output = Path(tempfile.mkdtemp(prefix="package-", dir=parent))
    entry = output / "entrypoint.py"
    entry.write_text("from amazme_backend.__main__ import main\nmain()\n")
    with (output / "build.log").open("w") as log:
        subprocess.run([
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--name", "amazme-backend",
            "--distpath", str(output / "dist"), "--workpath", str(output / "build"), "--specpath", str(output),
            "--paths", str(ROOT / "src"),
            "--collect-submodules", "amazme_backend",
            "--add-data", str(client) + ":amazme_backend/" + CLIENT_DIRECTORY,
            *[
                item
                for name in RESOURCE_PATHS.values()
                for item in ("--add-data", f"{ROOT / 'src/amazme_backend' / name}:amazme_backend/{Path(name).parent if Path(name).suffix else name}")
            ],
            str(entry),
        ], check=True, stdout=log, stderr=subprocess.STDOUT, timeout=300)
    bundle = output / "AmazMe Python 0.1.0"
    shutil.move(output / "dist/amazme-backend", bundle)
    (bundle / "runtime").mkdir()
    install_codemode_runtime(bundle)
    fingerprints = {}
    for path in sorted(bundle.rglob("*")):
        if path.is_file():
            with path.open("rb") as stream:
                fingerprints[str(path.relative_to(bundle))] = hashlib.file_digest(stream, "sha256").hexdigest()
    absent = missing_identity(fingerprints)
    if absent:
        raise SystemExit("build identity is missing " + ", ".join(absent))
    manifest = {"version": "0.1.0", "nonce": secrets.token_hex(16), "files": fingerprints}
    manifest["build_id"] = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    (bundle / "build.json").write_text(json.dumps(manifest, indent=2) + "\n")
    subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(bundle / "amazme-backend")], check=True)
    shutil.rmtree(output / "build")  # Only this invocation owns the PyInstaller scratch tree.
    (parent / "latest-bundle").write_text(str(bundle))
    print(json.dumps({"bundle": str(bundle), "build_id": manifest["build_id"], "files": len(fingerprints),
                      "bytes": sum(p.stat().st_size for p in bundle.rglob("*") if p.is_file()),
                      "signature": "local ad-hoc; no distributable DMG"}))


if __name__ == "__main__":
    from workspace_lock import run_locked

    run_locked(main)
