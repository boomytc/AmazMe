from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from amazme_backend.contracts.accounts import OAuthView
from amazme_backend.contracts.mcp import McpLoginRequest
from amazme_backend.execution.mcp.auth import sign_in
from amazme_backend.host.store import HostStore
from amazme_backend.profiles.profile import Profile
from amazme_backend.shared.errors import BackendError


@dataclass
class McpLogin:
    view: OAuthView
    queue: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue[str](1))
    task: asyncio.Task[None] | None = None


class McpLogins:
    def __init__(
        self,
        profile: Profile,
        store: HostStore,
        admit: Callable[[], Awaitable[None]],
        resolve_credential: Callable[[str], Awaitable[str]],
    ):
        self.profile, self.store, self.admit = (profile, store, admit)
        self.resolve_credential = resolve_credential
        self.active: dict[str, McpLogin] = {}
        self.lock = asyncio.Lock()

    async def view(self, login_id: str) -> OAuthView:
        if login_id in self.active:
            return self.active[login_id].view
        return await self.store.mcp_login(login_id)

    async def start(self, value: McpLoginRequest) -> OAuthView:
        await self.admit()
        async with self.lock:
            for key in list(self.active):
                if self.active[key].view.phase != "pending":
                    self.active.pop(key)
            settings, launch, view = await self.store.reserve_mcp_login(
                value,
                sum((login.view.phase == "pending" for login in self.active.values())),
                any(
                    (
                        login.view.provider == value.name and login.view.phase == "pending"
                        for login in self.active.values()
                    )
                ),
            )
            if settings is None:
                return await self.view(value.login_id)
            login = McpLogin(view)
            self.active[value.login_id] = login

            async def guard() -> None:
                await self.admit()
                valid = await self.store.mcp_login_current(value.name, launch)
                if not valid:
                    raise BackendError("mcp_config_changed")

            async def publish(url: str) -> None:
                await guard()
                login.view = login.view.model_copy(update={"url": url})
                await self.save(login)

            async def run() -> None:
                try:
                    await sign_in(
                        settings,
                        self.profile,
                        value.name,
                        publish,
                        login.queue,
                        guard,
                        resolve_credential=self.resolve_credential,
                    )
                    await guard()
                    login.view.phase = "complete"
                except asyncio.CancelledError:
                    login.view.phase = "cancelled"
                except TimeoutError:
                    login.view.phase = "expired"
                except Exception as error:
                    login.view.phase = "failed" if isinstance(error, BackendError) else "unknown"
                    login.view.error = error.code if isinstance(error, BackendError) else "mcp_login_failed"
                finally:
                    login.view.url = ""
                    await self.save(login)

            login.task = asyncio.create_task(run())
            return view

    async def save(self, login: McpLogin) -> None:
        await self.store.save_mcp_login(login.view)

    async def input(self, login_id: str, text: str) -> OAuthView:
        await self.admit()
        login = self.active.get(login_id)
        if login is None or login.view.phase != "pending" or login.queue.full():
            raise BackendError("mcp_login_inactive")
        login.queue.put_nowait(text)
        return login.view

    async def cancel(self, login_id: str) -> OAuthView:
        login = self.active.get(login_id)
        if login and login.view.phase == "pending" and login.task:
            login.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await login.task
            if login.view.phase == "pending":
                login.view.phase, login.view.url = ("cancelled", "")
                await self.save(login)
        view = await self.view(login_id)
        if login is None and view.phase == "unknown":
            view = view.model_copy(update={"phase": "cancelled", "url": ""})
            await self.store.save_mcp_login(view)
        return view

    async def close(self) -> None:
        await asyncio.gather(*(self.cancel(key) for key in list(self.active)), return_exceptions=True)
