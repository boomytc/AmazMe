"""Typed client for the existing supervisor IPC protocol."""

from __future__ import annotations

from urllib.parse import urlencode

from amazme_backend.contracts.code import CodeTools, CodeView
from amazme_backend.contracts.execution import (
    Cleanup,
    EffectHold,
    Lease,
    SupervisorHealth,
    TerminalList,
    TerminalView,
    ToolObservation,
    ToolResult,
    WorkerInfo,
)
from amazme_backend.contracts.identity import HostFence, Identity
from amazme_backend.contracts.ipc.host import CodeToolBinding, CodeToolDispatch
from amazme_backend.contracts.ipc.supervisor import (
    CancelCode,
    CancelPlugin,
    ClosePlugin,
    CodeStatus,
    FreezeSupervisor,
    McpCallEnvelope,
    McpCallRef,
    McpDecisionEnvelope,
    McpQuery,
    McpSession,
    OpenCode,
    OpenMcp,
    OpenPlugin,
    OpenRemote,
    OpenTerminal,
    PluginCallEnvelope,
    Recovery,
    ReloadPlugin,
    ResolveEffect,
    RetireSupervisor,
    RunTool,
    StopWorker,
    SubmitRemote,
    TaskActivity,
    TerminalInput,
    TerminalQuery,
    TerminalResize,
    TerminalSession,
    ToolLookup,
    WorkerRequest,
    WorkerSpec,
)
from amazme_backend.contracts.mcp import McpCall, McpState, McpView
from amazme_backend.contracts.plugins import (
    PluginCallView,
    PluginList,
    PluginView,
)
from amazme_backend.contracts.remote import RemoteCallView, RemoteView
from amazme_backend.platform.ipc import Peer


