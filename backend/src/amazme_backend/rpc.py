"""JSON-RPC over the product host. Every call names its session and workspace.

A prompt submission is not an approval. approval.decide and mcp.decide require the
caller's explicit boolean plus the pinned identity. Releasing a binding does not
close a terminal or MCP service.
"""

import json
from typing import Literal, Protocol, cast

from pydantic import Field, JsonValue, ValidationError

from .accounts import AccountsView
from .contracts import (
    ApprovalDecision,
    Attachment,
    BackendError,
    Cancel,
    CheckpointCreate,
    CheckpointView,
    CodeRun,
    CodeTools,
    CodeView,
    ComputerActionRequest,
    ComputerActionView,
    ComputerCleanup,
    ComputerGroundRequest,
    ComputerInspect,
    ComputerLocateRequest,
    ComputerObserve,
    ComputerPolicy,
    CreateSession,
    CredentialUpdate,
    McpCall,
    McpCallRequest,
    McpDecision,
    McpOpen,
    McpState,
    McpView,
    Model,
    ModelCatalog,
    ModelSettings,
    PluginCallRequest,
    PluginCallView,
    PluginDraft,
    PluginList,
    PluginReload,
    PluginView,
    Receipt,
    RunOptions,
    Session,
    SessionList,
    Snapshot,
    Submit,
    TerminalList,
    TerminalOpen,
    TerminalSize,
    TerminalType,
    TerminalView,
    ToolCall,
    UpdateModelSettings,
    WorkspaceGrantRequest,
    WorkspaceGrantView,
    WorkspaceList,
    WorkspaceSelect,
)
from .oauth import OAuthInput, OAuthStart, OAuthView
from .workspace_files import FileContent


class RpcParams(RunOptions):
    code_run: CodeRun | None = None
    run_id: str = ""
    tool_call: ToolCall | None = None
    plugin_id: str = ""
    plugin_draft: PluginDraft | None = None
    plugin_reload: PluginReload | None = None
    plugin_call: PluginCallRequest | None = None
    computer_inspect: ComputerInspect | None = None
    computer_policy: ComputerPolicy | None = None
    computer_action: ComputerActionRequest | None = None
    computer_ground: ComputerGroundRequest | None = None
    computer_locate: ComputerLocateRequest | None = None
    provider: str = ""
    login_id: str = ""
    model_settings: UpdateModelSettings | None = None
    credential: CredentialUpdate | None = None
    oauth: OAuthStart | None = None
    authorization: OAuthInput | None = None
    session_id: str = ""
    workspace: str = ""
    attachment_id: str = ""
    request_id: str = ""
    title: str = ""
    text: str = ""
    not_before_ms: int = 0
    decision_id: str = ""
    approval_id: str = ""
    expected_revision: str = ""
    proposal_digest: str = ""
    approve: bool | None = None
    path: str = ""
    checkpoint_id: str = ""
    terminal_id: str = ""
    command: str = ""
    cols: int = 80
    rows: int = 24
    input_id: str = ""
    data: str = ""
    server_id: str = ""
    call_id: str = ""
    name: str = ""
    arguments: dict[str, JsonValue] = Field(default_factory=dict)
    digest: str = ""
    schema_digest: str = ""


class RpcCall(Model):
    jsonrpc: Literal["2.0"] = "2.0"
    id: str = ""
    method: str = ""
    params: RpcParams = Field(default_factory=RpcParams)


def rpc_result(identity: str, result: Model) -> dict[str, object]:
    raw = json.loads(result.model_dump_json())
    if not isinstance(raw, dict):
        raise BackendError("invalid_rpc_result")
    body = {str(key): value for key, value in cast(dict[object, object], raw).items()}
    return {"jsonrpc": "2.0", "id": identity, "result": body}


def rpc_error(identity: str, code: str) -> dict[str, object]:
    return {"jsonrpc": "2.0", "id": identity, "error": {"code": -32000, "message": code}}


