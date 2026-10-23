"""Build an immutable onedir with its interpreter, VM manager, engine image and Web client."""

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

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
OFFICIAL_NODE = Path.home() / "Library/Caches/amazme-release/node-v22.23.3-darwin-arm64/bin/node"
REQUIRED_IDENTITY = (
    "resources/node/bin/node",
    "resources/docker",
    "resources/lima/bin/limactl",
    "codemode_helper.mjs",
    "plugin_gate.py",
    "quickjs-wasi/quickjs.wasm",
)


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
    node_dest = bundle / "resources" / "node" / "bin" / "node"
    node_dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(official_node(), node_dest)
    node_dest.chmod(0o755)
    helper = bundle / "_internal" / "amazme_backend" / "codemode_helper.mjs"
    plugin = bundle / "_internal" / "amazme_backend" / "plugin_gate.py"
    if not helper.is_file() or not plugin.is_file():
        raise SystemExit("packaged helper or plugin gate is missing")
    modules = helper.parent / "node_modules" / "quickjs-wasi"
    shutil.copytree(REPO / "node_modules" / "quickjs-wasi", modules, symlinks=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, default=ROOT.parent / ".artifacts/python-backend-p2")
    args = parser.parse_args()
    parent = args.output_root.resolve()
    parent.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix="package-", dir=parent))
    entry = output / "entrypoint.py"
    entry.write_text("from amazme_backend.__main__ import main\nmain()\n")
    with (output / "build.log").open("w") as log:
        subprocess.run([
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--name", "amazme-backend",
            "--distpath", str(output / "dist"), "--workpath", str(output / "build"), "--specpath", str(output),
            "--paths", str(ROOT / "src"),
            "--add-data", str(ROOT / "src/amazme_backend/web") + ":amazme_backend/web",
            *[
                item
                for name in (
                    "gate.py", "pty_gate.py", "mcp_gate.py", "plugin_gate.py",
                    "computer_driver.py", "remote_daemon.py", "codemode_helper.mjs",
                )
                for item in ("--add-data", f"{ROOT / 'src/amazme_backend' / name}:amazme_backend")
            ],
            str(entry),
        ], check=True, stdout=log, stderr=subprocess.STDOUT, timeout=300)
    bundle = output / "AmazMe Python 0.1.0"
    shutil.move(output / "dist/amazme-backend", bundle)
    shutil.copytree(ROOT / "resources", bundle / "resources")
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
    (parent / "latest-bundle").write_text(str(bundle))
    print(json.dumps({"bundle": str(bundle), "build_id": manifest["build_id"], "files": len(fingerprints),
                      "bytes": sum(p.stat().st_size for p in bundle.rglob("*") if p.is_file()),
                      "signature": "local ad-hoc; no distributable DMG"}))


if __name__ == "__main__":
    main()
