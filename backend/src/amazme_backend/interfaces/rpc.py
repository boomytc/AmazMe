"""JSON-RPC over the product host. Every call names its session and workspace.

A prompt submission is not an approval. approval.decide and mcp.decide require the
caller's explicit boolean plus the pinned identity. Releasing a binding does not
close a terminal or MCP service.
"""

import json
from typing import Literal, cast

from pydantic import Field, JsonValue, ValidationError

from amazme_backend.contracts.accounts import (
    ConfigureProvider,
    CredentialUpdate,
    OAuthInput,
    OAuthStart,
    ProviderCheckRequest,
)
from amazme_backend.contracts.code import CodeRun
from amazme_backend.contracts.execution import (
    JobOutput,
    TerminalOpen,
    TerminalSize,
    TerminalType,
)
from amazme_backend.contracts.feedback import AnswerFeedbackWrite
from amazme_backend.contracts.ipc.worker import Cancel
from amazme_backend.contracts.mcp import (
    McpCallRequest,
    McpConfigPatch,
    McpConfigWrite,
    McpDecision,
    McpLoginRequest,
    McpOpen,
    McpReconnect,
)
from amazme_backend.contracts.models import (
    IMAGE_MAX_COUNT,
    ImagePart,
    ModelScopeRequest,
    ToolCall,
    UpdateModelSettings,
)
from amazme_backend.contracts.plugins import (
    PluginCallRequest,
    PluginDraft,
    PluginPackageAdd,
    PluginPackageRemove,
    PluginReload,
)
from amazme_backend.contracts.schedules import (
    ScheduleControl,
    ScheduleInput,
    ScheduleNow,
)
from amazme_backend.contracts.sessions import (
    ApprovalDecision,
    CompactSession,
    CreateSession,
    RunOptions,
    Submit,
)
from amazme_backend.contracts.workspaces import (
    CheckpointCreate,
    WorkspaceGrantRequest,
    WorkspaceSelect,
)
from amazme_backend.host.service import Host
from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model


class RpcParams(RunOptions):
    provider_check: ProviderCheckRequest | None = None
    feedback: AnswerFeedbackWrite | None = None
    compaction: CompactSession | None = None
    offset: int = Field(default=0, ge=0, le=9007199254740991)
    provider_configuration: ConfigureProvider | None = None
    mcp_config: McpConfigWrite | None = None
    mcp_patch: McpConfigPatch | None = None
    mcp_reconnect: McpReconnect | None = None
    mcp_login: McpLoginRequest | None = None
    package_id: str = ""
    plugin_package: PluginPackageAdd | None = None
    plugin_package_remove: PluginPackageRemove | None = None
    schedule_id: str = ""
    schedule: ScheduleInput | None = None
    schedule_now: ScheduleNow | None = None
    schedule_control: ScheduleControl | None = None
    model_scope: ModelScopeRequest | None = None
    code_run: CodeRun | None = None
    run_id: str = ""
    tool_call: ToolCall | None = None
    plugin_id: str = ""
    plugin_draft: PluginDraft | None = None
    plugin_reload: PluginReload | None = None
    plugin_call: PluginCallRequest | None = None
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
    images: list[ImagePart] = Field(default_factory=lambda: list[ImagePart](), max_length=IMAGE_MAX_COUNT)
    not_before_ms: int = 0
    decision_id: str = ""
    approval_id: str = ""
    expected_revision: str = ""
    proposal_digest: str = ""
    approve: bool | None = None
    path: str = ""
    checkpoint_id: str = ""
    terminal_id: str = ""
    job_id: str = ""
    stream: Literal["stdout", "stderr"] = "stdout"
    offset: int = 0
    limit: int = 16000
    command: str = ""
    cwd: str = ""
    environment: dict[str, str] = Field(default_factory=dict)
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




async def _workspace(owner: Host, session_id: str) -> str:
    listed = await owner.sessions.sessions()
    found = next((item for item in listed.sessions if item.session_id == session_id), None)
    if found is None:
        raise BackendError("session_not_found", status=404)
    return found.workspace


def _require_workspace(params: RpcParams) -> None:
    if not params.workspace:
        raise BackendError("workspace_required")


async def _bound(owner: Host, params: RpcParams) -> str:
    _require_workspace(params)
    if not params.session_id or not params.attachment_id:
        raise BackendError("binding_required")
    if await _workspace(owner, params.session_id) != params.workspace:
        raise BackendError("workspace_mismatch")
    owner.sessions.check_attachment(params.attachment_id, params.session_id)
    return params.session_id