class RpcHost(Protocol):
    async def code_tools(self, session_id: str) -> CodeTools: ...

    async def run_code(self, session_id: str, value: CodeRun) -> CodeView: ...

    async def cancel_code(self, session_id: str, run_id: str) -> CodeView: ...

    async def computer_policy(self, session: str) -> ComputerPolicy: ...

    async def save_computer_policy(self, session: str, value: ComputerPolicy) -> ComputerPolicy: ...

    async def computer_observe(self, session: str, value: ComputerInspect | None = None) -> ComputerObserve: ...

    async def computer_action(self, session: str, value: ComputerActionRequest) -> ComputerActionView: ...

    async def computer_ground(self, session: str, value: ComputerGroundRequest) -> ComputerActionView: ...

    async def computer_locate(self, session: str, value: ComputerLocateRequest) -> ComputerActionView: ...

    async def computer_cleanup(self, session: str) -> ComputerCleanup: ...

    def model_catalog(self) -> ModelCatalog: ...

    async def update_model(self, value: UpdateModelSettings) -> ModelSettings: ...

    def account_list(self) -> AccountsView: ...

    async def update_account(self, provider: str, value: CredentialUpdate) -> AccountsView: ...

    async def start_oauth(self, value: OAuthStart) -> OAuthView: ...

    def oauth_view(self, login_id: str) -> OAuthView: ...

    async def oauth_input(self, login_id: str, value: OAuthInput) -> OAuthView: ...

    async def cancel_oauth(self, login_id: str) -> OAuthView: ...

    async def workspaces(self) -> WorkspaceList: ...

    async def select_workspace(self, value: WorkspaceSelect) -> WorkspaceGrantView: ...

    async def add_workspace(self, value: WorkspaceGrantRequest) -> WorkspaceGrantView: ...

    async def remove_workspace(self, name: str) -> None: ...

    async def sessions(self) -> SessionList: ...

    async def create_session(self, value: CreateSession) -> Session: ...

    def check_attachment(self, identity: str, session: str) -> Attachment: ...

    def release_attachment(self, session: str, attachment_id: str) -> None: ...

    async def deliver(self, session: str, kind: Literal["submit", "cancel", "approval", "resolve"],
                      key: str, value: Model) -> Receipt: ...

    async def attach_session(self, session: str) -> Attachment: ...

    async def session_snapshot(self, session: str) -> Snapshot: ...

    async def request_receipt(self, session: str, request_id: str) -> Receipt: ...

    async def read_workspace(self, relative: str) -> FileContent: ...

    async def create_checkpoint(self, value: CheckpointCreate) -> CheckpointView: ...

    async def list_terminals(self, session_id: str) -> TerminalList: ...

    async def open_terminal(self, session_id: str, value: TerminalOpen) -> TerminalView: ...

    async def type_terminal(self, session_id: str, terminal_id: str, value: TerminalType) -> TerminalView: ...

    async def read_terminal(self, session_id: str, terminal_id: str) -> TerminalView: ...

    async def resize_terminal(self, session_id: str, terminal_id: str, value: TerminalSize) -> TerminalView: ...

    async def close_terminal(self, session_id: str, terminal_id: str) -> TerminalView: ...

    async def mcp_state(self, session_id: str) -> McpState: ...

    async def open_mcp(self, session_id: str, value: McpOpen) -> McpView: ...

    async def register_plugin(self, value: PluginDraft) -> PluginView: ...

    async def reload_plugin(self, plugin_id: str, value: PluginReload) -> PluginView: ...

    async def call_plugin(self, session_id: str, plugin_id: str, value: PluginCallRequest) -> PluginCallView: ...

    async def close_plugin(self, session_id: str, plugin_id: str) -> PluginView: ...

    async def cancel_plugin(self, session_id: str, plugin_id: str, call_id: str) -> PluginCallView: ...

    async def plugins(self, session_id: str = "") -> PluginList: ...

    async def request_mcp(self, session_id: str, server_id: str, value: McpCallRequest) -> McpCall: ...

    async def decide_mcp(self, session_id: str, server_id: str, call_id: str, value: McpDecision) -> McpCall: ...

    async def cancel_mcp(self, session_id: str, server_id: str) -> McpView: ...


async def _workspace(owner: RpcHost, session_id: str) -> str:
    listed = await owner.sessions()
    found = next((item for item in listed.sessions if item.session_id == session_id), None)
    if found is None:
        raise BackendError("session_not_found", status=404)
    return found.workspace


def _require_workspace(params: RpcParams) -> None:
    if not params.workspace:
        raise BackendError("workspace_required")


async def _bound(owner: RpcHost, params: RpcParams) -> str:
    _require_workspace(params)
    if not params.session_id or not params.attachment_id:
        raise BackendError("binding_required")
    if await _workspace(owner, params.session_id) != params.workspace:
        raise BackendError("workspace_mismatch")
    owner.check_attachment(params.attachment_id, params.session_id)
    return params.session_id


def _decision(params: RpcParams) -> bool:
    if params.approve is None or not params.decision_id:
        raise BackendError("decision_required")
    return params.approve


