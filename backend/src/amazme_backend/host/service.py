from __future__ import annotations

import asyncio
import contextlib
import sqlite3

import httpx

from amazme_backend.contracts.execution import ProcessLease
from amazme_backend.contracts.ipc.supervisor import TaskActivity
from amazme_backend.contracts.ipc.worker import WorkerActivity
from amazme_backend.execution.processes import exited
from amazme_backend.host.accounts import AccountOperations
from amazme_backend.host.computer import ComputerOperations
from amazme_backend.host.content import ContentOperations
from amazme_backend.host.integrations import IntegrationOperations
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.host.scheduling import Scheduling
from amazme_backend.host.session_access import WorkerSessions
from amazme_backend.host.sessions import SessionOperations
from amazme_backend.host.updates import UpdateOperations
from amazme_backend.host.workspaces import WorkspaceOperations
from amazme_backend.profiles.layout import session_database
from amazme_backend.profiles.profile import Profile
from amazme_backend.sessions.service import TERMINAL
from amazme_backend.shared.errors import BackendError


class Host:
    def __init__(
        self, profile: Profile, instance: str | None = None, process_lease: ProcessLease | None = None
    ):
        self.lifecycle = HostLifecycle(profile, instance, process_lease)
        self.accounts = AccountOperations(self.lifecycle)
        self.integrations = IntegrationOperations(self.accounts, self.lifecycle)
        self.access = WorkerSessions(self.integrations, self.lifecycle)
        self.computer = ComputerOperations(self.access, self.accounts, self.lifecycle)
        self.sessions = SessionOperations(self.access, self.accounts, self.computer, self.lifecycle)
        self.workspaces = WorkspaceOperations(self.lifecycle)
        self.content = ContentOperations(self.access, self.accounts, self.lifecycle, self.sessions)
        self.scheduling = Scheduling(self.access, self.accounts, self.lifecycle, self.sessions)
        self.updates = UpdateOperations(self.access, self.lifecycle)
        self.background: asyncio.Task[None] | None = None
        self.web_token = (profile.path / "web.token").read_text().strip()
        self.origin = ""

    async def initialize(self) -> None:
        await self.lifecycle.initialize()
        self.background = asyncio.create_task(self.dispatcher())

    async def dispatcher(self) -> None:

        async def dispatch_session(session: str) -> None:
            try:
                async with self.sessions.delivery_locks.setdefault(session, asyncio.Lock()):
                    for delivery in await self.lifecycle.store.pending(session):
                        await self.sessions.dispatch(delivery)
                    peer = await self.access.worker(session)
                    await self.lifecycle.store.activity(
                        session, await peer.call("GET", "/activity", WorkerActivity)
                    )
            except sqlite3.Error:
                self.lifecycle.storage_failed = True
            except (BackendError, httpx.TransportError, TimeoutError):
                return

        tasks: dict[str, asyncio.Task[None]] = {}
        try:
            while not self.lifecycle.stop.is_set():
                for session, task in list(tasks.items()):
                    if task.done():
                        task.result()
                        del tasks[session]
                try:
                    self.lifecycle.admit()
                    await self.scheduling.tick_schedules()
                    if await self.lifecycle.store.active_update() is None:
                        await self.lifecycle.ensure_supervisor()
                        sessions = {d.session_id for d in await self.lifecycle.store.pending()}
                        sessions.update(await self.lifecycle.store.due())
                        for session in sorted(sessions - tasks.keys()):
                            tasks[session] = asyncio.create_task(dispatch_session(session))
                except sqlite3.Error:
                    self.lifecycle.storage_failed = True
                except (BackendError, httpx.TransportError, TimeoutError):
                    pass
                await asyncio.sleep(0.5)
        finally:
            for task in tasks.values():
                task.cancel()
            await asyncio.gather(*tasks.values(), return_exceptions=True)

    async def task_activity(self) -> TaskActivity:
        sessions = (await self.lifecycle.store.sessions()).sessions
        tasks = len(await self.lifecycle.store.pending())
        for session in sessions:
            if not session.prepared:
                tasks += 1
            if session_database(self.lifecycle.profile.path, session.session_id).is_file():
                activity = await self.access.read(session.session_id, lambda store: store.activity())
                tasks += activity.pending
        if self.lifecycle.attached:
            supervised = await self.lifecycle.supervisor.call("GET", "/task-activity", TaskActivity)
            tasks += supervised.tasks
        else:
            for service in await self.lifecycle.store.services():
                if service.state != "stopped" and (not exited(service.process_lease)):
                    raise BackendError("activity_unavailable", status=503)
        tasks += len(self.accounts.provider_checks) + len(self.sessions.compacting)
        tasks += len(self.computer.computer_held) + len(self.integrations.mcp_signins.active)
        tasks += sum((login.view.phase == "pending" for login in self.accounts.oauth_logins.values()))
        return TaskActivity(active=tasks > 0, tasks=tasks)

    async def shutdown(self) -> None:
        self.lifecycle.closing = True
        await self.lifecycle.store.begin_quit()
        if self.background:
            self.background.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.background
        for session in (await self.lifecycle.store.sessions()).sessions:
            path = session_database(self.lifecycle.profile.path, session.session_id)
            if not path.is_file():
                continue
            snapshot = await self.access.read(session.session_id, lambda store: store.snapshot())
            if snapshot.state == "stopping" and all(
                item.kind != "root" or item.status in TERMINAL or item.cancel_requested
                for item in snapshot.requests
            ):
                continue
            async with self.access.maintenance(session.session_id, closing=True) as client:
                await client.stopping(self.lifecycle.fence)
        await self.lifecycle.stop_owned_supervisor()
        self.lifecycle.stop.set()

    async def close(self) -> None:
        self.lifecycle.closing = True
        await self.integrations.mcp_signins.close()
        await asyncio.gather(
            *(
                self.accounts.cancel_oauth(key)
                for key, login in self.accounts.oauth_logins.items()
                if login.view.phase == "pending"
            ),
            return_exceptions=True,
        )
        self.lifecycle.stop.set()
        if self.background:
            self.background.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.background
        try:
            closed = await asyncio.gather(
                *(
                    self.computer.park_driver(session, driver)
                    for session, driver in list(self.computer.computer_drivers.items())
                ),
                return_exceptions=True,
            )
            await self.lifecycle.stop_owned_supervisor()
            if any((code is None or isinstance(code, BaseException) for code in closed)):
                raise BackendError("computer_exit_unproven")
        finally:
            for _, peer in self.access.worker_peers.values():
                await peer.close()
            await self.lifecycle.supervisor.close()
            await self.lifecycle.store.db.close()
