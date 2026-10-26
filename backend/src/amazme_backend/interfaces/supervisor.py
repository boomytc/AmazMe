"""Private supervisor HTTP adapter. All operations remain owned by Supervisor."""

from __future__ import annotations

import asyncio

from fastapi import FastAPI

from amazme_backend.contracts.execution import (
    Cleanup,
    Lease,
    SupervisorHealth,
)
from amazme_backend.contracts.identity import HostFence, Identity
from amazme_backend.contracts.ipc.supervisor import (
    McpCallEnvelope,
    McpDecisionEnvelope,
    RetireSupervisor,
    SubmitRemote,
)
from amazme_backend.contracts.mcp import McpCall
from amazme_backend.contracts.remote import RemoteCallRequest, RemoteCallView
from amazme_backend.execution.supervisor import Supervisor
from amazme_backend.interfaces.http.transport import CONFIG_BODY_BYTES, app_factory


def application(owner: Supervisor, server_stop: asyncio.Event) -> FastAPI:
    app = app_factory(owner.profile.token, body_limits={r"/mcp/open": CONFIG_BODY_BYTES, r"/code/(?:start|run)": CONFIG_BODY_BYTES})

    @app.get("/identity")
    async def identity() -> Identity:
        return owner.identity()

    app.get("/task-activity")(owner.task_activity)
    app.post("/takeover")(owner.takeover)
    app.post("/workers/ensure")(owner.ensure_worker)
    app.post("/workers/heartbeat")(owner.heartbeat)
    app.post("/workers/stop")(owner.stop_worker)
    app.post("/sessions/retire")(owner.retire_session)
    app.post("/epochs/open")(owner.open_epoch)

    @app.post("/epochs/close")
    async def close(value: Lease) -> Cleanup:
        return await owner.cleanup(value.session_id, value)

    app.post("/pty/open")(owner.pty.open)
    app.post("/pty/input")(owner.pty.write)
    app.post("/pty/resize")(owner.pty.resize)
    app.post("/pty/read")(owner.pty.read)
    app.post("/pty/list")(owner.pty.list)
    app.post("/pty/close")(owner.pty.close)
    app.post("/mcp/open")(owner.mcp.open)
    app.post("/mcp/cancel")(owner.mcp.cancel)
    app.post("/mcp/state")(owner.mcp.state)
    app.post("/mcp/query")(owner.mcp.query)
    app.post("/code/run")(owner.code.run)
    app.post("/code/start")(owner.code.start)
    app.post("/code/status")(owner.code.status)
    app.get("/code/tools")(owner.code.tools)
    app.post("/code/tools/bind")(owner.code.bind_tool)
    app.post("/code/cancel")(owner.code.cancel)
    app.get("/plugins")(owner.plugins.list)
    app.post("/plugins/register")(owner.plugins.register)
    app.post("/plugins/reload")(owner.plugins.reload)
    app.post("/plugins/call")(owner.plugins.call)
    app.post("/plugins/cancel")(owner.plugins.cancel)
    app.post("/plugins/close")(owner.plugins.close)
    app.post("/plugins/remove")(owner.plugins.remove)
    app.post("/remotes/open")(owner.remote.open)
    app.post("/remotes/reconnect")(owner.remote.reconnect)
    app.post("/remotes/disconnect")(owner.remote.disconnect)

    @app.post("/remotes/calls")
    async def remote_call(value: SubmitRemote) -> RemoteCallView:
        return await owner.remote.submit(value, RemoteCallRequest(call_id=value.call_id, command=value.command))

    @app.post("/mcp/calls")
    async def mcp_call(value: McpCallEnvelope) -> McpCall:
        return await owner.mcp.request_call(value.session_id, value.server_id, value.call, value)

    @app.post("/mcp/decision")
    async def mcp_decision(value: McpDecisionEnvelope) -> McpCall:
        return await owner.mcp.decide_call(value.session_id, value.server_id, value.call_id, value.decision, value)

    app.post("/mcp/lookup")(owner.mcp.lookup_call)
    app.post("/mcp/calls/cancel")(owner.mcp.cancel_call)
    app.post("/tools/run")(owner.invocations.run)
    app.post("/tools/lookup")(owner.invocations.lookup)
    app.post("/jobs/list")(owner.invocations.list_jobs)
    app.post("/jobs/output")(owner.invocations.job_output)
    app.post("/jobs/kill")(owner.invocations.kill_job)
    app.post("/jobs/notices")(owner.invocations.pending_job_notices)
    app.post("/jobs/notices/ack")(owner.invocations.acknowledge_job_notice)
    app.post("/effects/resolve")(owner.resolve_effect)
    app.get("/health")(owner.health)
    app.post("/freeze")(owner.freeze)
    app.post("/thaw")(owner.thaw)
    app.post("/recover")(owner.recover)

    @app.post("/shutdown")
    async def shutdown(value: HostFence) -> Identity:
        try:
            return await owner.shutdown(value)
        finally:
            server_stop.set()

    @app.post("/retire")
    async def retire(value: RetireSupervisor) -> SupervisorHealth:
        result = await owner.retire(value)
        server_stop.set()
        return result

    return app
