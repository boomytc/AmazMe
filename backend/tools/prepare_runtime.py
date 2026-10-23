"""Assemble pinned local runtime resources; no downloads at product startup."""

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources"
BASE_SHA = "1fc0354f4f99734ce3886628cc7af8b0437c1a1d391b126bd09cba0df35ee53f"
CONTAINER = "python@sha256:bf12ecc0bea3f171d55145dd02c78b5eeb09f30ee2ac9cc2b4c9e4e8f5e30741"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main() -> None:
    OUT.mkdir(exist_ok=True)
    assert subprocess.check_output(["limactl", "--version"], text=True).strip() == "limactl version 2.2.1"
    lima = Path(subprocess.check_output(["which", "limactl"], text=True).strip()).resolve().parent.parent
    for name in ["bin/limactl", "share/lima/lima-guestagent.Linux-aarch64.gz"]:
        dst = OUT / "lima" / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(lima / name, dst)
    docker = Path(subprocess.check_output(["which", "docker"], text=True).strip()).resolve()
    shutil.copy2(docker, OUT / "docker")
    cache = Path.home() / "Library/Caches/colima/caches"
    candidate = next((p for p in cache.iterdir() if p.is_file() and p.stat().st_size == 332354401), None)
    if candidate is None or digest(candidate) != BASE_SHA:
        raise SystemExit("Pinned VM image missing; provide the verified Colima 0.10.3 arm64 base image")
    shutil.copy2(candidate, OUT / "base.img.gz")
    manifest = {
        "format": 1,
        "lima_version": "2.2.1",
        "container_image": CONTAINER,
        "files": {str(p.relative_to(OUT)): digest(p) for p in OUT.rglob("*") if p.is_file()
                  and p.name != "manifest.json"},
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(OUT)


if __name__ == "__main__":
    main()
