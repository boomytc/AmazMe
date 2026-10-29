from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import TypedDict

import amazme_backend.features.plugins.packages as plugin_packages
from amazme_backend.contracts.accounts import OAuthInput, OAuthView
from amazme_backend.contracts.code import CodeRun, CodeTools, CodeView
from amazme_backend.contracts.execution import (
    TerminalList,
    TerminalOpen,
    TerminalSize,
    TerminalType,
    TerminalView,
)
from amazme_backend.contracts.ipc.supervisor import (
    CancelCode,
    CancelPlugin,
    ClosePlugin,
    McpCallEnvelope,
    McpDecisionEnvelope,
    McpQuery,
    McpSession,
    OpenCode,
    OpenMcp,
    OpenPlugin,
    OpenRemote,
    OpenTerminal,
    PluginCallEnvelope,
    ReloadPlugin,
    SubmitRemote,
    TerminalInput,
    TerminalQuery,
    TerminalResize,
    TerminalSession,
)
from amazme_backend.contracts.mcp import (
    McpCall,
    McpCallRequest,
    McpConfigPatch,
    McpConfiguration,
    McpConfigWrite,
    McpDecision,
    McpLoginRequest,
    McpOpen,
    McpReconnect,
    McpState,
    McpStdioSettings,
    McpView,
)
from amazme_backend.contracts.plugins import (
    PluginCallRequest,
    PluginCallView,
    PluginDraft,
    PluginList,
    PluginPackageAdd,
    PluginPackageRemove,
    PluginPackages,
    PluginReload,
    PluginView,
)
from amazme_backend.contracts.remote import (
    RemoteCallView,
    RemoteHostKey,
    RemoteHostKeys,
    RemoteKeyScan,
    RemoteOpen,
    RemoteRun,
    RemoteView,
)
from amazme_backend.execution.plugins.client import entry_digest
from amazme_backend.execution.remote.client import daemon_identity
from amazme_backend.execution.remote.ssh import scan_host_key
from amazme_backend.features.management.rules import contains_secret
from amazme_backend.host.accounts import AccountOperations
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.host.mcp_logins import McpLogins
from amazme_backend.host.persistence import mcp as mcp_management
from amazme_backend.profiles.layout import session_database
from amazme_backend.sessions.service import TERMINAL, read_session
from amazme_backend.shared.errors import BackendError

KIMI_CU_COMMAND = "/Applications/KimiCU.app/Contents/MacOS/kimi-cu"
KIMI_CU_BINARY = Path(KIMI_CU_COMMAND)


def _kimi_cu_ready(item: mcp_management.Configured) -> bool:
    if isinstance(item.settings, McpStdioSettings) and item.settings.command == KIMI_CU_COMMAND:
        return sys.platform == "darwin" and KIMI_CU_BINARY.is_file() and os.access(KIMI_CU_BINARY, os.X_OK)
    return True


class McpFence(TypedDict):
    host_epoch: int
    build_id: str
    session_id: str


