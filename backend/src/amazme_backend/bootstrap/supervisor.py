"""Assemble product callbacks and run the single supervisor service."""

from __future__ import annotations

import asyncio

import uvicorn

from amazme_backend.contracts.execution import ProcessLease
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.mcp import McpOffer
from amazme_backend.contracts.plugins import PluginOffer
from amazme_backend.contracts.sessions import RunOptions
from amazme_backend.execution.dependencies import ExecutionQueries
from amazme_backend.execution.supervisor import Supervisor
from amazme_backend.interfaces.supervisor import application
from amazme_backend.platform.ipc import unix_listener
from amazme_backend.platform.private_files import lock
from amazme_backend.profiles.profile import Profile


def create_supervisor(profile: Profile, instance: str | None = None, process_lease: ProcessLease | None = None,
                      *, queries: ExecutionQueries | None = None, require_existing: bool = False) -> Supervisor:
    from amazme_backend.agent.tool_catalog import build_tools
    from amazme_backend.host.queries import HostQueries
    from amazme_backend.sessions.domain import resolve_model_call

    if queries is None:
        host = HostQueries(profile.path)
        queries = ExecutionQueries(host.session_workspace, host.workspace_grants, host.mcp_policy, host.branch_pending)

    def definitions(offers: list[McpOffer], options: RunOptions, plugins: list[PluginOffer]) -> list[dict[str, object]]:
        return [tool.model_dump(mode="json") for tool in build_tools(offers, options, plugins, codemode=False)]

    return Supervisor(profile, instance, process_lease, queries=queries, code_tool_definitions=definitions,
                      resolve_model_call=resolve_model_call, require_existing=require_existing)


async def serve(profile: Profile, instance: str | None = None, process_lease: ProcessLease | None = None,
                *, queries: ExecutionQueries | None = None, require_existing: bool = False) -> None:
    with lock(profile.path / "supervisor.lock"):
        owner = create_supervisor(profile, instance, process_lease, queries=queries, require_existing=require_existing)
        stop = asyncio.Event()
        try:
            await owner.initialize()
            listener = unix_listener(profile.socket("supervisor"))
            server = uvicorn.Server(uvicorn.Config(application(owner, stop), log_level="error", access_log=False,
                                                  timeout_graceful_shutdown=5))
            async def watch() -> None:
                await stop.wait()
                server.should_exit = True
            watcher = asyncio.create_task(watch())
            try:
                await server.serve(sockets=[listener])
            finally:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)
                listener.close()
        finally:
            if owner.monitor_task:
                owner.monitor_task.cancel()
                await asyncio.gather(owner.monitor_task, return_exceptions=True)
            try:
                if owner.registered and not stop.is_set():
                    await owner.shutdown(HostFence(host_epoch=owner.host_epoch, build_id=owner.build))
            finally:
                await owner.close()
