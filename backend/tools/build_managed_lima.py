"""Build the pinned Lima mutation/startup lease protocol, only on the build machine."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "27bc4c4b101e27994e01e36566a0f2091bbca507"
SOURCE_SHA = "8b615cab44e93b404283456f060979d9b19d8066c1d05e0d4a1e6720822117aa"
PROTOCOL = "amazme-mutation-startup/1"


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def build(go: Path, archive: Path | None = None) -> Path:
    go_version = subprocess.check_output([str(go), "version"], text=True).strip()
    if go_version != "go version go1.27.1 darwin/arm64":
        raise RuntimeError("Managed Lima requires the verified Go 1.27.1 darwin/arm64 build toolchain")
    parent = ROOT.parent / ".artifacts/python-backend-p2/native-build"
    parent.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix="managed-lima-", dir=parent))
    if archive is None:
        archive = output / "source.tar.gz"
        with urllib.request.urlopen("https://codeload.github.com/lima-vm/lima/tar.gz/" + COMMIT, timeout=60) as source:
            with archive.open("wb") as destination:
                shutil.copyfileobj(source, destination)
    if sha(archive) != SOURCE_SHA:
        raise RuntimeError("Pinned Lima source digest mismatch")
    with tarfile.open(archive) as source:
        source.extractall(output, filter="data")
    source_dir = output / ("lima-" + COMMIT)
    patch = output / "mutation-lease.patch"
    shutil.copy2(ROOT / "tools/patches/lima-2.2.1-mutation-lease.patch", patch)
    subprocess.run(["patch", "--batch", "-p1", "-i", str(patch)], cwd=source_dir, check=True)
    env = {**os.environ, "CGO_ENABLED": "1", "GOTOOLCHAIN": "local"}
    with (output / "build.log").open("w") as log:
        subprocess.run([str(go), "test", "./pkg/amazmelease",
                        "-run", "TestAmazMe", "-count=1"], cwd=source_dir, env=env, stdout=log,
                       stderr=subprocess.STDOUT, check=True, timeout=900)
        executable = output / "limactl"
        subprocess.run([str(go), "build", "-trimpath", "-ldflags",
                        "-s -w -X github.com/lima-vm/lima/v2/pkg/version.Version=v2.2.1",
                        "-o", str(executable), "./cmd/limactl"], cwd=source_dir, env=env,
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=900)
    subprocess.run(["codesign", "--force", "--sign", "-", "--entitlements", str(source_dir / "vz.entitlements"),
                    str(executable)], check=True)
    probe = subprocess.check_output([str(executable), "--version"], text=True,
                                    env={**os.environ, "AMAZME_LEASE_PROTOCOL_PROBE": "1"}).strip()
    if probe != PROTOCOL:
        raise RuntimeError("Managed Lima protocol probe failed")
    destination = ROOT / "resources/lima/bin/limactl"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix="limactl-", dir=destination.parent, delete=False) as pending:
        staged = Path(pending.name)
    try:
        shutil.copy2(executable, staged)
        os.replace(staged, destination)
    finally:
        staged.unlink(missing_ok=True)
    # Required redistribution notice for the patched Apache-2.0 component.
    shutil.copy2(source_dir / "LICENSE", ROOT / "resources/lima/LICENSE")
    provenance = {"version": "2.2.1", "commit": COMMIT, "source_sha256": SOURCE_SHA,
                  "patch_sha256": sha(patch), "protocol": PROTOCOL, "binary_sha256": sha(destination),
                  "go": go_version}
    (ROOT / "resources/lima/amazme-build.json").write_text(json.dumps(provenance, indent=2) + "\n")
    manifest_path = ROOT / "resources/manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        manifest["lima_lease_protocol"] = PROTOCOL
        for path in [destination, ROOT / "resources/lima/LICENSE", ROOT / "resources/lima/amazme-build.json"]:
            manifest["files"][str(path.relative_to(ROOT / "resources"))] = sha(path)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "report.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(json.dumps({"output": str(output), **provenance}), flush=True)
    return destination


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--go", type=Path, default=shutil.which("go"))
    parser.add_argument("--source-archive", type=Path)
    args = parser.parse_args()
    if args.go is None:
        parser.error("Provide Go 1.27.1 darwin/arm64 with --go; no runtime Go dependency is installed")
    build(Path(args.go).resolve(), args.source_archive.resolve() if args.source_archive else None)


if __name__ == "__main__":
    main()
