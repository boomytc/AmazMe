import asyncio
import hashlib
import os

import httpx
import yaml
from pydantic import BaseModel, ConfigDict, Field

from .common import Profile, resource_root
from .contracts import BackendError


class DockerState(BaseModel):
    model_config = ConfigDict(extra="ignore")
    Running: bool
    Pid: int
    ExitCode: int
    Status: str


class DockerConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")
    Image: str
    Labels: dict[str, str] = Field(default_factory=dict)


class Container(BaseModel):
    model_config = ConfigDict(extra="ignore")
    Id: str
    State: DockerState
    Config: DockerConfig


class ResourceManifest(BaseModel):
    format: int
    lima_version: str
    container_image: str
    files: dict[str, str]


class VM:
    def __init__(self, profile: Profile):
        self.profile = profile
        self.resources = resource_root()
        self.manifest = ResourceManifest.model_validate_json((self.resources / "manifest.json").read_bytes())
        self.image_id = self.manifest.container_image.split("@", 1)[1]
        self.home = profile.ipc / "vm"
        self.home.mkdir(mode=0o700, exist_ok=True)
        self.name = "execution"
        self.socket = self.home / self.name / "sock/docker.sock"
        self.lima = self.resources / "lima/bin/limactl"
        self.docker = self.resources / "docker"
        self.env = {**os.environ, "PATH": str(self.lima.parent) + ":/usr/bin:/bin:/usr/sbin:/sbin",
                    "LIMA_HOME": str(self.home)}
        self.http = httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=str(self.socket)),
                                     base_url="http://docker", timeout=30, trust_env=False)

    async def command(self, args: list[str], *, timeout: float = 90, stdin: bytes | None = None) -> str:
        process = await asyncio.create_subprocess_exec(
            *args, env=self.env, stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(stdin), timeout)
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if process.returncode:
            raise BackendError("vm_command_failed", stderr.decode(errors="replace")[-1000:], 503)
        if args[0] == str(self.lima) and len(args) > 1 and args[1] == "start":
            log = self.profile.path / "vm-start.log"
            fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "ab") as stream:
                stream.write(stdout + stderr)
        return stdout.decode(errors="replace").strip()

    async def guest(self, *args: str) -> str:
        return await self.command([str(self.lima), "shell", self.name, "--", *args])

    async def verify_resources(self) -> None:
        def verify() -> None:
            for name, digest in self.manifest.files.items():
                p = self.resources / name
                if not p.is_file():
                    raise BackendError("missing_runtime_resource", name, 503)
                with p.open("rb") as stream:
                    actual = hashlib.file_digest(stream, "sha256").hexdigest()
                if actual != digest:
                    raise BackendError("runtime_resource_mismatch", name, 503)
        await asyncio.to_thread(verify)

    async def start(self, *, build_resources: bool = False) -> str:
        await self.verify_resources()
        config = {
            "vmType": "vz", "arch": "aarch64", "cpus": 2, "memory": "2GiB", "disk": "10GiB",
            "images": [{"location": str(self.resources / "base.img.gz"), "arch": "aarch64",
                        "digest": "sha256:" + self.manifest.files["base.img.gz"]}],
            "mountType": "virtiofs",
            "mounts": [{"location": self.profile.config.workspace, "mountPoint": "/workspace", "writable": True}],
            "ssh": {"loadDotSSHPubKeys": False, "forwardAgent": False},
            "containerd": {"system": False, "user": False},
            "provision": [{"mode": "dependency", "skipDefaultDependencyResolution": True,
                           "script": "#!/bin/sh\nset -eu\nfor x in dockerd containerd runc iptables; do command -v $x; done\nrm -f /etc/resolv.conf\nprintf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf\nsystemctl enable --now docker\nchmod 0600 /var/run/docker.sock\nchown {{.UID}} /var/run/docker.sock\n"}],
            "portForwards": [{"guestSocket": "/var/run/docker.sock", "hostSocket": str(self.socket)},
                             {"guestPortRange": [1, 65535], "ignore": True}],
        }
        config_path = self.home / "execution.yaml"
        config_path.write_text(yaml.safe_dump(config))
        target = self.name if (self.home / self.name / "lima.yaml").exists() else str(config_path)
        await self.command([str(self.lima), "start", "--tty=false", "--name=" + self.name, target], timeout=180)
        for _ in range(100):
            try:
                response = await self.http.get("/_ping")
                response.raise_for_status()
                break
            except httpx.TransportError:
                await asyncio.sleep(0.1)
        else:
            raise BackendError("container_runtime_unavailable", status=503)
        image = await self.http.get("/images/" + self.image_id + "/json")
        if image.status_code == 404:
            if build_resources:
                await self.command([str(self.docker), "--host", "unix://" + str(self.socket),
                                    "pull", self.manifest.container_image], timeout=300)
                await self.command([str(self.docker), "--host", "unix://" + str(self.socket), "save", "-o",
                                    str(self.resources / "container.tar"), self.manifest.container_image], timeout=180)
            elif (self.resources / "container.tar").exists():
                await self.command([str(self.docker), "--host", "unix://" + str(self.socket), "load", "-i",
                                    str(self.resources / "container.tar")], timeout=180)
            else:
                raise BackendError("missing_offline_image", status=503)
        elif image.is_error:
            raise BackendError("container_image_unavailable", status=503)
        verified = await self.http.get("/images/" + self.image_id + "/json")
        verified.raise_for_status()
        return await self.guest("cat", "/proc/sys/kernel/random/boot_id")

    async def inspect(self, identity: str) -> Container | None:
        response = await self.http.get(f"/containers/{identity}/json")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return Container.model_validate_json(response.content)

    async def cgroup(self, container: Container) -> str:
        value = await self.guest("sudo", "cat", f"/proc/{container.State.Pid}/cgroup")
        if not value.startswith("0::/") or container.Id not in value:
            raise BackendError("cgroup_identity_mismatch", status=503)
        return "/sys/fs/cgroup" + value.split("::", 1)[1]

    async def kill_and_prove(self, container_id: str, cgroup: str, boot_id: str) -> None:
        if await self.guest("cat", "/proc/sys/kernel/random/boot_id") != boot_id:
            raise BackendError("vm_boot_changed", status=503)
        container = await self.inspect(container_id)
        if container is None:
            # Docker alone saying 404 is insufficient without the registered cgroup proof.
            if not cgroup:
                raise BackendError("resource_identity_missing", status=503)
        elif container.State.Running:
            response = await self.http.post(f"/containers/{container_id}/kill", params={"signal": "KILL"})
            if response.status_code not in {204, 409}:
                response.raise_for_status()
            response = await self.http.post(f"/containers/{container_id}/wait", params={"condition": "not-running"})
            response.raise_for_status()
        if cgroup:
            # The fixed helper checks only a path derived from a verified container's /proc record.
            script = "import pathlib,sys; p=pathlib.Path(sys.argv[1]); print(p.read_text() if p.exists() else 'removed')"
            for _ in range(100):
                state = await self.guest("sudo", "python3", "-c", script, cgroup + "/cgroup.events")
                if state == "removed" or "populated 0" in state:
                    break
                await asyncio.sleep(0.05)
            else:
                raise BackendError("execution_cleanup_pending", status=503)
        current = await self.inspect(container_id)
        if current and current.State.Running:
            raise BackendError("execution_cleanup_pending", status=503)

    async def stop(self) -> None:
        await self.command([str(self.lima), "stop", "--tty=false", self.name], timeout=90)

    async def delete(self) -> None:
        await self.command([str(self.lima), "delete", "--tty=false", "--force", self.name], timeout=90)

    async def close(self) -> None:
        await self.http.aclose()
