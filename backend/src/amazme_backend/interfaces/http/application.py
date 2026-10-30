import base64
import contextlib
import secrets
import sqlite3
from collections.abc import Awaitable, Callable
from typing import Annotated, Literal
from urllib.parse import quote

import httpx
from fastapi import FastAPI, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from amazme_backend.ai.classification.types import ClassifierCatalog
from amazme_backend.contracts.accounts import (
    AccountsView,
    ConfigureProvider,
    CredentialUpdate,
    OAuthInput,
    OAuthStart,
    OAuthView,
    ProviderCheck,
    ProviderCheckRequest,
    ProviderConfigured,
)
from amazme_backend.contracts.artifacts import ArtifactBody, ArtifactList, ArtifactView, ArtifactWrite
from amazme_backend.contracts.code import CodeRun, CodeTools, CodeView
from amazme_backend.contracts.events import HistoryPage, Snapshot
from amazme_backend.contracts.execution import (
    EffectResolution,
    JobId,
    JobList,
    JobOutput,
    JobOutputView,
    JobView,
    PreparedPatch,
    TerminalList,
    TerminalOpen,
    TerminalSize,
    TerminalType,
    TerminalView,
)
from amazme_backend.contracts.feedback import (
    AnswerFeedback,
    AnswerFeedbackList,
    AnswerFeedbackWrite,
    FeedbackView,
    FeedbackWrite,
)
from amazme_backend.contracts.host import CompleteUpdate, Health, PrepareUpdate, UpdateRecord
from amazme_backend.contracts.identity import HostFence, Identity
from amazme_backend.contracts.ipc.host import (
    CodeToolDispatch,
    CodeToolReceipt,
    PreparedFileWrite,
    PrepareFileWrite,
    PreparePatch,
)
from amazme_backend.contracts.ipc.supervisor import Recovery, TaskActivity
from amazme_backend.contracts.ipc.worker import Cancel
from amazme_backend.contracts.management import ExportBundle, ImportResult
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
    McpView,
)
from amazme_backend.contracts.memories import MemoryList, MemoryView, MemoryWrite
from amazme_backend.contracts.models import (
    ModelCatalog,
    ModelScope,
    ModelScopeRequest,
    ModelSettings,
    UpdateModelSettings,
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
from amazme_backend.contracts.projects import ProjectList, ProjectUpdate, ProjectView, ProjectWrite
from amazme_backend.contracts.remote import (
    RemoteCallView,
    RemoteHostKeys,
    RemoteKeyScan,
    RemoteOpen,
    RemoteRun,
    RemoteView,
)
from amazme_backend.contracts.resources import ResourceCatalog, ResourceOptions
from amazme_backend.contracts.schedules import (
    ScheduleControl,
    ScheduleInput,
    ScheduleNow,
    SchedulesView,
    ScheduleView,
)
from amazme_backend.contracts.sessions import (
    ApprovalDecision,
    ArchiveSession,
    Attachment,
    BranchSession,
    Compaction,
    CompactSession,
    CreateSession,
    Receipt,
    RenameSession,
    SearchResults,
    Session,
    SessionApprovalPolicy,
    SessionDiagnostic,
    SessionList,
    SessionModel,
    Submit,
    UsageReport,
    WorkflowOpen,
    WorkflowVerdict,
    WorkflowView,
)
from amazme_backend.contracts.settings import (
    InterfacePreferences,
    PreferencesUpdate,
    ProductSettings,
    SettingsUpdate,
)
from amazme_backend.contracts.sharing import ShareView, ShareWrite
from amazme_backend.contracts.skills import SkillDocument, SkillImport, SkillRemove, SkillWrite
from amazme_backend.contracts.web import WebCallRequest, WebCallView, WebPolicy
from amazme_backend.contracts.workspaces import (
    FILE_READ_LIMIT,
    CheckpointCreate,
    CheckpointList,
    CheckpointPreview,
    CheckpointRestore,
    CheckpointView,
    FileChange,
    FileContent,
    FileList,
    FileWrite,
    WorkspaceGrantRequest,
    WorkspaceGrantView,
    WorkspaceList,
    WorkspaceSelect,
)
from amazme_backend.host.service import Host
from amazme_backend.interfaces.http.transport import (
    CONFIG_BODY_BYTES,
    DOCUMENT_BODY_BYTES,
    MEDIA_BODY_BYTES,
    app_factory,
)
from amazme_backend.interfaces.rpc import RpcCall, handle_rpc
from amazme_backend.interfaces.web.boot import boot_document
from amazme_backend.platform.resources import frontend_directory, package_resource
from amazme_backend.shared.errors import BackendError


def application(owner: Host) -> FastAPI:
    app = app_factory(
        body_limits={
            "/api/v1/sessions/[a-f0-9]{32}/submissions": MEDIA_BODY_BYTES,
            "/api/v1/rpc": MEDIA_BODY_BYTES,
            "/api/v1/import": DOCUMENT_BODY_BYTES,
            "/api/v1/mcp-configuration": CONFIG_BODY_BYTES,
            "/api/v1/sessions/[a-f0-9]{32}/mcp(?:-configuration)?": CONFIG_BODY_BYTES,
        }
    )

    @app.middleware("http")
    async def authenticate(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        if request.headers.get("host") != owner.origin.removeprefix("http://"):
            return JSONResponse({"code": "invalid_host", "message": "Invalid Host"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin != owner.origin:
            return JSONResponse({"code": "invalid_origin", "message": "Invalid Origin"}, status_code=403)
        path = request.url.path
        if path.startswith("/control/"):
            valid = secrets.compare_digest(
                request.headers.get("authorization", ""), "Bearer " + owner.lifecycle.profile.token
            )
        elif path.startswith("/api/"):
            bearer = secrets.compare_digest(
                request.headers.get("authorization", ""), "Bearer " + owner.web_token
            )
            cookie = secrets.compare_digest(request.cookies.get("amazme", ""), owner.web_token)
            valid = bearer or (cookie and (request.method in {"GET", "HEAD"} or origin == owner.origin))
            if valid and request.method not in {"GET", "HEAD"}:
                if (request.headers.get("x-amazme-build"), request.headers.get("x-amazme-epoch")) != (
                    owner.lifecycle.build,
                    str(owner.lifecycle.fence.host_epoch),
                ):
                    return JSONResponse(
                        {"code": "stale_client_binding", "message": "Reconnect before writing"},
                        status_code=409,
                    )
                parts = path.split("/")
                if (
                    len(parts) > 5
                    and parts[3] == "sessions"
                    and (not (len(parts) == 6 and parts[5] == "attachments" and (request.method == "POST")))
                ):
                    try:
                        owner.sessions.check_attachment(
                            request.headers.get("x-amazme-attachment", ""), parts[4]
                        )
                    except BackendError:
                        return JSONResponse(
                            {"code": "stale_client_binding", "message": "Attach before writing"},
                            status_code=409,
                        )
        else:
            valid = True
        if not valid:
            return JSONResponse(
                {"code": "unauthenticated", "message": "Authentication required"}, status_code=401
            )
        try:
            response = await call_next(request)
        except sqlite3.Error:
            owner.lifecycle.storage_failed = True
            return JSONResponse(
                {"code": "storage_failed", "message": "Storage unavailable; admission closed"},
                status_code=503,
            )
        except httpx.TransportError:
            if await owner.lifecycle.store.active_update():
                return JSONResponse(
                    {"code": "update_prepared", "message": "update_prepared"}, status_code=503
                )
            return JSONResponse(
                {"code": "runtime_recovering", "message": "Runtime recovering; retry the same request ID"},
                status_code=503,
            )
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        if "content-security-policy" not in response.headers:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; frame-ancestors 'none'; connect-src 'self'; style-src 'self'"
            )
        return response

    @app.get("/api/v1/bootstrap")
    async def bootstrap() -> Identity:
        return owner.lifecycle.identity((await owner.lifecycle.health()).state)

    @app.post("/api/v1/memories")
    async def save_memory(value: MemoryWrite) -> MemoryView:
        return await owner.content.save_memory(value)

    @app.get("/api/v1/memories")
    async def memories(workspace: str = "primary", q: str = "") -> MemoryList:
        return await owner.content.memories_for(workspace, q)

    @app.get("/api/v1/sessions/{session_id}/memories")
    async def session_memories(session_id: str, q: str = "") -> MemoryList:
        return await owner.content.injection_preview(session_id, q)

    @app.get("/api/v1/schedules")
    async def list_schedules() -> SchedulesView:
        return await owner.scheduling.list_schedules()

    @app.post("/api/v1/schedules")
    async def save_schedule(value: ScheduleInput) -> ScheduleView:
        return await owner.scheduling.save_schedule(value)

    @app.post("/api/v1/schedules/tick")
    async def tick_schedules() -> SchedulesView:
        return await owner.scheduling.tick_schedules(force=True)

    @app.post("/api/v1/schedules/{schedule_id}/run")
    async def run_schedule(schedule_id: str, value: ScheduleNow) -> ScheduleView:
        return await owner.scheduling.run_schedule(schedule_id, value)

    @app.post("/api/v1/schedules/{schedule_id}/enabled")
    async def enable_schedule(schedule_id: str, value: ScheduleControl) -> ScheduleView:
        return await owner.scheduling.control_schedule(schedule_id, value, "enabled")

    @app.post("/api/v1/schedules/{schedule_id}/cancel")
    async def cancel_schedule(schedule_id: str, value: ScheduleControl) -> ScheduleView:
        return await owner.scheduling.control_schedule(schedule_id, value, "cancel")

    @app.post("/api/v1/schedules/{schedule_id}/remove")
    async def remove_schedule(schedule_id: str, value: ScheduleControl) -> ScheduleView:
        return await owner.scheduling.control_schedule(schedule_id, value, "remove")

    @app.post("/api/v1/sessions/{session}/workflows")
    async def open_workflow(session: str, value: WorkflowOpen) -> WorkflowView:
        return await owner.sessions.open_workflow(session, value)

    @app.get("/api/v1/sessions/{session}/workflows/{workflow_id}")
    async def workflow(session: str, workflow_id: str) -> WorkflowView:
        return await owner.sessions.workflow(session, workflow_id)

    @app.post("/api/v1/sessions/{session}/workflows/{workflow_id}/verdicts")
    async def record_verdict(session: str, workflow_id: str, value: WorkflowVerdict) -> WorkflowView:
        return await owner.sessions.record_verdict(session, workflow_id, value)

    @app.post("/api/v1/sessions/{session}/workflows/{workflow_id}/resume")
    async def resume_workflow(session: str, workflow_id: str) -> WorkflowView:
        return await owner.sessions.resume_workflow(session, workflow_id)

    @app.post("/api/v1/sessions/{session}/workflows/{workflow_id}/cancel")
    async def cancel_workflow(session: str, workflow_id: str) -> WorkflowView:
        return await owner.sessions.cancel_workflow(session, workflow_id)

    @app.post("/api/v1/sessions/{session}/workflows/{workflow_id}/children/{request_id}/cancel")
    async def cancel_workflow_child(session: str, workflow_id: str, request_id: str) -> WorkflowView:
        return await owner.sessions.cancel_workflow_child(session, workflow_id, request_id)

    @app.get("/api/v1/sessions/{session}/web")
    async def web_policy(session: str) -> WebPolicy:
        return await owner.sessions.web_policy(session)

    @app.post("/api/v1/sessions/{session}/web")
    async def save_web_policy(session: str, value: WebPolicy) -> WebPolicy:
        return await owner.sessions.save_web_policy(session, value)

    @app.post("/api/v1/sessions/{session}/web/calls")
    async def web_call(session: str, value: WebCallRequest) -> WebCallView:
        return await owner.sessions.web_call(session, value)

    @app.get("/api/v1/classifiers")
    async def classifiers() -> ClassifierCatalog:
        return owner.accounts.classifier_catalog()

    @app.post("/api/v1/sessions/{session}/artifacts", status_code=201)
    async def put_artifact(session: str, value: ArtifactWrite) -> ArtifactView:
        return await owner.content.put_artifact(session, value)

    @app.get("/api/v1/sessions/{session}/artifacts")
    async def artifacts(session: str) -> ArtifactList:
        return await owner.content.artifacts(session)

    @app.get("/api/v1/sessions/{session}/artifacts/{artifact_id}")
    async def artifact(session: str, artifact_id: str) -> ArtifactBody:
        return await owner.content.artifact(session, artifact_id)

    @app.get("/api/v1/sessions/{session}/resources")
    async def resources(session: str) -> ResourceCatalog:
        return await owner.workspaces.resources(session)

    @app.post("/api/v1/sessions/{session}/resources")
    async def selected_resources(session: str, value: ResourceOptions) -> ResourceCatalog:
        return await owner.workspaces.resources(session, value)

    @app.get("/api/v1/workspaces")
    async def workspaces() -> WorkspaceList:
        return await owner.workspaces.workspaces()

    @app.get("/api/v1/skills")
    async def skills(session_id: str = "") -> ResourceCatalog:
        return await owner.workspaces.skill_catalog(session_id)

    @app.get("/api/v1/skills/{name}")
    async def skill_document(name: str, session_id: str = "") -> SkillDocument:
        return await owner.workspaces.skill_document(session_id, name)

    @app.post("/api/v1/skills")
    async def save_skill(value: SkillWrite, session_id: str = "") -> SkillDocument:
        return await owner.workspaces.save_skill(session_id, value)

    @app.post("/api/v1/skills/import")
    async def copy_skill(value: SkillImport, session_id: str = "") -> SkillDocument:
        return await owner.workspaces.import_skill(session_id, value)

    @app.delete("/api/v1/skills/{name}")
    async def delete_skill(name: str, value: SkillRemove, session_id: str = "") -> dict[str, bool]:
        await owner.workspaces.remove_skill(session_id, name, value)
        return {"removed": True}

    @app.post("/api/v1/workspaces/select")
    async def select_workspace(value: WorkspaceSelect) -> WorkspaceGrantView:
        return await owner.workspaces.select_workspace(value)

    @app.post("/api/v1/workspaces")
    async def add_workspace(value: WorkspaceGrantRequest) -> WorkspaceGrantView:
        return await owner.workspaces.add_workspace(value)

    @app.delete("/api/v1/workspaces/{name}")
    async def remove_workspace(name: str) -> dict[str, bool]:
        await owner.workspaces.remove_workspace(name)
        return {"removed": True}

    @app.get("/api/v1/files")
    async def files(path: str = "", offset: int = Query(default=0, ge=0, le=9007199254740991)) -> FileList:
        return await owner.workspaces.list_workspace(path, offset)

    @app.get("/api/v1/files/content")
    async def file_content(path: str, offset: int = Query(default=0, ge=0, le=9007199254740991),
                           limit: int = Query(default=FILE_READ_LIMIT, ge=4, le=FILE_READ_LIMIT)) -> FileContent:
        return await owner.workspaces.read_workspace(path, offset, limit)

    @app.post("/api/v1/files/content")
    async def file_write(value: FileWrite) -> FileChange:
        return await owner.workspaces.write_workspace(value)

    @app.post("/api/v1/checkpoints")
    async def create_checkpoint(value: CheckpointCreate) -> CheckpointView:
        return await owner.workspaces.create_checkpoint(value)

    @app.get("/api/v1/checkpoints")
    async def checkpoints(workspace: str = "primary", path: str = "") -> CheckpointList:
        return await owner.workspaces.list_checkpoints(workspace, path)

    @app.get("/api/v1/checkpoints/{checkpoint_id}")
    async def preview_checkpoint(checkpoint_id: str) -> CheckpointPreview:
        return await owner.workspaces.preview_checkpoint(checkpoint_id)

    @app.post("/api/v1/checkpoints/{checkpoint_id}/restore")
    async def restore_checkpoint(checkpoint_id: str, value: CheckpointRestore) -> FileChange:
        return await owner.workspaces.restore_checkpoint(checkpoint_id, value)

    @app.get("/api/v1/sessions/{session_id}/jobs")
    async def list_jobs(session_id: str) -> JobList:
        return await owner.jobs.list(session_id)

    @app.get("/api/v1/sessions/{session_id}/jobs/{job_id}/output")
    async def job_output(session_id: str, job_id: JobId, stream: Literal["stdout", "stderr"] = "stdout",
                         offset: Annotated[int, Query(ge=0)] = 0,
                         limit: Annotated[int, Query(ge=4, le=32000)] = 16000) -> JobOutputView:
        return await owner.jobs.output(session_id, JobOutput(job_id=job_id, stream=stream, offset=offset, limit=limit))

    @app.post("/api/v1/sessions/{session_id}/jobs/{job_id}/kill")
    async def kill_job(session_id: str, job_id: JobId) -> JobView:
        return await owner.jobs.kill_job(session_id, job_id)

    @app.post("/api/v1/sessions/{session_id}/terminals")
    async def open_terminal(session_id: str, value: TerminalOpen) -> TerminalView:
        return await owner.integrations.open_terminal(session_id, value)

    @app.get("/api/v1/sessions/{session_id}/terminals")
    async def list_terminals(session_id: str) -> TerminalList:
        return await owner.integrations.list_terminals(session_id)

    @app.post("/api/v1/sessions/{session_id}/terminals/{terminal_id}/close")
    async def close_terminal(session_id: str, terminal_id: str) -> TerminalView:
        return await owner.integrations.close_terminal(session_id, terminal_id)

    @app.post("/api/v1/sessions/{session_id}/terminals/{terminal_id}/input")
    async def type_terminal(session_id: str, terminal_id: str, value: TerminalType) -> TerminalView:
        return await owner.integrations.type_terminal(session_id, terminal_id, value)

    @app.post("/api/v1/sessions/{session_id}/terminals/{terminal_id}/resize")
    async def resize_terminal(session_id: str, terminal_id: str, value: TerminalSize) -> TerminalView:
        return await owner.integrations.resize_terminal(session_id, terminal_id, value)

    @app.post("/api/v1/sessions/{session_id}/terminals/{terminal_id}/read")
    async def read_terminal(session_id: str, terminal_id: str) -> TerminalView:
        return await owner.integrations.read_terminal(session_id, terminal_id)

    @app.post("/api/v1/sessions/{session_id}/code")
    async def run_code(session_id: str, value: CodeRun) -> CodeView:
        return await owner.integrations.run_code(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/code/{run_id}/cancel")
    async def cancel_code(session_id: str, run_id: str) -> CodeView:
        return await owner.integrations.cancel_code(session_id, run_id)

    @app.post("/api/v1/sessions/{session_id}/remotes/keys")
    async def scan_remote_key(session_id: str, value: RemoteKeyScan) -> RemoteHostKeys:
        return await owner.integrations.scan_remote_key(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/remotes")
    async def open_remote(session_id: str, value: RemoteOpen) -> RemoteView:
        return await owner.integrations.open_remote(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/remotes/{remote_id}/reconnect")
    async def reconnect_remote(session_id: str, remote_id: str, value: RemoteOpen) -> RemoteView:
        if value.remote_id != remote_id:
            raise BackendError("remote_conflict")
        return await owner.integrations.reconnect_remote(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/remotes/{remote_id}/disconnect")
    async def disconnect_remote(session_id: str, remote_id: str, value: RemoteOpen) -> RemoteView:
        if value.remote_id != remote_id:
            raise BackendError("remote_conflict")
        return await owner.integrations.disconnect_remote(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/remotes/{remote_id}/calls")
    async def submit_remote(session_id: str, remote_id: str, value: RemoteRun) -> RemoteCallView:
        if value.remote_id != remote_id:
            raise BackendError("remote_conflict")
        return await owner.integrations.submit_remote(session_id, value)

    @app.get("/api/v1/mcp-configuration")
    async def global_mcp_configuration() -> McpConfiguration:
        return await owner.integrations.mcp_configuration("")

    @app.post("/api/v1/mcp-configuration/logins")
    async def mcp_login(value: McpLoginRequest) -> OAuthView:
        return await owner.integrations.start_mcp_oauth(value)

    @app.get("/api/v1/mcp-configuration/logins/{login_id}")
    async def mcp_login_view(login_id: str) -> OAuthView:
        return await owner.integrations.mcp_oauth_view(login_id)

    @app.post("/api/v1/mcp-configuration/logins/{login_id}/input")
    async def mcp_login_input(login_id: str, value: OAuthInput) -> OAuthView:
        return await owner.integrations.mcp_oauth_input(login_id, value)

    @app.delete("/api/v1/mcp-configuration/logins/{login_id}")
    async def mcp_login_cancel(login_id: str) -> OAuthView:
        return await owner.integrations.cancel_mcp_oauth(login_id)

    @app.post("/api/v1/mcp-configuration")
    async def save_global_mcp_configuration(value: McpConfigWrite) -> McpConfiguration:
        return await owner.integrations.change_mcp_configuration("", value)

    @app.patch("/api/v1/mcp-configuration")
    async def patch_global_mcp_configuration(value: McpConfigPatch) -> McpConfiguration:
        return await owner.integrations.change_mcp_configuration("", value)

    @app.get("/api/v1/sessions/{session_id}/mcp-configuration")
    async def mcp_configuration(session_id: str) -> McpConfiguration:
        return await owner.integrations.mcp_configuration(session_id)

    @app.post("/api/v1/sessions/{session_id}/mcp-configuration")
    async def save_mcp_configuration(session_id: str, value: McpConfigWrite) -> McpConfiguration:
        return await owner.integrations.change_mcp_configuration(session_id, value)

    @app.patch("/api/v1/sessions/{session_id}/mcp-configuration")
    async def patch_mcp_configuration(session_id: str, value: McpConfigPatch) -> McpConfiguration:
        return await owner.integrations.change_mcp_configuration(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/mcp-configuration/reload")
    async def reload_mcp_configuration(session_id: str) -> McpState:
        return await owner.integrations.reload_mcp_configuration(session_id)

    @app.post("/api/v1/sessions/{session_id}/mcp-configuration/reconnect")
    async def reconnect_mcp_configuration(session_id: str, value: McpReconnect) -> McpView:
        return await owner.integrations.reconnect_mcp(session_id, value)

    @app.post("/api/v1/sessions/{session_id}/mcp")
    async def open_mcp(session_id: str, value: McpOpen) -> McpView:
        return await owner.integrations.open_mcp(session_id, value)

    @app.get("/api/v1/sessions/{session_id}/mcp")
    async def mcp_state(session_id: str) -> McpState:
        return await owner.integrations.mcp_state(session_id)

    @app.post("/api/v1/sessions/{session_id}/mcp/{server_id}/calls")
    async def request_mcp(session_id: str, server_id: str, value: McpCallRequest) -> McpCall:
        return await owner.integrations.request_mcp(session_id, server_id, value)

    @app.post("/api/v1/sessions/{session_id}/mcp/{server_id}/calls/{call_id}/decision")
    async def decide_mcp(session_id: str, server_id: str, call_id: str, value: McpDecision) -> McpCall:
        return await owner.integrations.decide_mcp(session_id, server_id, call_id, value)

    @app.post("/api/v1/sessions/{session_id}/mcp/{server_id}/cancel")
    async def cancel_mcp(session_id: str, server_id: str) -> McpView:
        return await owner.integrations.cancel_mcp(session_id, server_id)

    @app.get("/api/v1/session-models/{session_id}")
    async def session_model(session_id: str) -> SessionModel:
        return await owner.accounts.session_model(session_id)

    @app.put("/api/v1/session-models/{session_id}")
    async def save_session_model(session_id: str, value: SessionModel) -> SessionModel:
        if value.session_id != session_id:
            raise BackendError("session_model_mismatch")
        return await owner.accounts.save_session_model(value)

    @app.get("/api/v1/models")
    async def models() -> ModelCatalog:
        return owner.accounts.model_catalog()

    @app.put("/api/v1/providers/{provider}")
    async def configure_provider(provider: str, value: ConfigureProvider) -> ProviderConfigured:
        if provider != value.provider:
            raise BackendError("provider_mismatch")
        return await owner.accounts.configure_provider(value)

    @app.post("/api/v1/providers/{provider}/check")
    async def check_provider(provider: str, value: ProviderCheckRequest) -> ProviderCheck:
        if provider != value.provider:
            raise BackendError("provider_mismatch")
        return await owner.accounts.check_provider(value)

    @app.post("/api/v1/models/scope")
    async def model_scope(value: ModelScopeRequest) -> ModelScope:
        return owner.accounts.model_scope(value)

    @app.post("/api/v1/models")
    async def update_model(value: UpdateModelSettings) -> ModelSettings:
        return await owner.accounts.update_model(value)

    @app.get("/api/v1/accounts")
    async def accounts() -> AccountsView:
        return owner.accounts.account_list()

    @app.post("/api/v1/accounts/oauth")
    async def start_oauth(value: OAuthStart) -> OAuthView:
        return await owner.accounts.start_oauth(value)

    @app.get("/api/v1/accounts/oauth/{login_id}")
    async def oauth_view(login_id: str) -> OAuthView:
        return owner.accounts.oauth_view(login_id)

    @app.post("/api/v1/accounts/oauth/{login_id}/input")
    async def oauth_input(login_id: str, value: OAuthInput) -> OAuthView:
        return await owner.accounts.oauth_input(login_id, value)

    @app.delete("/api/v1/accounts/oauth/{login_id}")
    async def cancel_oauth(login_id: str) -> OAuthView:
        return await owner.accounts.cancel_oauth(login_id)

    @app.post("/api/v1/accounts/{provider}")
    async def update_account(provider: str, value: CredentialUpdate) -> AccountsView:
        return await owner.accounts.update_account(provider, value)

    @app.post("/api/v1/models/credential")
    async def replace_credential(value: CredentialUpdate) -> ModelSettings:
        return await owner.accounts.replace_credential(value)

    @app.get("/api/v1/health")
    async def health() -> Health:
        return await owner.lifecycle.health()

    @app.get("/api/v1/sessions")
    async def sessions() -> SessionList:
        return await owner.sessions.sessions()

    @app.post("/api/v1/sessions", status_code=201)
    async def create(value: CreateSession) -> Session:
        return await owner.sessions.create_session(value)

    @app.get("/api/v1/projects")
    async def projects() -> ProjectList:
        return await owner.content.projects()

    @app.post("/api/v1/projects")
    async def save_project(value: ProjectWrite) -> ProjectView:
        return await owner.content.save_project(value)

    @app.put("/api/v1/projects/{project_id}")
    async def update_project(project_id: str, value: ProjectUpdate) -> ProjectView:
        return await owner.content.update_project(project_id, value)

    @app.put("/api/v1/sessions/{session}/title")
    async def rename_session(session: str, value: RenameSession) -> Session:
        return await owner.sessions.rename_session(session, value)

    @app.delete("/api/v1/sessions/{session}")
    async def remove_session(session: str) -> dict[str, bool]:
        await owner.sessions.remove_session(session)
        return {"removed": True}

    @app.get("/api/v1/settings")
    async def product_settings() -> ProductSettings:
        return await owner.content.product_settings()

    @app.post("/api/v1/settings")
    async def save_product_settings(value: SettingsUpdate) -> ProductSettings:
        return await owner.content.save_product_settings(value)

    @app.put("/api/v1/settings/preferences")
    async def save_preferences(value: PreferencesUpdate) -> ProductSettings:
        return await owner.content.save_preferences(value)

    @app.post("/api/v1/feedback")
    async def save_feedback(value: FeedbackWrite) -> FeedbackView:
        return await owner.content.save_feedback(value)

    @app.get("/api/v1/sessions/{session}/feedback")
    async def answer_feedback(session: str) -> AnswerFeedbackList:
        return await owner.content.answer_feedback(session)

    @app.post("/api/v1/sessions/{session}/feedback")
    async def save_answer_feedback(session: str, value: AnswerFeedbackWrite) -> AnswerFeedback:
        return await owner.content.save_answer_feedback(session, value)

    @app.post("/api/v1/sessions/{session}/shares")
    async def share_session(session: str, value: ShareWrite) -> ShareView:
        return await owner.content.share_session(session, value)

    @app.get("/api/v1/sessions/{session}/shares/{share_id}")
    async def read_share(session: str, share_id: str) -> ShareView:
        return await owner.content.read_share(session, share_id)

    @app.get("/api/v1/export")
    async def export_bundle() -> ExportBundle:
        return await owner.content.export_bundle()

    @app.post("/api/v1/import")
    async def import_bundle(value: ExportBundle) -> ImportResult:
        return await owner.content.import_bundle(value)

    @app.post("/api/v1/sessions/{session}/branches", status_code=201)
    async def branch(session: str, value: BranchSession) -> Session:
        return await owner.sessions.branch_session(session, value)

    @app.post("/api/v1/sessions/{session}/archive")
    async def archive(session: str, value: ArchiveSession) -> Session:
        return await owner.sessions.archive_session(session, value.archived)

    @app.post("/api/v1/sessions/{session}/compactions", status_code=201)
    async def compact(session: str, value: CompactSession) -> Compaction:
        return await owner.sessions.compact_session(session, value)

    @app.post("/api/v1/sessions/{session}/attachments", status_code=201)
    async def attach(session: str) -> Attachment:
        return await owner.sessions.attach_session(session)

    @app.delete("/api/v1/sessions/{session}/attachments/{identity}")
    async def detach(session: str, identity: str, request: Request) -> dict[str, bool]:
        if request.headers.get("x-amazme-attachment", "") != identity:
            raise BackendError("stale_client_binding")
        owner.sessions.release_attachment(session, identity)
        return {"detached": True}

    @app.post("/api/v1/rpc")
    async def rpc(value: RpcCall) -> dict[str, object]:
        return await handle_rpc(owner, value)

    @app.get("/api/v1/plugin-packages")
    async def plugin_packages() -> PluginPackages:
        return await owner.integrations.plugin_packages()

    @app.post("/api/v1/plugin-packages")
    async def add_plugin_package(value: PluginPackageAdd) -> PluginPackages:
        return await owner.integrations.add_plugin_package(value)

    @app.post("/api/v1/plugin-packages/{package_id}/remove")
    async def remove_plugin_package(package_id: str, value: PluginPackageRemove) -> PluginPackages:
        return await owner.integrations.remove_plugin_package(package_id, value)

    @app.get("/api/v1/plugins")
    async def plugins(session_id: str = "") -> PluginList:
        return await owner.integrations.plugins(session_id)

    @app.post("/api/v1/sessions/{session_id}/plugin-packages/load")
    async def load_plugin_packages(session_id: str) -> PluginList:
        return await owner.integrations.load_plugin_packages(session_id)

    @app.post("/api/v1/plugins")
    async def register_plugin(value: PluginDraft) -> PluginView:
        return await owner.integrations.register_plugin(value)

    @app.post("/api/v1/plugins/{plugin_id}/reload")
    async def reload_plugin(plugin_id: str, value: PluginReload) -> PluginView:
        return await owner.integrations.reload_plugin(plugin_id, value)

    @app.post("/api/v1/sessions/{session_id}/plugins/{plugin_id}/calls")
    async def call_plugin(session_id: str, plugin_id: str, value: PluginCallRequest) -> PluginCallView:
        return await owner.integrations.call_plugin(session_id, plugin_id, value)

    @app.post("/api/v1/sessions/{session_id}/plugins/{plugin_id}/close")
    async def close_plugin(session_id: str, plugin_id: str) -> PluginView:
        return await owner.integrations.close_plugin(session_id, plugin_id)

    @app.post("/api/v1/sessions/{session_id}/plugins/{plugin_id}/calls/{call_id}/cancel")
    async def cancel_plugin(session_id: str, plugin_id: str, call_id: str) -> PluginCallView:
        return await owner.integrations.cancel_plugin(session_id, plugin_id, call_id)

    @app.get("/api/v1/sessions/{session_id}/search")
    async def search_session(session_id: str, q: str) -> SearchResults:
        return await owner.sessions.search_session(session_id, q)

    @app.get("/api/v1/sessions/{session}/history")
    async def session_history(session: str, before: str = "") -> HistoryPage:
        return await owner.sessions.session_history(session, before)

    @app.get("/api/v1/sessions/{session}/requests/{request_id}/images/{index}")
    async def input_image(session: str, request_id: str, index: int) -> Response:
        value = await owner.sessions.input_image(session, request_id, index)
        return Response(
            base64.b64decode(value.data_base64, validate=True),
            media_type=value.media_type,
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @app.get("/api/v1/sessions/{session_id}/usage")
    async def session_usage(session_id: str) -> UsageReport:
        return await owner.sessions.session_usage(session_id)

    @app.get("/api/v1/sessions/{session_id}/diagnostics")
    async def session_diagnostic(session_id: str) -> SessionDiagnostic:
        return await owner.sessions.session_diagnostic(session_id)

    @app.get("/api/v1/sessions/{session}/snapshot")
    async def snapshot(session: str) -> Snapshot:
        return await (await owner.access.reader(session)).call("GET", "/snapshot", Snapshot)

    @app.post("/api/v1/sessions/{session}/submissions", status_code=202)
    async def submit(session: str, value: Submit) -> Receipt:
        return await owner.sessions.deliver(session, "submit", value.request_id, value)

    @app.get("/api/v1/sessions/{session}/requests/{request_id}")
    async def lookup(session: str, request_id: str) -> Receipt:
        return await (await owner.access.reader(session)).call(
            "GET", "/requests/" + quote(request_id, safe=""), Receipt
        )

    @app.post("/api/v1/sessions/{session}/requests/{request_id}/cancel", status_code=202)
    async def cancel(session: str, request_id: str) -> Receipt:
        value = Cancel(host_epoch=0, build_id="", request_id=request_id)
        return await owner.sessions.deliver(session, "cancel", request_id, value)

    @app.post("/api/v1/sessions/{session}/approvals", status_code=202)
    async def approve(session: str, value: ApprovalDecision) -> Receipt:
        return await owner.sessions.deliver(session, "approval", value.decision_id, value)

    @app.put("/api/v1/sessions/{session}/approval-policy")
    async def set_approval_policy(session: str, value: SessionApprovalPolicy) -> SessionApprovalPolicy:
        return await owner.access.operate(session, lambda store: store.set_approval_policy(value))

    @app.post("/api/v1/sessions/{session}/effects/resolve", status_code=202)
    async def resolve(session: str, value: EffectResolution) -> Receipt:
        return await owner.sessions.deliver(session, "resolve", value.resolution_id, value)

    @app.websocket("/api/v1/events/{session}")
    async def events(socket: WebSocket, session: str) -> None:
        from amazme_backend.interfaces.http.streams import serve_stream

        if socket.headers.get("origin") != owner.origin or not secrets.compare_digest(
            socket.cookies.get("amazme", ""), owner.web_token
        ):
            await socket.close(code=1008)
            return
        await socket.accept()
        try:
            await serve_stream(owner, socket, session)
        except (WebSocketDisconnect, httpx.TransportError, BackendError, TimeoutError):
            with contextlib.suppress(RuntimeError):
                await socket.close(code=1012)

    @app.post("/control/updates/prepare")
    async def prepare(value: PrepareUpdate) -> UpdateRecord:
        return await owner.updates.prepare_update(value)

    @app.post("/control/updates/{identity}/resume")
    async def resume(identity: str) -> UpdateRecord:
        return await owner.updates.resume_update(identity)

    @app.post("/control/updates/complete")
    async def complete(value: CompleteUpdate) -> UpdateRecord:
        return await owner.updates.complete_update(value)

    @app.get("/control/updates/{identity}")
    async def update(identity: str) -> UpdateRecord:
        return await owner.lifecycle.store.update(identity)

    @app.post("/control/file-writes/prepare")
    async def prepare_tool_write(value: PrepareFileWrite) -> PreparedFileWrite:
        return await owner.workspaces.prepare_tool_write(value)

    @app.post("/control/file-patches/prepare")
    async def prepare_tool_patch(value: PreparePatch) -> PreparedPatch:
        return await owner.workspaces.prepare_tool_patch(value)

    @app.post("/control/code/tool")
    async def code_tool(value: CodeToolDispatch) -> CodeToolReceipt:
        return await owner.sessions.dispatch_code_tool(value)

    @app.post("/control/code/tool/cancel")
    async def cancel_code_tool(value: CodeToolDispatch) -> CodeToolReceipt:
        return await owner.sessions.dispatch_code_tool(value, cancel=True)

    @app.get("/api/v1/sessions/{session_id}/code/tools")
    async def code_tools(session_id: str) -> CodeTools:
        return await owner.integrations.code_tools(session_id)

    @app.post("/control/recover")
    async def recover(value: Recovery) -> Health:
        return await owner.updates.recover(value)

    @app.get("/control/desktop/activity")
    async def desktop_activity() -> TaskActivity:
        return await owner.task_activity()

    @app.post("/control/shutdown")
    async def shutdown(value: HostFence) -> Identity:
        if value != owner.lifecycle.fence:
            raise BackendError("stale_host_epoch")
        await owner.shutdown()
        return owner.lifecycle.identity("stopping")

    @app.get("/", response_class=HTMLResponse)
    @app.get("/index.html", response_class=HTMLResponse)
    async def page(response: Response) -> str:
        try:
            preferences = (await owner.lifecycle.store.product_settings()).preferences
        except BackendError:
            preferences = InterfacePreferences()
        document, policy = boot_document(owner.lifecycle.identity(), owner.origin, preferences)
        response.set_cookie("amazme", owner.web_token, httponly=True, samesite="strict", path="/")
        response.headers["Content-Security-Policy"] = policy
        return document

    app.mount("/client-assets", StaticFiles(directory=package_resource("web")), name="client-assets")
    app.mount("/", StaticFiles(directory=frontend_directory(), html=True, check_dir=False), name="web")
    return app
