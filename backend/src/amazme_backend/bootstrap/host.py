import asyncio
import json
import os
import secrets
import socket

import uvicorn

from amazme_backend.execution.processes import ProcessReservation, retain_inherited
from amazme_backend.host.service import Host
from amazme_backend.interfaces.http.application import application
from amazme_backend.platform.private_files import lock, private_write
from amazme_backend.profiles.profile import Profile


def loopback_listener(port: int) -> socket.socket:
    return socket.create_server(("127.0.0.1", port), backlog=128)


async def serve(profile: Profile, port: int = 0) -> None:
    with lock(profile.path / "host.lock"):
        instance = secrets.token_hex(16)
        with ProcessReservation(profile.path, "host", instance) as reservation:
            descriptor = os.dup(reservation.fd)
            process_lease = retain_inherited(descriptor, profile.path, "host", instance)
        owner = Host(profile, instance, process_lease)
        try:
            await owner.initialize()
            with loopback_listener(port or await owner.lifecycle.store.port()) as listener:
                listener.setblocking(False)
                actual_port = listener.getsockname()[1]
                await owner.lifecycle.store.port(actual_port)
                owner.origin = f"http://127.0.0.1:{actual_port}"
                server = uvicorn.Server(
                    uvicorn.Config(
                        application(owner),
                        log_level="error",
                        access_log=False,
                        ws="websockets-sansio",
                        ws_max_size=4096,
                        timeout_graceful_shutdown=3,
                    )
                )
                ready = {
                    "url": owner.origin,
                    **owner.lifecycle.identity((await owner.lifecycle.health()).state).model_dump(),
                }
                private_write(profile.path / "ready.json", json.dumps(ready))
                print(json.dumps(ready), flush=True)

                async def watch() -> None:
                    await owner.lifecycle.stop.wait()
                    server.should_exit = True

                watcher = asyncio.create_task(watch())
                try:
                    await server.serve(sockets=[listener])
                finally:
                    watcher.cancel()
        finally:
            await owner.close()