class SupervisorClient(Peer):
    async def identity(self) -> Identity:
        return await self.call("GET", "/identity", Identity)

    async def task_activity(self) -> TaskActivity:
        return await self.call("GET", "/task-activity", TaskActivity)

    async def takeover(self, value: HostFence) -> Identity:
        return await self.call("POST", "/takeover", Identity, value)

    async def ensure_worker(self, value: WorkerSpec) -> WorkerInfo:
        return await self.call("POST", "/workers/ensure", WorkerInfo, value)

    async def heartbeat(self, value: WorkerRequest) -> Identity:
        return await self.call("POST", "/workers/heartbeat", Identity, value)

    async def stop_worker(self, value: StopWorker) -> Cleanup:
        return await self.call("POST", "/workers/stop", Cleanup, value)

    async def retire_session(self, value: TerminalSession) -> Cleanup:
        return await self.call("POST", "/sessions/retire", Cleanup, value)

    async def open_epoch(self, value: WorkerRequest) -> Lease:
        return await self.call("POST", "/epochs/open", Lease, value)

    async def cleanup(self, value: Lease) -> Cleanup:
        return await self.call("POST", "/epochs/close", Cleanup, value)

    async def open_terminal(self, value: OpenTerminal) -> TerminalView:
        return await self.call("POST", "/pty/open", TerminalView, value)

    async def write_terminal(self, value: TerminalInput) -> TerminalView:
        return await self.call("POST", "/pty/input", TerminalView, value)

    async def resize_terminal(self, value: TerminalResize) -> TerminalView:
        return await self.call("POST", "/pty/resize", TerminalView, value)

    async def read_terminal(self, value: TerminalQuery) -> TerminalView:
        return await self.call("POST", "/pty/read", TerminalView, value)

    async def list_terminals(self, value: TerminalSession) -> TerminalList:
        return await self.call("POST", "/pty/list", TerminalList, value)

    async def close_terminal(self, value: TerminalQuery) -> TerminalView:
        return await self.call("POST", "/pty/close", TerminalView, value)

    async def open_mcp(self, value: OpenMcp) -> McpView:
        return await self.call("POST", "/mcp/open", McpView, value)

    async def cancel_mcp(self, value: McpQuery) -> McpView:
        return await self.call("POST", "/mcp/cancel", McpView, value)

    async def mcp_state(self, value: McpSession) -> McpState:
        return await self.call("POST", "/mcp/state", McpState, value)

    async def query_mcp(self, value: McpQuery) -> McpView:
        return await self.call("POST", "/mcp/query", McpView, value)

    async def request_mcp_call(self, value: McpCallEnvelope) -> McpCall:
        return await self.call("POST", "/mcp/calls", McpCall, value)

    async def decide_mcp_call(self, value: McpDecisionEnvelope) -> McpCall:
        return await self.call("POST", "/mcp/decision", McpCall, value)

    async def lookup_mcp_call(self, value: McpCallRef) -> McpCall:
        return await self.call("POST", "/mcp/lookup", McpCall, value)

    async def cancel_mcp_call(self, value: McpCallRef) -> McpCall:
        return await self.call("POST", "/mcp/calls/cancel", McpCall, value)

    async def run_code(self, value: OpenCode) -> CodeView:
        return await self.call("POST", "/code/run", CodeView, value)

    async def start_code(self, value: OpenCode) -> CodeStatus:
        return await self.call("POST", "/code/start", CodeStatus, value)

    async def code_status(self, value: CancelCode) -> CodeStatus:
        return await self.call("POST", "/code/status", CodeStatus, value)

    async def bind_code_tool(self, value: CodeToolDispatch) -> CodeToolBinding:
        return await self.call("POST", "/code/tools/bind", CodeToolBinding, value)

    async def cancel_code(self, value: CancelCode) -> CodeView:
        return await self.call("POST", "/code/cancel", CodeView, value)

    async def register_plugin(self, value: OpenPlugin) -> PluginView:
        return await self.call("POST", "/plugins/register", PluginView, value)

    async def reload_plugin(self, value: ReloadPlugin) -> PluginView:
        return await self.call("POST", "/plugins/reload", PluginView, value)

    async def call_plugin(self, value: PluginCallEnvelope) -> PluginCallView:
        return await self.call("POST", "/plugins/call", PluginCallView, value)

    async def cancel_plugin(self, value: CancelPlugin) -> PluginCallView:
        return await self.call("POST", "/plugins/cancel", PluginCallView, value)

    async def close_plugin(self, value: ClosePlugin) -> PluginView:
        return await self.call("POST", "/plugins/close", PluginView, value)

    async def remove_plugin(self, value: ClosePlugin) -> PluginView:
        return await self.call("POST", "/plugins/remove", PluginView, value)

    async def open_remote(self, value: OpenRemote) -> RemoteView:
        return await self.call("POST", "/remotes/open", RemoteView, value)

    async def reconnect_remote(self, value: OpenRemote) -> RemoteView:
        return await self.call("POST", "/remotes/reconnect", RemoteView, value)

    async def disconnect_remote(self, value: OpenRemote) -> RemoteView:
        return await self.call("POST", "/remotes/disconnect", RemoteView, value)

    async def submit_remote(self, value: SubmitRemote) -> RemoteCallView:
        return await self.call("POST", "/remotes/calls", RemoteCallView, value)

    async def run_tool(self, value: RunTool) -> ToolResult:
        return await self.call("POST", "/tools/run", ToolResult, value)

    async def lookup_tool(self, value: ToolLookup) -> ToolObservation:
        return await self.call("POST", "/tools/lookup", ToolObservation, value)

    async def resolve_effect(self, value: ResolveEffect) -> EffectHold:
        return await self.call("POST", "/effects/resolve", EffectHold, value)

    async def health(self) -> SupervisorHealth:
        return await self.call("GET", "/health", SupervisorHealth)

    async def freeze(self, value: FreezeSupervisor) -> SupervisorHealth:
        return await self.call("POST", "/freeze", SupervisorHealth, value)

    async def thaw(self, value: FreezeSupervisor) -> SupervisorHealth:
        return await self.call("POST", "/thaw", SupervisorHealth, value)

    async def recover(self, value: Recovery) -> SupervisorHealth:
        return await self.call("POST", "/recover", SupervisorHealth, value)

    async def shutdown(self, value: HostFence) -> Identity:
        return await self.call("POST", "/shutdown", Identity, value)

    async def retire(self, value: RetireSupervisor) -> SupervisorHealth:
        return await self.call("POST", "/retire", SupervisorHealth, value)

    async def list_plugins(self, session_id: str = "") -> PluginList:
        query = "?" + urlencode({"session_id": session_id}) if session_id else ""
        return await self.call("GET", "/plugins" + query, PluginList)

    async def code_tools(self, session_id: str) -> CodeTools:
        return await self.call("GET", "/code/tools?" + urlencode({"session_id": session_id}), CodeTools)
