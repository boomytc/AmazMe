"""Shutdown tells the caller the supervisor has stopped, and keeps that fact."""

import asyncio
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

import httpx

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import HostFence, ProcessLease, ServiceInfo
from amazme_backend.host import Host, application
from amazme_backend.processes import ProcessReservation, exited


def _profile(tmp_path: Path) -> None:
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "host-1", "workspace": str(tmp_path / "primary"), "resources": "unused",
        "provider": {"provider": "faux", "api_key": "", "proxy": "", "headers": {}},
    }))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "c" * 64)
    private_write(tmp_path / "web.token", "w" * 48)


async def test_shutdown_response_waits_for_supervisor_exit(tmp_path: Path) -> None:
    _profile(tmp_path)
    host = Host(Profile(tmp_path))
    child: subprocess.Popen[bytes] | None = None
    server: asyncio.Server | None = None
    try:
        with ProcessReservation(tmp_path, "host", host.instance) as host_lease:
            epoch = await host.store.initialize(host.instance, host.build, host_lease.lease)
        host.fence = HostFence(host_epoch=epoch, build_id=host.build)
        host.initialized = True
        host.origin = "http://127.0.0.1:4310"
        instance = "supervisor-1"
        with ProcessReservation(tmp_path, "supervisor", instance) as reservation:
            child = subprocess.Popen(
                [sys.executable, "-c", "import time\nwhile True:\n time.sleep(3600)\n"],
                pass_fds=(reservation.fd,),
                start_new_session=True,
            )
            lease = reservation.lease
        assert not exited(lease)
        await _record(host, instance, lease, child.pid)
        identity = host.profile.identity(instance, host.build, role="supervisor", host_epoch=epoch)
        started, release = asyncio.Event(), asyncio.Event()
        server = await _serve(host.profile.socket("supervisor"), identity.model_dump_json(), child, started, release)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application(host)), base_url=host.origin,
        ) as client:
            pending = asyncio.create_task(client.post(
                "/control/shutdown",
                headers={"Authorization": "Bearer " + host.profile.token},
                json={"host_epoch": epoch, "build_id": host.build},
            ))
            await asyncio.wait_for(started.wait(), 5)
            assert not pending.done()
            stopping = await host.store.service()
            assert stopping is not None and stopping.state == "stopping"
            release.set()
            response = await asyncio.wait_for(pending, 10)
        assert response.status_code == 200
        assert response.json()["state"] == "stopping"
        assert child.poll() is not None
        assert exited(lease)
        assert await host.store.service() is None
        assert [item.state for item in await host.store.services()] == ["stopped"]
    finally:
        if server is not None:
            server.close()
            await server.wait_closed()
        if child is not None and child.poll() is None:
            os.kill(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
        await host.close()


async def _record(host: Host, instance: str, lease: ProcessLease, pid: int) -> ServiceInfo:
    record = ServiceInfo(instance_id=instance, build_id=host.build, process_lease=lease, state="running", pid=pid)
    await host.store.save_service(record)
    return record


async def _serve(path: Path, identity: str, child: subprocess.Popen[bytes], started: asyncio.Event, release: asyncio.Event) -> asyncio.Server:
    payload = identity.encode()

    async def connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        header = await reader.readuntil(b"\r\n\r\n")
        length = 0
        for line in header.split(b"\r\n"):
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":", 1)[1].strip())
        if length:
            await reader.readexactly(length)
        body = payload
        if b"POST /shutdown " in header:
            started.set()
            await release.wait()
            if child.poll() is None:
                os.kill(child.pid, signal.SIGTERM)
                await asyncio.to_thread(child.wait, 5)
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
            + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body
        )
        await writer.drain()
        writer.close()

    path.unlink(missing_ok=True)
    return await asyncio.start_unix_server(connection, path=path)