async def _dispatch(owner: RpcHost, method: str, params: RpcParams) -> Model:
    if method == "code.tools":
        return await owner.code_tools(await _bound(owner, params))
    if method == "code.run":
        session = await _bound(owner, params)
        if params.code_run is None:
            raise BackendError("codemode_request_required")
        return await owner.run_code(session, params.code_run)
    if method == "code.cancel":
        session = await _bound(owner, params)
        if not params.run_id:
            raise BackendError("codemode_binding_required")
        return await owner.cancel_code(session, params.run_id)
    if method == "computer.policy":
        return await owner.computer_policy(await _bound(owner, params))
    if method == "computer.configure":
        if params.computer_policy is None:
            raise BackendError("computer_policy_required")
        return await owner.save_computer_policy(await _bound(owner, params), params.computer_policy)
    if method == "computer.observe":
        return await owner.computer_observe(await _bound(owner, params), params.computer_inspect)
    if method == "computer.act":
        if params.computer_action is None:
            raise BackendError("computer_action_required")
        return await owner.computer_action(await _bound(owner, params), params.computer_action)
    if method == "computer.ground":
        session = await _bound(owner,params)
        if params.computer_ground is None:
            raise BackendError("computer_ground_required")
        return await owner.computer_ground(session,params.computer_ground)
    if method == "computer.locate":
        session = await _bound(owner,params)
        if params.computer_locate is None:
            raise BackendError("computer_locate_required")
        return await owner.computer_locate(session,params.computer_locate)
    if method == "computer.cleanup":
        return await owner.computer_cleanup(await _bound(owner, params))
    if method == "model.list":
        return owner.model_catalog()
    if method == "model.update":
        if params.model_settings is None:
            raise BackendError("model_settings_required")
        return await owner.update_model(params.model_settings)
    if method == "account.list":
        return owner.account_list()
    if method == "account.update":
        if not params.provider or params.credential is None:
            raise BackendError("credential_required")
        return await owner.update_account(params.provider, params.credential)
    if method == "oauth.start":
        if params.oauth is None:
            raise BackendError("oauth_request_required")
        return await owner.start_oauth(params.oauth)
    if method == "oauth.lookup":
        return owner.oauth_view(params.login_id)
    if method == "oauth.input":
        if params.authorization is None:
            raise BackendError("oauth_input_required")
        return await owner.oauth_input(params.login_id, params.authorization)
    if method == "oauth.cancel":
        return await owner.cancel_oauth(params.login_id)
    if method == "workspace.list":
        return await owner.workspaces()
    if method == "workspace.select":
        return await owner.select_workspace(WorkspaceSelect(host_path=params.path, name=params.workspace))
    if method == "workspace.add":
        return await owner.add_workspace(WorkspaceGrantRequest(host_path=params.path, name=params.workspace))
    if method == "workspace.remove":
        await owner.remove_workspace(params.workspace)
        return await owner.workspaces()
    if method == "session.create":
        _require_workspace(params)
        return await owner.create_session(CreateSession(title=params.title or "新会话", workspace=params.workspace, session_id=params.session_id))
    if method == "session.attach":
        _require_workspace(params)
        if not params.session_id:
            raise BackendError("binding_required")
        if await _workspace(owner, params.session_id) != params.workspace:
            raise BackendError("workspace_mismatch")
        return await owner.attach_session(params.session_id)
    if method == "session.snapshot":
        return await owner.session_snapshot(await _bound(owner, params))
    if method == "request.lookup":
        if not params.request_id:
            raise BackendError("binding_required")
        return await owner.request_receipt(await _bound(owner, params), params.request_id)
    if method == "plugin.list":
        return await owner.plugins(params.session_id)
    if method == "plugin.register":
        if params.plugin_draft is None:
            raise BackendError("plugin_draft_required")
        return await owner.register_plugin(params.plugin_draft)
    if method == "plugin.reload":
        if not params.plugin_id or params.plugin_reload is None:
            raise BackendError("plugin_binding_required")
        return await owner.reload_plugin(params.plugin_id, params.plugin_reload)
    if method == "plugin.close":
        session = await _bound(owner, params)
        if not params.plugin_id:
            raise BackendError("plugin_binding_required")
        return await owner.close_plugin(session, params.plugin_id)
    if method == "plugin.cancel":
        session = await _bound(owner, params)
        if not params.plugin_id or not params.call_id:
            raise BackendError("plugin_binding_required")
        return await owner.cancel_plugin(session, params.plugin_id, params.call_id)
    if method == "plugin.call":
        session = await _bound(owner, params)
        if not params.plugin_id or params.plugin_call is None:
            raise BackendError("plugin_binding_required")
        return await owner.call_plugin(session, params.plugin_id, params.plugin_call)
    if method == "request.submit":
        if not params.request_id:
            raise BackendError("binding_required")
        session = await _bound(owner, params)
        if not params.text:
            raise BackendError("missing_user_context")
        return await owner.deliver(
            session, "submit", params.request_id,
            Submit(request_id=params.request_id, text=params.text, not_before_ms=params.not_before_ms,
                   system_prompt=params.system_prompt, append_system_prompt=params.append_system_prompt,
                   allowed_tools=params.allowed_tools, excluded_tools=params.excluded_tools, tool_call=params.tool_call))
    if method == "request.cancel":
        if not params.request_id:
            raise BackendError("binding_required")
        session = await _bound(owner, params)
        return await owner.deliver(
            session, "cancel", params.request_id,
            Cancel(host_epoch=0, build_id="", request_id=params.request_id))
    if method == "approval.decide":
        approve = _decision(params)
        if not params.approval_id or not params.expected_revision or not params.proposal_digest:
            raise BackendError("binding_required")
        session = await _bound(owner, params)
        return await owner.deliver(session, "approval", params.decision_id, ApprovalDecision(
            decision_id=params.decision_id, approval_id=params.approval_id,
            expected_revision=params.expected_revision, proposal_digest=params.proposal_digest, approve=approve))
    if method == "file.read":
        if not params.path:
            raise BackendError("binding_required")
        await _bound(owner, params)
        return await owner.read_workspace(params.path)
    if method == "checkpoint.create":
        session_workspace = params.workspace
        await _bound(owner, params)
        return await owner.create_checkpoint(CheckpointCreate(
            checkpoint_id=params.checkpoint_id, workspace=session_workspace, path=params.path))
    if method == "terminal.list":
        return await owner.list_terminals(await _bound(owner, params))
    if method == "terminal.open":
        session = await _bound(owner, params)
        return await owner.open_terminal(session, TerminalOpen(
            terminal_id=params.terminal_id, command=params.command, cols=params.cols, rows=params.rows,
            workspace=params.workspace))
    if method == "terminal.write":
        session = await _bound(owner, params)
        return await owner.type_terminal(session, params.terminal_id, TerminalType(input_id=params.input_id, data=params.data))
    if method == "terminal.read":
        session = await _bound(owner, params)
        return await owner.read_terminal(session, params.terminal_id)
    if method == "terminal.resize":
        session = await _bound(owner, params)
        return await owner.resize_terminal(session, params.terminal_id, TerminalSize(cols=params.cols, rows=params.rows))
    if method == "terminal.close":
        session = await _bound(owner, params)
        return await owner.close_terminal(session, params.terminal_id)
    if method == "mcp.state":
        return await owner.mcp_state(await _bound(owner, params))
    if method == "mcp.open":
        session = await _bound(owner, params)
        return await owner.open_mcp(session, McpOpen(
            server_id=params.server_id, command=params.command, workspace=params.workspace))
    if method == "mcp.call":
        session = await _bound(owner, params)
        return await owner.request_mcp(session, params.server_id, McpCallRequest(
            call_id=params.call_id, name=params.name, arguments=params.arguments,
            schema_digest=params.schema_digest, origin="manual"))
    if method == "mcp.decide":
        approve = _decision(params)
        if not params.call_id or not params.digest:
            raise BackendError("binding_required")
        session = await _bound(owner, params)
        return await owner.decide_mcp(session, params.server_id, params.call_id, McpDecision(
            decision_id=params.decision_id, approve=approve, digest=params.digest))
    if method == "mcp.close":
        session = await _bound(owner, params)
        return await owner.cancel_mcp(session, params.server_id)
    raise BackendError("method_not_found")


async def handle_rpc(owner: RpcHost, call: RpcCall) -> dict[str, object]:
    if call.jsonrpc != "2.0" or not call.id or not call.method:
        return rpc_error(call.id or "0", "invalid_rpc")
    params = call.params
    try:
        if call.method == "session.release":
            if not params.session_id or not params.attachment_id:
                raise BackendError("binding_required")
            owner.release_attachment(params.session_id, params.attachment_id)
            return {"jsonrpc": "2.0", "id": call.id, "result": {"detached": True, "cancelled": False}}
        result = await _dispatch(owner, call.method, params)
    except BackendError as exc:
        return rpc_error(call.id, exc.code)
    except ValidationError:
        return rpc_error(call.id, "invalid_rpc")
    return rpc_result(call.id, result)