def _decision(params: RpcParams) -> bool:
    if params.approve is None or not params.decision_id:
        raise BackendError("decision_required")
    return params.approve


async def _dispatch(owner: Host, method: str, params: RpcParams) -> Model:
    if method == "code.tools":
        return await owner.integrations.code_tools(await _bound(owner, params))
    if method == "code.run":
        session = await _bound(owner, params)
        if params.code_run is None:
            raise BackendError("codemode_request_required")
        return await owner.integrations.run_code(session, params.code_run)
    if method == "code.cancel":
        session = await _bound(owner, params)
        if not params.run_id:
            raise BackendError("codemode_binding_required")
        return await owner.integrations.cancel_code(session, params.run_id)
    if method == "schedule.list":
        return await owner.scheduling.list_schedules()
    if method == "schedule.save":
        if params.schedule is None:
            raise BackendError("schedule_required")
        return await owner.scheduling.save_schedule(params.schedule)
    if method == "schedule.run":
        if not params.schedule_id or params.schedule_now is None:
            raise BackendError("schedule_required")
        return await owner.scheduling.run_schedule(params.schedule_id, params.schedule_now)
    if method in {"schedule.enabled", "schedule.cancel", "schedule.remove"}:
        if not params.schedule_id or params.schedule_control is None:
            raise BackendError("schedule_required")
        action = "enabled" if method == "schedule.enabled" else "cancel" if method == "schedule.cancel" else "remove"
        return await owner.scheduling.control_schedule(params.schedule_id, params.schedule_control, action)
    if method == "model.scope":
        if params.model_scope is None:
            raise BackendError("model_scope_required")
        return owner.accounts.model_scope(params.model_scope)
    if method == "model.list":
        return owner.accounts.model_catalog()
    if method == "model.update":
        if params.model_settings is None:
            raise BackendError("model_settings_required")
        return await owner.accounts.update_model(params.model_settings)
    if method == "provider.configure":
        if params.provider_configuration is None:
            raise BackendError("provider_configuration_required")
        return await owner.accounts.configure_provider(params.provider_configuration)
    if method == "account.list":
        return owner.accounts.account_list()
    if method == "account.update":
        if not params.provider or params.credential is None:
            raise BackendError("credential_required")
        return await owner.accounts.update_account(params.provider, params.credential)
    if method == "oauth.start":
        if params.oauth is None:
            raise BackendError("oauth_request_required")
        return await owner.accounts.start_oauth(params.oauth)
    if method == "oauth.lookup":
        return owner.accounts.oauth_view(params.login_id)
    if method == "oauth.input":
        if params.authorization is None:
            raise BackendError("oauth_input_required")
        return await owner.accounts.oauth_input(params.login_id, params.authorization)
    if method == "oauth.cancel":
        return await owner.accounts.cancel_oauth(params.login_id)
    if method == "resource.list":
        _require_workspace(params)
        if await _workspace(owner, params.session_id) != params.workspace:
            raise BackendError("workspace_mismatch")
        return await owner.workspaces.resources(params.session_id, params.resource_options)
    if method == "workspace.list":
        return await owner.workspaces.workspaces()
    if method == "workspace.select":
        return await owner.workspaces.select_workspace(WorkspaceSelect(host_path=params.path, name=params.workspace))
    if method == "workspace.add":
        return await owner.workspaces.add_workspace(WorkspaceGrantRequest(host_path=params.path, name=params.workspace))
    if method == "workspace.remove":
        await owner.workspaces.remove_workspace(params.workspace)
        return await owner.workspaces.workspaces()
    if method == "session.create":
        _require_workspace(params)
        return await owner.sessions.create_session(CreateSession(title=params.title or "新会话", workspace=params.workspace, session_id=params.session_id))
    if method == "session.attach":
        _require_workspace(params)
        if not params.session_id:
            raise BackendError("binding_required")
        if await _workspace(owner, params.session_id) != params.workspace:
            raise BackendError("workspace_mismatch")
        return await owner.sessions.attach_session(params.session_id)
    if method == "session.snapshot":
        return await owner.sessions.session_snapshot(await _bound(owner, params))
    if method == "request.lookup":
        if not params.request_id:
            raise BackendError("binding_required")
        return await owner.sessions.request_receipt(await _bound(owner, params), params.request_id)
    if method == "plugin.package.list":
        return await owner.integrations.plugin_packages()
    if method == "plugin.package.add":
        if params.plugin_package is None:
            raise BackendError("plugin_package_required")
        return await owner.integrations.add_plugin_package(params.plugin_package)
    if method == "plugin.package.remove":
        if not params.package_id or params.plugin_package_remove is None:
            raise BackendError("plugin_package_required")
        return await owner.integrations.remove_plugin_package(params.package_id, params.plugin_package_remove)
    if method == "plugin.package.load":
        return await owner.integrations.load_plugin_packages(await _bound(owner, params))
    if method == "plugin.list":
        return await owner.integrations.plugins(params.session_id)
    if method == "plugin.register":
        if params.plugin_draft is None:
            raise BackendError("plugin_draft_required")
        return await owner.integrations.register_plugin(params.plugin_draft)
    if method == "plugin.reload":
        if not params.plugin_id or params.plugin_reload is None:
            raise BackendError("plugin_binding_required")
        return await owner.integrations.reload_plugin(params.plugin_id, params.plugin_reload)
    if method == "plugin.close":
        session = await _bound(owner, params)
        if not params.plugin_id:
            raise BackendError("plugin_binding_required")
        return await owner.integrations.close_plugin(session, params.plugin_id)
    if method == "plugin.cancel":
        session = await _bound(owner, params)
        if not params.plugin_id or not params.call_id:
            raise BackendError("plugin_binding_required")
        return await owner.integrations.cancel_plugin(session, params.plugin_id, params.call_id)
    if method == "plugin.call":
        session = await _bound(owner, params)
        if not params.plugin_id or params.plugin_call is None:
            raise BackendError("plugin_binding_required")
        return await owner.integrations.call_plugin(session, params.plugin_id, params.plugin_call)
    if method == "provider.check":
        if params.provider_check is None:
            raise BackendError("provider_check_required")
        return await owner.accounts.check_provider(params.provider_check)
    if method == "feedback.state":
        return await owner.content.answer_feedback(await _bound(owner, params))
    if method == "feedback.rate":
        if params.feedback is None:
            raise BackendError("feedback_required")
        return await owner.content.save_answer_feedback(await _bound(owner, params), params.feedback)
    if method == "session.compact":
        if params.compaction is None:
            raise BackendError("compaction_required")
        return await owner.sessions.compact_session(await _bound(owner, params), params.compaction)
    if method == "request.submit":
        if not params.request_id:
            raise BackendError("binding_required")
        session = await _bound(owner, params)
        if not params.text and not params.images:
            raise BackendError("missing_user_context")
        return await owner.sessions.deliver(
            session, "submit", params.request_id,
            Submit(request_id=params.request_id, text=params.text, images=params.images, not_before_ms=params.not_before_ms,
                   tool_call=params.tool_call, **params.model_dump(include=set(RunOptions.model_fields))))
    if method == "request.cancel":
        if not params.request_id:
            raise BackendError("binding_required")
        session = await _bound(owner, params)
        return await owner.sessions.deliver(
            session, "cancel", params.request_id,
            Cancel(host_epoch=0, build_id="", request_id=params.request_id))
    if method == "approval.decide":
        approve = _decision(params)
        if not params.approval_id or not params.expected_revision or not params.proposal_digest:
            raise BackendError("binding_required")
        session = await _bound(owner, params)
        return await owner.sessions.deliver(session, "approval", params.decision_id, ApprovalDecision(
            decision_id=params.decision_id, approval_id=params.approval_id,
            expected_revision=params.expected_revision, proposal_digest=params.proposal_digest, approve=approve))
    if method == "file.list":
        await _bound(owner, params)
        return await owner.workspaces.list_workspace(params.path, params.offset)
    if method == "file.read":
        if not params.path:
            raise BackendError("binding_required")
        await _bound(owner, params)
        return await owner.workspaces.read_workspace(params.path)
    if method == "checkpoint.create":
        session_workspace = params.workspace
        await _bound(owner, params)
        return await owner.workspaces.create_checkpoint(CheckpointCreate(
            checkpoint_id=params.checkpoint_id, workspace=session_workspace, path=params.path))
    if method == "job.list":
        return await owner.jobs.list(await _bound(owner, params))
    if method == "job.output":
        return await owner.jobs.output(await _bound(owner, params), JobOutput(
            job_id=params.job_id, stream=params.stream, offset=params.offset, limit=params.limit))
    if method == "job.kill":
        return await owner.jobs.kill_job(await _bound(owner, params), params.job_id)
    if method == "terminal.list":
        return await owner.integrations.list_terminals(await _bound(owner, params))
    if method == "terminal.open":
        session = await _bound(owner, params)
        return await owner.integrations.open_terminal(session, TerminalOpen(
            terminal_id=params.terminal_id, command=params.command, cols=params.cols, rows=params.rows,
            workspace=params.workspace))
    if method == "terminal.write":
        session = await _bound(owner, params)
        return await owner.integrations.type_terminal(session, params.terminal_id, TerminalType(input_id=params.input_id, data=params.data))
    if method == "terminal.read":
        session = await _bound(owner, params)
        return await owner.integrations.read_terminal(session, params.terminal_id)
    if method == "terminal.resize":
        session = await _bound(owner, params)
        return await owner.integrations.resize_terminal(session, params.terminal_id, TerminalSize(cols=params.cols, rows=params.rows))
    if method == "terminal.close":
        session = await _bound(owner, params)
        return await owner.integrations.close_terminal(session, params.terminal_id)
    if method == "mcp.state":
        return await owner.integrations.mcp_state(await _bound(owner, params))
    if method == "mcp.config":
        return await owner.integrations.mcp_configuration(await _bound(owner, params) if params.session_id else "")
    if method == "mcp.login":
        if params.mcp_login is None:
            raise BackendError("mcp_login_required")
        return await owner.integrations.start_mcp_oauth(params.mcp_login)
    if method == "mcp.login.status":
        return await owner.integrations.mcp_oauth_view(params.login_id)
    if method == "mcp.login.input":
        if params.authorization is None:
            raise BackendError("oauth_input_required")
        return await owner.integrations.mcp_oauth_input(params.login_id, params.authorization)
    if method == "mcp.login.cancel":
        return await owner.integrations.cancel_mcp_oauth(params.login_id)
    if method == "mcp.config.save" or method == "mcp.config.patch":
        value = params.mcp_config if method == "mcp.config.save" else params.mcp_patch
        if value is None:
            raise BackendError("mcp_config_required")
        return await owner.integrations.change_mcp_configuration(await _bound(owner, params) if params.session_id else "", value)
    if method == "mcp.reload":
        return await owner.integrations.reload_mcp_configuration(await _bound(owner, params))
    if method == "mcp.reconnect":
        if params.mcp_reconnect is None:
            raise BackendError("mcp_config_required")
        return await owner.integrations.reconnect_mcp(await _bound(owner, params), params.mcp_reconnect)
    if method == "mcp.open":
        session = await _bound(owner, params)
        return await owner.integrations.open_mcp(session, McpOpen(
            server_id=params.server_id, command=params.command, workspace=params.workspace, cwd=params.cwd, environment=params.environment))
    if method == "mcp.call":
        session = await _bound(owner, params)
        return await owner.integrations.request_mcp(session, params.server_id, McpCallRequest(
            call_id=params.call_id, name=params.name, arguments=params.arguments,
            schema_digest=params.schema_digest, origin="manual"))
    if method == "mcp.decide":
        approve = _decision(params)
        if not params.call_id or not params.digest:
            raise BackendError("binding_required")
        session = await _bound(owner, params)
        return await owner.integrations.decide_mcp(session, params.server_id, params.call_id, McpDecision(
            decision_id=params.decision_id, approve=approve, digest=params.digest))
    if method == "mcp.close":
        session = await _bound(owner, params)
        return await owner.integrations.cancel_mcp(session, params.server_id)
    raise BackendError("method_not_found")


async def handle_rpc(owner: Host, call: RpcCall) -> dict[str, object]:
    if call.jsonrpc != "2.0" or not call.id or not call.method:
        return rpc_error(call.id or "0", "invalid_rpc")
    params = call.params
    try:
        if call.method == "session.release":
            if not params.session_id or not params.attachment_id:
                raise BackendError("binding_required")
            owner.sessions.release_attachment(params.session_id, params.attachment_id)
            return {"jsonrpc": "2.0", "id": call.id, "result": {"detached": True, "cancelled": False}}
        result = await _dispatch(owner, call.method, params)
    except BackendError as exc:
        return rpc_error(call.id, exc.code)
    except ValidationError:
        return rpc_error(call.id, "invalid_rpc")
    return rpc_result(call.id, result)
