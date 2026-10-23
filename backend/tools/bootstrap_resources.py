"""Build-time network hydration, followed by an offline runtime image archive."""

import asyncio
import hashlib
import json
import secrets
import tempfile
from pathlib import Path

from amazme_backend.common import Profile, private_write, resource_root
from amazme_backend.vm import VM


async def main() -> None:
    root = Path(__file__).resolve().parents[2] / ".artifacts/python-backend-p1"
    root.mkdir(parents=True, exist_ok=True)
    p = Path(tempfile.mkdtemp(prefix="hydrate-", dir=root))
    (p / "workspace").mkdir()
    private_write(p / "config.json", json.dumps({"format": 1, "profile_id": secrets.token_hex(16),
                  "workspace": str(p / "workspace"), "resources": str(resource_root()), "provider": {"provider": "faux"}}))
    private_write(p / "control.token", secrets.token_hex(32))
    print(p, flush=True)
    vm = VM(Profile(p))
    try:
        print("boot", await vm.start(build_resources=True), flush=True)
        print("docker", await vm.guest("sudo", "docker", "version", "--format", "{{.Server.Version}}"), flush=True)
        manifest_path = resource_root() / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        with (resource_root() / "container.tar").open("rb") as stream:
            manifest["files"]["container.tar"] = hashlib.file_digest(stream, "sha256").hexdigest()
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    finally:
        await vm.delete()
        await vm.close()


if __name__ == "__main__":
    asyncio.run(main())
