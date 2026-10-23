"""Build an immutable onedir with its interpreter, VM manager, engine image and Web client."""

import argparse
import hashlib
import json
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


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
            "--add-data", str(ROOT / "src/amazme_backend/gate.py") + ":amazme_backend",
            str(entry),
        ], check=True, stdout=log, stderr=subprocess.STDOUT, timeout=300)
    bundle = output / "AmazMe Python 0.1.0"
    shutil.move(output / "dist/amazme-backend", bundle)
    shutil.copytree(ROOT / "resources", bundle / "resources")
    fingerprints = {}
    for path in sorted(bundle.rglob("*")):
        if path.is_file():
            with path.open("rb") as stream:
                fingerprints[str(path.relative_to(bundle))] = hashlib.file_digest(stream, "sha256").hexdigest()
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
