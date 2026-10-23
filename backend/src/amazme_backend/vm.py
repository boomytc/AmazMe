import asyncio
import hashlib
import json
import os
import secrets
import stat
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import IO, Literal

import httpx
import yaml
from pydantic import BaseModel, ConfigDict, Field

from .common import Profile, lock, private_write, resource_root
from .contracts import BackendError, Model


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
    lima_lease_protocol: Literal["amazme-mutation-startup/1"]
    container_image: str
    files: dict[str, str]


class VMOwner(Model):
    vm_id: str
    profile_id: str
    profile_path: str


class VMLocator(VMOwner):
    home: str


class ResourceStamp(Model):
    fingerprint: str
    vm_id: str


class Machine(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    status: str
    dir: str
    hostAgentPID: int = 0
    driverPID: int = 0


class VMStopProof(Model):
    vm_id: str
    receipt_id: str
    instance_dir: str
    state: str = "Stopped"


class VM:
    def __init__(self, profile: Profile):
        self.profile = profile
        self.resources = resource_root()
        self.manifest = ResourceManifest.model_validate_json((self.resources / "manifest.json").read_bytes())
        self.image_id = self.manifest.container_image.split("@", 1)[1]
        gate_digest = hashlib.sha256(Path(__file__).with_name("gate.py").read_bytes()).hexdigest()
        self.resource_fingerprint = hashlib.sha256(json.dumps(
            {"manifest": self.manifest.model_dump(), "gate": gate_digest}, sort_keys=True).encode()).hexdigest()
        key = hashlib.sha256(str(profile.path).encode()).hexdigest()[:24]
        base = Path.home() / ".amazme-vm"
        self.home = base / key
        self.name = "execution"
        self.socket = self.home / self.name / "sock/docker.sock"
        # Include Lima's temporary SSH suffix before creating any owner metadata.
        sockets = [self.socket, self.home / self.name / "ssh.sock.1234567890123456",
                   self.home / self.name / "ha.sock"]
        for path in sockets:
            size = len(os.fsencode(path))
            if size >= 104:
                raise BackendError("vm_socket_path_too_long",
                                   f"{path}: {size} bytes; required < 104")
        locator_path = profile.path / "vm.json"
        locator = VMLocator.model_validate_json(locator_path.read_bytes()) if locator_path.exists() else None
        if locator is not None and (locator.profile_id, locator.profile_path, locator.home) != (
            profile.config.profile_id, str(profile.path), str(base / key)
        ):
            raise BackendError("vm_owner_mismatch")
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.home.mkdir(mode=0o700, exist_ok=True)
        for directory in (base, self.home):
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise BackendError("unsafe_vm_directory")
        with lock(self.home / "owner.lock"):
            owner_path = self.home / "owner.json"
            if owner_path.exists():
                owner = VMOwner.model_validate_json(owner_path.read_bytes())
                if (owner.profile_id, owner.profile_path) != (profile.config.profile_id, str(profile.path)):
                    raise BackendError("vm_owner_mismatch")
            else:
                if locator is not None:
                    raise BackendError("vm_owner_missing")
                if any(p.name != "owner.lock" for p in self.home.iterdir()):
                    raise BackendError("vm_owner_missing")
                owner = VMOwner(vm_id=secrets.token_hex(16), profile_id=profile.config.profile_id,
                                profile_path=str(profile.path))
                private_write(owner_path, owner.model_dump_json())
            if locator is not None and locator.vm_id != owner.vm_id:
                raise BackendError("vm_owner_mismatch")
        self.vm_id = owner.vm_id
        private_write(locator_path, VMLocator(**owner.model_dump(), home=str(self.home)).model_dump_json())
        self.lima = self.resources / "lima/bin/limactl"
        self.docker = self.resources / "docker"
        self._lease_protocol_verified = False
        self.env = {**os.environ, "PATH": str(self.lima.parent) + ":/usr/bin:/bin:/usr/sbin:/sbin",
                    "LIMA_HOME": str(self.home)}
        self.http = httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=str(self.socket)),
                                     base_url="http://docker", timeout=30, trust_env=False)

    @asynccontextmanager
    async def operation(self, timeout: float = 180) -> AsyncGenerator[IO[str]]:
        deadline = time.monotonic() + timeout
        while True:
            try:
                lease = lock(self.home / "operation.lock")
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise BackendError("vm_operation_pending", status=503) from None
                await asyncio.sleep(0.05)
        try:
            info = os.fstat(lease.fileno())
            identity = {"device": info.st_dev, "inode": info.st_ino, "vm_id": self.vm_id}
            path = self.home / "operation-identity.json"
            if path.exists():
                if json.loads(path.read_text()) != identity:
                    raise BackendError("vm_operation_lease_replaced", status=503)
            else:
                private_write(path, json.dumps(identity))
            current = (self.home / "operation.lock").lstat()
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise BackendError("vm_operation_lease_replaced", status=503)
            yield lease
            current = (self.home / "operation.lock").lstat()
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise BackendError("vm_operation_lease_replaced", status=503)
        finally:
            # Closing the parent duplicate never explicitly unlocks an inherited flock.
            lease.close()

    async def command(self, args: list[str], *, timeout: float = 90, stdin: bytes | None = None,
                      operation: IO[str] | None = None, lease_probe: bool = False) -> str:
        if args[0] == str(self.lima) and args[1] in {"start", "stop", "delete"} and operation is None:
            async with self.operation(timeout) as held:
                return await self.command(args, timeout=timeout, stdin=stdin, operation=held, lease_probe=lease_probe)
        if operation is not None and args[0] == str(self.lima) and not self._lease_protocol_verified:
            await self.verify_resources()
        env = {key: value for key, value in self.env.items() if key not in {
            "AMAZME_MUTATION_LEASE_FD", "AMAZME_STARTUP_LEASE_FD", "AMAZME_LEASE_PROTOCOL_PROBE",
        }}
        if operation is not None:
            env["AMAZME_MUTATION_LEASE_FD"] = str(operation.fileno())
        if lease_probe:
            env["AMAZME_LEASE_PROTOCOL_PROBE"] = "1"
        process = await asyncio.create_subprocess_exec(
            *args, env=env, stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            pass_fds=(operation.fileno(),) if operation else (),
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
            if "lima/bin/limactl" not in self.manifest.files:
                raise BackendError("missing_runtime_resource", "lima/bin/limactl", 503)
            for name, digest in self.manifest.files.items():
                p = self.resources / name
                if not p.is_file():
                    raise BackendError("missing_runtime_resource", name, 503)
                with p.open("rb") as stream:
                    actual = hashlib.file_digest(stream, "sha256").hexdigest()
                if actual != digest:
                    raise BackendError("runtime_resource_mismatch", name, 503)
        await asyncio.to_thread(verify)
        protocol = await self.command([str(self.lima), "--version"], timeout=10, lease_probe=True)
        if protocol != self.manifest.lima_lease_protocol:
            raise BackendError("lima_lease_protocol_mismatch", status=503)
        self._lease_protocol_verified = True

    async def start(self, *, build_resources: bool = False) -> str:
        async with self.operation() as held:
            return await self._start(held, build_resources=build_resources)

    async def _start(self, held: IO[str], *, build_resources: bool) -> str:
        await self.verify_resources()
        stamp = self.home / "resource-stamp.json"
        machine = await self.machine()
        if machine is None and (self.home / self.name).exists():
            raise BackendError("vm_identity_missing", status=503)
        if machine is not None:
            previous = ResourceStamp.model_validate_json(stamp.read_bytes()) if stamp.exists() else None
            if previous is None or (previous.fingerprint, previous.vm_id) != (self.resource_fingerprint, self.vm_id):
                # An owned rootfs is never silently adopted by a different immutable runtime.
                await self._stop_locked(held)
                await self.command([str(self.lima), "delete", "--tty=false", "--force", self.name],
                                   timeout=90, operation=held)
                if await self.machine() is not None or (self.home / self.name).exists():
                    raise BackendError("vm_recreation_unproven", status=503)
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
        await self.command([str(self.lima), "start", "--tty=false", "--name=" + self.name, target], timeout=180, operation=held)
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
                                    "pull", self.manifest.container_image], timeout=300, operation=held)
                await self.command([str(self.docker), "--host", "unix://" + str(self.socket), "save", "-o",
                                    str(self.resources / "container.tar"), self.manifest.container_image], timeout=180,
                                   operation=held)
            elif (self.resources / "container.tar").exists():
                await self.command([str(self.docker), "--host", "unix://" + str(self.socket), "load", "-i",
                                    str(self.resources / "container.tar")], timeout=180, operation=held)
            else:
                raise BackendError("missing_offline_image", status=503)
        elif image.is_error:
            raise BackendError("container_image_unavailable", status=503)
        verified = await self.http.get("/images/" + self.image_id + "/json")
        verified.raise_for_status()
        boot = await self.guest("cat", "/proc/sys/kernel/random/boot_id")
        private_write(stamp, json.dumps({"fingerprint": self.resource_fingerprint, "vm_id": self.vm_id}))
        return boot

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
        if await self.guest("cat", "/proc/sys/kernel/random/boot_id") != boot_id:
            raise BackendError("vm_boot_changed", status=503)

    async def machine(self) -> Machine | None:
        output = await self.command([str(self.lima), "list", "--json"])
        inventory = [Machine.model_validate_json(line) for line in output.splitlines() if line.strip()]
        matches = [machine for machine in inventory if machine.name == self.name]
        if not matches:
            return None
        if len(matches) != 1:
            raise BackendError("vm_identity_mismatch", status=503)
        machine = matches[0]
        if Path(machine.dir).resolve() != (self.home / self.name).resolve():
            raise BackendError("vm_identity_mismatch", status=503)
        return machine

    @asynccontextmanager
    async def stopped(self) -> AsyncGenerator[VMStopProof]:
        # Retain the same inherited mutation barrier until the caller durably seals epochs.
        async with self.operation() as held:
            yield await self._stop_locked(held)

    async def _stop_locked(self, held: IO[str]) -> VMStopProof:
        machine = await self.machine()
        if machine is not None:
            if machine.status != "Stopped" or machine.hostAgentPID or machine.driverPID:
                await self.command([str(self.lima), "stop", "--tty=false", self.name],
                                   timeout=90, operation=held)
            machine = await self.machine()
            if machine is None or machine.status != "Stopped" or machine.hostAgentPID or machine.driverPID:
                raise BackendError("vm_stop_unproven", status=503)
        elif (self.home / self.name).exists():
            raise BackendError("vm_stop_unproven", status=503)
        proof = VMStopProof(vm_id=self.vm_id, receipt_id=secrets.token_hex(16),
                            instance_dir=str(self.home / self.name), state="Stopped" if machine else "Absent")
        private_write(self.home / "last-stop.json", proof.model_dump_json())
        return proof

    async def stop(self) -> VMStopProof:
        async with self.stopped() as proof:
            return proof

    async def delete(self) -> VMStopProof:
        async with self.operation() as held:
            proof = await self._stop_locked(held)
            if proof.state == "Absent":
                return proof
            await self.command([str(self.lima), "delete", "--tty=false", "--force", self.name],
                               timeout=90, operation=held)
            if await self.machine() is not None or (self.home / self.name).exists():
                raise BackendError("vm_recreation_unproven", status=503)
            return proof

    async def close(self) -> None:
        await self.http.aclose()