class IntegrationOperations:
    def __init__(self, accounts: AccountOperations, lifecycle: HostLifecycle):
        self.accounts = accounts
        self.lifecycle = lifecycle
        self.package_lock = asyncio.Lock()
        self.mcp_lock = asyncio.Lock()
        self.mcp_signins = McpLogins(
            lifecycle.profile, lifecycle.store, accounts.write_guard, accounts.accounts.resolve_token
        )

    def _terminal_fence(self, session_id: str, terminal_id: str) -> TerminalQuery:
        return TerminalQuery(
            host_epoch=self.lifecycle.fence.host_epoch,
            build_id=self.lifecycle.build,
            session_id=session_id,
            terminal_id=terminal_id,
        )

    async def open_terminal(self, session_id: str, value: TerminalOpen) -> TerminalView:
        self.lifecycle.admit()
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        await self.lifecycle.require_session(session_id)
        return await self.lifecycle.supervisor.call(
            "POST",
            "/pty/open",
            TerminalView,
            OpenTerminal(
                host_epoch=self.lifecycle.fence.host_epoch,
                build_id=self.lifecycle.build,
                session_id=session_id,
                terminal_id=value.terminal_id,
                command=value.command,
                cols=value.cols,
                rows=value.rows,
                workspace=value.workspace,
            ),
        )

    async def type_terminal(self, session_id: str, terminal_id: str, value: TerminalType) -> TerminalView:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session_id)
        return await self.lifecycle.supervisor.call(
            "POST",
            "/pty/input",
            TerminalView,
            TerminalInput(
                **self._terminal_fence(session_id, terminal_id).model_dump(),
                input_id=value.input_id,
                data=value.data,
            ),
        )

    async def resize_terminal(self, session_id: str, terminal_id: str, value: TerminalSize) -> TerminalView:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session_id)
        return await self.lifecycle.supervisor.call(
            "POST",
            "/pty/resize",
            TerminalView,
            TerminalResize(
                **self._terminal_fence(session_id, terminal_id).model_dump(), cols=value.cols, rows=value.rows
            ),
        )

    async def read_terminal(self, session_id: str, terminal_id: str) -> TerminalView:
        self.lifecycle.admit()
        return await self.lifecycle.supervisor.call(
            "POST", "/pty/read", TerminalView, self._terminal_fence(session_id, terminal_id)
        )

    async def list_terminals(self, session_id: str) -> TerminalList:
        self.lifecycle.admit()
        return await self.lifecycle.supervisor.call(
            "POST",
            "/pty/list",
            TerminalList,
            TerminalSession(
                host_epoch=self.lifecycle.fence.host_epoch,
                build_id=self.lifecycle.build,
                session_id=session_id,
            ),
        )

    async def close_terminal(self, session_id: str, terminal_id: str) -> TerminalView:
        self.lifecycle.admit()
        return await self.lifecycle.supervisor.call(
            "POST", "/pty/close", TerminalView, self._terminal_fence(session_id, terminal_id)
        )

    def _mcp_fence(self, session_id: str) -> McpFence:
        return {
            "host_epoch": self.lifecycle.fence.host_epoch,
            "build_id": self.lifecycle.build,
            "session_id": session_id,
        }

    async def mcp_configuration(self, session: str) -> McpConfiguration:
        self.lifecycle.admit()
        workspace = ""
        if session:
            await self.lifecycle.require_session(session)
            value = await self.lifecycle.store.session(session)
            assert value is not None
            workspace = value.workspace
        return await self.lifecycle.store.mcp_configuration(workspace)

    async def change_mcp_configuration(
        self, session: str, value: McpConfigWrite | McpConfigPatch
    ) -> McpConfiguration:
        self.lifecycle.admit()
        workspace = ""
        if session:
            await self.lifecycle.require_session(session)
            target = await self.lifecycle.store.session(session)
            assert target is not None
            workspace = target.workspace
            await self.lifecycle.require_workspace(workspace)
        async with self.mcp_lock:
            result = await self.lifecycle.store.change_mcp_configuration(value, workspace)
        sessions = [
            selected for selected in (await self.lifecycle.store.sessions()).sessions if not selected.archived
        ]
        if not sessions:
            return result
        await self.lifecycle.ensure_supervisor()
        try:
            for selected in sessions:
                if (
                    selected.workspace == workspace
                    or not isinstance(value, McpConfigPatch)
                    or value.scope == "global"
                ):
                    await self.sync_mcp_configuration(
                        selected.session_id, connect=selected.session_id == session
                    )
        except BackendError as error:
            raise BackendError("mcp_config_apply_pending", error.code, status=503) from error
        return result

    async def sync_mcp_configuration(self, session: str, *, connect: bool = True) -> McpState:
        async with self.mcp_lock:
            target = await self.lifecycle.store.session(session)
            if target is None:
                raise BackendError("session_not_found", status=404)
            configured = await self.lifecycle.store.effective_mcp_configuration(target.workspace)
            ids = {
                item.config_id: await self.lifecycle.store.current_mcp_server(item, session)
                for item in configured
                if item.settings.enabled and _kimi_cu_ready(item)
            }
            state = await self.mcp_state(session)
            for server in state.servers:
                if (
                    server.managed_id
                    and ids.get(server.managed_id) != server.server_id
                    and (not server.clean)
                ):
                    stopped = await self.cancel_mcp(session, server.server_id)
                    if not stopped.clean:
                        raise BackendError("execution_cleanup_pending", status=503)
            known = {server.server_id for server in state.servers}
            if connect:
                for item in configured:
                    server_id = ids.get(item.config_id)
                    if server_id and server_id not in known:
                        await self.open_mcp(
                            session,
                            McpOpen(
                                server_id=server_id,
                                **mcp_management.launch(item, target.workspace).model_dump(),
                            ),
                        )
            return await self.mcp_state(session)

    async def reconnect_mcp(self, session: str, value: McpReconnect) -> McpView:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session)
        target = await self.lifecycle.store.session(session)
        assert target is not None
        async with self.mcp_lock:
            launch = await self.lifecycle.store.reserve_mcp_reconnect(session, target.workspace, value)
        await self.lifecycle.ensure_supervisor()
        await self.sync_mcp_configuration(session, connect=False)
        config = await self.mcp_configuration(session)
        item = next((item for item in config.servers if item.name == value.name and item.enabled), None)
        current = await self.lifecycle.store.latest_mcp_reconnect(
            session, value.name, item.launch_id if item else ""
        )
        if current == launch.server_id:
            return await self.open_mcp(session, launch)
        return await self.lifecycle.supervisor.call(
            "POST",
            "/mcp/query",
            McpView,
            McpQuery(**self.lifecycle.fence.model_dump(), session_id=session, server_id=launch.server_id),
        )

    async def reload_mcp_configuration(self, session: str) -> McpState:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session)
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        await self.lifecycle.ensure_supervisor()
        return await self.sync_mcp_configuration(session)

    async def open_mcp(self, session_id: str, value: McpOpen) -> McpView:
        self.lifecycle.admit()
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        await self.lifecycle.require_session(session_id)
        return await self.lifecycle.supervisor.call(
            "POST", "/mcp/open", McpView, OpenMcp(**self._mcp_fence(session_id), **value.model_dump())
        )

    async def mcp_state(self, session_id: str) -> McpState:
        self.lifecycle.admit()
        return await self.lifecycle.supervisor.call(
            "POST",
            "/mcp/state",
            McpState,
            McpSession(
                build_id=self.lifecycle.build,
                host_epoch=self.lifecycle.fence.host_epoch,
                session_id=session_id,
            ),
        )

    async def request_mcp(self, session_id: str, server_id: str, value: McpCallRequest) -> McpCall:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session_id)
        return await self.lifecycle.supervisor.call(
            "POST",
            "/mcp/calls",
            McpCall,
            McpCallEnvelope(**self._mcp_fence(session_id), server_id=server_id, call=value),
        )

    async def decide_mcp(self, session_id: str, server_id: str, call_id: str, value: McpDecision) -> McpCall:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session_id)
        return await self.lifecycle.supervisor.call(
            "POST",
            "/mcp/decision",
            McpCall,
            McpDecisionEnvelope(
                **self._mcp_fence(session_id), server_id=server_id, call_id=call_id, decision=value
            ),
        )

    def _remote_body(self, session_id: str, value: RemoteOpen) -> OpenRemote:
        return OpenRemote(
            host_epoch=self.lifecycle.fence.host_epoch,
            build_id=self.lifecycle.build,
            session_id=session_id,
            **value.model_dump(include=set(RemoteOpen.model_fields)),
            daemon_id=daemon_identity(),
        )

    async def code_tools(self, session_id: str) -> CodeTools:
        await self.lifecycle.require_session(session_id)
        return await self.lifecycle.supervisor.call("GET", "/code/tools?session_id=" + session_id, CodeTools)

    async def run_code(self, session_id: str, value: CodeRun) -> CodeView:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session_id)
        frozen = await self.lifecycle.update_matches_supervisor()
        try:
            return await self.lifecycle.supervisor.call(
                "POST",
                "/code/run",
                CodeView,
                OpenCode(
                    host_epoch=self.lifecycle.fence.host_epoch,
                    build_id=self.lifecycle.build,
                    session_id=session_id,
                    run_id=value.run_id,
                    source=value.source,
                ),
            )
        except BackendError as error:
            self.lifecycle.stored_during_update(frozen, error)

    async def cancel_code(self, session_id: str, run_id: str) -> CodeView:
        self.lifecycle.admit()
        return await self.lifecycle.supervisor.call(
            "POST",
            "/code/cancel",
            CodeView,
            CancelCode(
                host_epoch=self.lifecycle.fence.host_epoch,
                build_id=self.lifecycle.build,
                session_id=session_id,
                run_id=run_id,
            ),
        )

    async def scan_remote_key(self, session_id: str, value: RemoteKeyScan) -> RemoteHostKeys:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session_id)
        keys = await asyncio.to_thread(scan_host_key, value, "amazme-remote-" + value.remote_id)
        return RemoteHostKeys(
            keys=[RemoteHostKey(line=line, fingerprint=fingerprint) for line, fingerprint in keys]
        )

    async def open_remote(self, session_id: str, value: RemoteOpen) -> RemoteView:
        self.lifecycle.admit()
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        await self.lifecycle.require_session(session_id)
        return await self.lifecycle.supervisor.call(
            "POST", "/remotes/open", RemoteView, self._remote_body(session_id, value)
        )

    async def reconnect_remote(self, session_id: str, value: RemoteOpen) -> RemoteView:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session_id)
        return await self.lifecycle.supervisor.call(
            "POST", "/remotes/reconnect", RemoteView, self._remote_body(session_id, value)
        )

    async def disconnect_remote(self, session_id: str, value: RemoteOpen) -> RemoteView:
        self.lifecycle.admit()
        return await self.lifecycle.supervisor.call(
            "POST", "/remotes/disconnect", RemoteView, self._remote_body(session_id, value)
        )

    async def submit_remote(self, session_id: str, value: RemoteRun) -> RemoteCallView:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session_id)
        body = self._remote_body(session_id, value)
        return await self.lifecycle.supervisor.call(
            "POST",
            "/remotes/calls",
            RemoteCallView,
            SubmitRemote(**body.model_dump(), call_id=value.call_id, command=value.command),
        )

    async def cancel_mcp(self, session_id: str, server_id: str) -> McpView:
        self.lifecycle.admit()
        return await self.lifecycle.supervisor.call(
            "POST",
            "/mcp/cancel",
            McpView,
            McpQuery(
                build_id=self.lifecycle.build,
                host_epoch=self.lifecycle.fence.host_epoch,
                session_id=session_id,
                server_id=server_id,
            ),
        )

    async def start_mcp_oauth(self, value: McpLoginRequest) -> OAuthView:
        return await self.mcp_signins.start(value)

    async def mcp_oauth_view(self, login_id: str) -> OAuthView:
        return await self.mcp_signins.view(login_id)

    async def mcp_oauth_input(self, login_id: str, value: OAuthInput) -> OAuthView:
        return await self.mcp_signins.input(login_id, value.value.get_secret_value())

    async def cancel_mcp_oauth(self, login_id: str) -> OAuthView:
        await self.accounts.write_guard()
        return await self.mcp_signins.cancel(login_id)

    async def _plugin_work_pending(self, session_id: str) -> bool:
        for session in (await self.lifecycle.store.sessions()).sessions:
            if session.session_id != session_id:
                continue
            path = session_database(self.lifecycle.profile.path, session.session_id)
            if not path.is_file():
                continue
            async with read_session(path, session.session_id, build=self.lifecycle.build) as store:
                snapshot = await store.snapshot()
            if any((item.status not in TERMINAL for item in snapshot.requests)):
                return True
        return False

    async def plugin_packages(self) -> PluginPackages:
        return await self.lifecycle.store.plugin_packages()

    async def add_plugin_package(self, value: PluginPackageAdd) -> PluginPackages:
        self.lifecycle.admit()
        async with self.package_lock:
            previous = await self.lifecycle.store.existing_plugin_package(value)
            if previous is not None:
                return previous
            path = Path(value.entry).expanduser()
            if path.is_dir():
                path /= "extension.py"
            if contains_secret(value.entry, self.accounts.secrets()):
                raise BackendError("plugin_secret")
            entry, _digest = await asyncio.to_thread(entry_digest, str(path))
            return await self.lifecycle.store.add_plugin_package(value, entry)

    async def remove_plugin_package(self, package_id: str, value: PluginPackageRemove) -> PluginPackages:
        self.lifecycle.admit()
        async with self.package_lock:
            package = await self.lifecycle.store.begin_plugin_removal(package_id, value.expected_revision)
            if package.phase == "removed":
                return await self.plugin_packages()
            await self.lifecycle.ensure_supervisor()
            for plugin in (await self.plugins()).plugins:
                if plugin.plugin_id == plugin_packages.plugin_identity(package_id, plugin.session_id):
                    await self.lifecycle.supervisor.call(
                        "POST",
                        "/plugins/remove",
                        PluginView,
                        ClosePlugin(
                            **self.lifecycle.fence.model_dump(),
                            session_id=plugin.session_id,
                            plugin_id=plugin.plugin_id,
                        ),
                    )
            return await self.lifecycle.store.finish_plugin_removal(package_id)

    async def sync_plugin_packages(self, session: str) -> None:
        async with self.package_lock:
            state = await self.plugin_packages()
            if not state.packages:
                return
            running = {item.plugin_id for item in (await self.plugins(session)).plugins}
            for package in state.packages:
                plugin_id = plugin_packages.plugin_identity(package.package_id, session)
                if package.phase == "installed" and plugin_id not in running:
                    await self.lifecycle.supervisor.call(
                        "POST",
                        "/plugins/register",
                        PluginView,
                        OpenPlugin(
                            **self.lifecycle.fence.model_dump(),
                            session_id=session,
                            plugin_id=plugin_id,
                            name="package-" + package.package_id[:12],
                            entry=package.entry,
                        ),
                    )
                elif package.phase == "removing" and plugin_id in running:
                    await self.lifecycle.supervisor.call(
                        "POST",
                        "/plugins/remove",
                        PluginView,
                        ClosePlugin(
                            **self.lifecycle.fence.model_dump(), session_id=session, plugin_id=plugin_id
                        ),
                    )

    async def plugins(self, session_id: str = "") -> PluginList:
        if session_id:
            await self.lifecycle.require_session(session_id)
        result = await self.lifecycle.supervisor.call(
            "GET", "/plugins" + ("?session_id=" + session_id if session_id else ""), PluginList
        )
        packages = (await self.plugin_packages()).packages
        for plugin in result.plugins:
            plugin.package_id = next(
                (
                    package.package_id
                    for package in packages
                    if plugin.plugin_id
                    == plugin_packages.plugin_identity(package.package_id, plugin.session_id)
                ),
                "",
            )
        return result

    async def load_plugin_packages(self, session: str) -> PluginList:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session)
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        await self.lifecycle.ensure_supervisor()
        await self.sync_plugin_packages(session)
        return await self.plugins(session)

    async def register_plugin(self, value: PluginDraft) -> PluginView:
        self.lifecycle.admit()
        if contains_secret(value.model_dump_json(), self.accounts.secrets()):
            raise BackendError("plugin_secret")
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        await self.lifecycle.require_session(value.session_id)
        if await self._plugin_work_pending(value.session_id):
            raise BackendError("plugin_reload_blocked", status=409)
        return await self.lifecycle.supervisor.call(
            "POST",
            "/plugins/register",
            PluginView,
            OpenPlugin(
                host_epoch=self.lifecycle.fence.host_epoch,
                build_id=self.lifecycle.build,
                plugin_id=value.plugin_id,
                name=value.name,
                entry=value.entry,
                session_id=value.session_id,
                config=value.config,
            ),
        )

    async def reload_plugin(self, plugin_id: str, value: PluginReload) -> PluginView:
        self.lifecycle.admit()
        if contains_secret(value.model_dump_json(), self.accounts.secrets()):
            raise BackendError("plugin_secret")
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        await self.lifecycle.require_session(value.session_id)
        if await self._plugin_work_pending(value.session_id):
            raise BackendError("plugin_reload_blocked", status=409)
        return await self.lifecycle.supervisor.call(
            "POST",
            "/plugins/reload",
            PluginView,
            ReloadPlugin(
                host_epoch=self.lifecycle.fence.host_epoch,
                build_id=self.lifecycle.build,
                plugin_id=plugin_id,
                reload_id=value.reload_id,
                session_id=value.session_id,
                entry=value.entry,
                config=value.config,
            ),
        )

    async def call_plugin(self, session_id: str, plugin_id: str, value: PluginCallRequest) -> PluginCallView:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session_id)
        session = next(
            (
                item
                for item in (await self.lifecycle.store.sessions()).sessions
                if item.session_id == session_id
            )
        )
        frozen = await self.lifecycle.update_matches_supervisor()
        if contains_secret(value.model_dump_json(), self.accounts.secrets()):
            raise BackendError("plugin_secret")
        try:
            return await self.lifecycle.supervisor.call(
                "POST",
                "/plugins/call",
                PluginCallView,
                PluginCallEnvelope(
                    host_epoch=self.lifecycle.fence.host_epoch,
                    build_id=self.lifecycle.build,
                    session_id=session_id,
                    plugin_id=plugin_id,
                    call_id=value.call_id,
                    name=value.name,
                    arguments=value.arguments,
                    kind=value.kind,
                    expected_fingerprint=value.expected_fingerprint,
                    expected_load_id=value.expected_load_id,
                    workspace=session.workspace,
                ),
            )
        except BackendError as error:
            self.lifecycle.stored_during_update(frozen, error)

    async def close_plugin(self, session_id: str, plugin_id: str) -> PluginView:
        await self.lifecycle.require_session(session_id)
        return await self.lifecycle.supervisor.call(
            "POST",
            "/plugins/close",
            PluginView,
            ClosePlugin(
                host_epoch=self.lifecycle.fence.host_epoch,
                build_id=self.lifecycle.build,
                session_id=session_id,
                plugin_id=plugin_id,
            ),
        )

    async def cancel_plugin(self, session_id: str, plugin_id: str, call_id: str) -> PluginCallView:
        await self.lifecycle.require_session(session_id)
        return await self.lifecycle.supervisor.call(
            "POST",
            "/plugins/cancel",
            PluginCallView,
            CancelPlugin(
                host_epoch=self.lifecycle.fence.host_epoch,
                build_id=self.lifecycle.build,
                session_id=session_id,
                plugin_id=plugin_id,
                call_id=call_id,
            ),
        )
