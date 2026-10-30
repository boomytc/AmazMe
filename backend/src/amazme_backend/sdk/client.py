"""Async client for one explicit host, session, and workspace."""

import asyncio
import base64
from typing import Literal, cast
from urllib.parse import quote

import httpx
from pydantic import JsonValue

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
from amazme_backend.contracts.artifacts import ArtifactBody, ArtifactView
from amazme_backend.contracts.code import CodeRun, CodeTools, CodeView
from amazme_backend.contracts.events import Snapshot
from amazme_backend.contracts.execution import (
    JobList,
    JobOutput,
    JobOutputView,
    JobView,
    TerminalList,
    TerminalView,
)
from amazme_backend.contracts.feedback import AnswerFeedback, AnswerFeedbackList, AnswerFeedbackWrite
from amazme_backend.contracts.host import Health
from amazme_backend.contracts.identity import Identity
from amazme_backend.contracts.management import ExportBundle, ImportResult
from amazme_backend.contracts.mcp import (
    McpCall,
    McpConfigPatch,
    McpConfiguration,
    McpConfigWrite,
    McpLoginRequest,
    McpReconnect,
    McpState,
    McpView,
)
from amazme_backend.contracts.models import (
    ImagePart,
    ModelCatalog,
    ModelScope,
    ModelScopeRequest,
    ModelSelection,
    ModelSettings,
    ThinkingLevel,
    ToolCall,
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
from amazme_backend.contracts.resources import ResourceCatalog, ResourceOptions
from amazme_backend.contracts.schedules import (
    ScheduleControl,
    ScheduleInput,
    ScheduleNow,
    SchedulesView,
    ScheduleView,
)
from amazme_backend.contracts.sessions import (
    Approval,
    ApprovalPolicy,
    Attachment,
    Compaction,
    CompactSession,
    Receipt,
    Session,
    SessionList,
    UsageReport,
)
from amazme_backend.contracts.workspaces import (
    FILE_READ_LIMIT,
    CheckpointView,
    FileContent,
    FileList,
    WorkspaceGrantRequest,
    WorkspaceGrantView,
    WorkspaceList,
    WorkspaceSelect,
)
from amazme_backend.shared.errors import BackendError, ErrorBody


class Client:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self._http = httpx.AsyncClient(base_url=self.base_url, timeout=30)
        self.build_id = ""
        self.host_epoch = 0

    async def __aenter__(self) -> "Client":
        await self.bootstrap()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self._http.aclose()

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    def _write(self, attachment_id: str = "") -> dict[str, str]:
        headers = {**self._auth(), "x-amazme-build": self.build_id, "x-amazme-epoch": str(self.host_epoch)}
        if attachment_id:
            headers["x-amazme-attachment"] = attachment_id
        return headers

    async def _send(self, method: str, path: str, *, json_body: object | None = None,
                    headers: dict[str, str] | None = None) -> object:
        response = await self._http.request(method, path, json=json_body, headers=headers or self._auth())
        payload: object = response.json()
        if response.status_code >= 400:
            if isinstance(payload, dict):
                body = ErrorBody.model_validate(payload)
                raise BackendError(body.code, body.message, response.status_code)
            raise BackendError("request_failed", status=response.status_code)
        return payload

    async def bootstrap(self) -> Identity:
        identity = Identity.model_validate(await self._send("GET", "/api/v1/bootstrap"))
        self.build_id = identity.build_id
        self.host_epoch = identity.host_epoch
        return identity

    async def resources(self, session_id: str, options: ResourceOptions | None = None) -> ResourceCatalog:
        if options is None:
            return ResourceCatalog.model_validate(await self._send("GET", f"/api/v1/sessions/{session_id}/resources"))
        return ResourceCatalog.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/resources",
            json_body=options.model_dump(), headers=self._write()))

    async def compact(self, session_id: str, workspace: str, attachment_id: str, value: CompactSession) -> Compaction:
        await self._require_workspace(session_id, workspace)
        return Compaction.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/compactions",
            json_body=value.model_dump(), headers=self._write(attachment_id)))

    async def answer_feedback(self, session_id: str) -> AnswerFeedbackList:
        return AnswerFeedbackList.model_validate(await self._send("GET", f"/api/v1/sessions/{session_id}/feedback"))

    async def check_provider(self, value: ProviderCheckRequest) -> ProviderCheck:
        return ProviderCheck.model_validate(await self._send("POST", f"/api/v1/providers/{quote(value.provider, safe='')}/check",
            json_body=value.model_dump(), headers=self._write()))

    async def save_answer_feedback(self, session_id: str, workspace: str, attachment_id: str, value: AnswerFeedbackWrite) -> AnswerFeedback:
        await self._require_workspace(session_id, workspace)
        return AnswerFeedback.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/feedback",
            json_body=value.model_dump(), headers=self._write(attachment_id)))

    async def workspaces(self) -> WorkspaceList:
        return WorkspaceList.model_validate(await self._send("GET", "/api/v1/workspaces"))

    async def select_workspace(self, host_path: str, name: str = "") -> WorkspaceGrantView:
        value = WorkspaceSelect(host_path=host_path, name=name)
        return WorkspaceGrantView.model_validate(await self._send("POST", "/api/v1/workspaces/select",
            json_body=value.model_dump(), headers=self._write()))

    async def add_workspace(self, value: WorkspaceGrantRequest) -> WorkspaceGrantView:
        return WorkspaceGrantView.model_validate(await self._send("POST", "/api/v1/workspaces",
            json_body=value.model_dump(), headers=self._write()))

    async def remove_workspace(self, name: str) -> None:
        await self._send("DELETE", "/api/v1/workspaces/" + quote(name, safe=""), headers=self._write())

    async def plugins(self, session_id: str = "") -> PluginList:
        return PluginList.model_validate(await self._send("GET", "/api/v1/plugins" + ("?session_id=" + quote(session_id, safe="") if session_id else "")))

    async def code_tools(self, session_id: str, workspace: str) -> CodeTools:
        await self._require_workspace(session_id, workspace)
        return CodeTools.model_validate(await self._send("GET", f"/api/v1/sessions/{session_id}/code/tools"))

    async def run_code(self, session_id: str, workspace: str, attachment_id: str, value: CodeRun) -> CodeView:
        await self._require_workspace(session_id, workspace)
        return CodeView.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/code",
            json_body=value.model_dump(mode="json"), headers=self._write(attachment_id)))

    async def cancel_code(self, session_id: str, workspace: str, attachment_id: str, run_id: str) -> CodeView:
        await self._require_workspace(session_id, workspace)
        return CodeView.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/code/{run_id}/cancel",
            json_body={}, headers=self._write(attachment_id)))

    async def plugin_packages(self) -> PluginPackages:
        return PluginPackages.model_validate(await self._send("GET", "/api/v1/plugin-packages"))

    async def add_plugin_package(self, value: PluginPackageAdd) -> PluginPackages:
        return PluginPackages.model_validate(await self._send("POST", "/api/v1/plugin-packages",
            json_body=value.model_dump(), headers=self._write()))

    async def remove_plugin_package(self, package_id: str, value: PluginPackageRemove) -> PluginPackages:
        return PluginPackages.model_validate(await self._send("POST", f"/api/v1/plugin-packages/{quote(package_id, safe='')}/remove",
            json_body=value.model_dump(), headers=self._write()))

    async def load_plugin_packages(self, session_id: str, workspace: str, attachment_id: str) -> PluginList:
        await self._require_workspace(session_id, workspace)
        return PluginList.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/plugin-packages/load",
            headers=self._write(attachment_id)))

    async def register_plugin(self, value: PluginDraft) -> PluginView:
        return PluginView.model_validate(await self._send("POST", "/api/v1/plugins",
            json_body=value.model_dump(mode="json"), headers=self._write()))

    async def reload_plugin(self, plugin_id: str, value: PluginReload) -> PluginView:
        return PluginView.model_validate(await self._send("POST", f"/api/v1/plugins/{plugin_id}/reload",
            json_body=value.model_dump(mode="json"), headers=self._write()))

    async def call_plugin(self, session_id: str, workspace: str, attachment_id: str, plugin_id: str,
                          value: PluginCallRequest) -> PluginCallView:
        await self._require_workspace(session_id, workspace)
        return PluginCallView.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/plugins/{plugin_id}/calls",
            json_body=value.model_dump(mode="json"), headers=self._write(attachment_id)))

    async def close_plugin(self, session_id: str, workspace: str, attachment_id: str, plugin_id: str) -> PluginView:
        await self._require_workspace(session_id, workspace)
        return PluginView.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/plugins/{plugin_id}/close",
            json_body={}, headers=self._write(attachment_id)))

    async def cancel_plugin(self, session_id: str, workspace: str, attachment_id: str,
                            plugin_id: str, call_id: str) -> PluginCallView:
        await self._require_workspace(session_id, workspace)
        return PluginCallView.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/plugins/{plugin_id}/calls/{call_id}/cancel",
            json_body={}, headers=self._write(attachment_id)))

    async def models(self) -> ModelCatalog:
        return ModelCatalog.model_validate(await self._send("GET", "/api/v1/models"))

    async def configure_provider(self, value: ConfigureProvider) -> ProviderConfigured:
        return ProviderConfigured.model_validate(await self._send("PUT", "/api/v1/providers/" + quote(value.provider, safe=""),
            json_body=value.model_dump(mode="json"), headers=self._write()))

    async def schedules(self) -> SchedulesView:
        return SchedulesView.model_validate(await self._send("GET", "/api/v1/schedules"))

    async def save_schedule(self, value: ScheduleInput) -> ScheduleView:
        return ScheduleView.model_validate(await self._send("POST", "/api/v1/schedules",
            json_body=value.model_dump(mode="json"), headers=self._write()))

    async def run_schedule(self, schedule_id: str, value: ScheduleNow) -> ScheduleView:
        return ScheduleView.model_validate(await self._send("POST", f"/api/v1/schedules/{quote(schedule_id, safe='')}/run",
            json_body=value.model_dump(mode="json"), headers=self._write()))

    async def control_schedule(self, schedule_id: str, value: ScheduleControl,
                               action: Literal["enabled", "cancel", "remove"]) -> ScheduleView:
        return ScheduleView.model_validate(await self._send("POST", f"/api/v1/schedules/{quote(schedule_id, safe='')}/{action}",
            json_body=value.model_dump(mode="json"), headers=self._write()))

    async def model_scope(self, patterns: list[str], *, provider: str = "") -> ModelScope:
        value = ModelScopeRequest(patterns=patterns, provider=provider)
        return ModelScope.model_validate(await self._send("POST", "/api/v1/models/scope",
            json_body=value.model_dump(), headers=self._write()))

    async def session_usage(self, session_id: str) -> UsageReport:
        return UsageReport.model_validate(await self._send("GET", f"/api/v1/sessions/{session_id}/usage"))

    async def health(self) -> Health:
        return Health.model_validate(await self._send("GET", "/api/v1/health"))

    async def export_bundle(self) -> ExportBundle:
        return ExportBundle.model_validate(await self._send("GET", "/api/v1/export"))

    async def import_bundle(self, value: ExportBundle) -> ImportResult:
        return ImportResult.model_validate(await self._send("POST", "/api/v1/import",
            json_body=value.model_dump(mode="json"), headers=self._write()))

    async def update_model(self, value: UpdateModelSettings) -> ModelSettings:
        return ModelSettings.model_validate(await self._send("POST", "/api/v1/models",
            json_body=value.model_dump(mode="json"), headers=self._write()))

    async def accounts(self) -> AccountsView:
        return AccountsView.model_validate(await self._send("GET", "/api/v1/accounts"))

    async def update_account(self, provider: str, value: CredentialUpdate) -> AccountsView:
        return AccountsView.model_validate(await self._send("POST", "/api/v1/accounts/" + quote(provider, safe=""),
            json_body={**value.model_dump(mode="json"), "api_key": value.api_key.get_secret_value()}, headers=self._write()))

    async def start_oauth(self, value: OAuthStart) -> OAuthView:
        return OAuthView.model_validate(await self._send("POST", "/api/v1/accounts/oauth",
            json_body=value.model_dump(mode="json"), headers=self._write()))

    async def oauth(self, login_id: str) -> OAuthView:
        return OAuthView.model_validate(await self._send("GET", "/api/v1/accounts/oauth/" + quote(login_id, safe="")))

    async def oauth_input(self, login_id: str, value: OAuthInput) -> OAuthView:
        return OAuthView.model_validate(await self._send("POST", "/api/v1/accounts/oauth/" + quote(login_id, safe="") + "/input",
            json_body={"value": value.value.get_secret_value()}, headers=self._write()))

    async def cancel_oauth(self, login_id: str) -> OAuthView:
        return OAuthView.model_validate(await self._send("DELETE", "/api/v1/accounts/oauth/" + quote(login_id, safe=""),
            headers=self._write()))

    async def sessions(self) -> SessionList:
        return SessionList.model_validate(await self._send("GET", "/api/v1/sessions"))

    async def session(self, session_id: str) -> Session:
        found = next((item for item in (await self.sessions()).sessions if item.session_id == session_id), None)
        if found is None:
            raise BackendError("session_not_found", status=404)
        return found

    async def create_session(self, *, title: str, workspace: str, session_id: str = "") -> Session:
        if not workspace:
            raise BackendError("workspace_required")
        payload = await self._send("POST", "/api/v1/sessions", json_body={"title": title, "workspace": workspace, "session_id": session_id},
                                   headers=self._write())
        return Session.model_validate(payload)

    async def attach(self, session_id: str) -> Attachment:
        payload = await self._send("POST", f"/api/v1/sessions/{session_id}/attachments", headers=self._write())
        return Attachment.model_validate(payload)

    async def release(self, *, session_id: str, attachment_id: str) -> None:
        """Drop this binding. The attachment header is the binding being released, not a cancel."""
        await self._send(
            "DELETE", f"/api/v1/sessions/{session_id}/attachments/{attachment_id}",
            headers=self._write(attachment_id))

    async def _require_workspace(self, session_id: str, workspace: str) -> None:
        if not workspace:
            raise BackendError("workspace_required")
        current = await self.session(session_id)
        if current.workspace != workspace:
            raise BackendError("workspace_mismatch")

    async def submit(self, *, session_id: str, workspace: str, attachment_id: str, request_id: str, text: str,
                     not_before_ms: int = 0, images: list[ImagePart] | None = None,
                     system_prompt: str | None = None, append_system_prompt: str = "",
                     allowed_tools: list[str] | None = None, excluded_tools: list[str] | None = None,
                     resource_options: ResourceOptions | None = None, thinking: ThinkingLevel | None = None,
                     tool_call: ToolCall | None = None, model_selection: ModelSelection | None = None,
                     approval_policy: ApprovalPolicy | None = None, time_zone: str = "") -> Receipt:
        await self._require_workspace(session_id, workspace)
        body: dict[str, object] = {"request_id": request_id, "text": text, "not_before_ms": not_before_ms, "time_zone": time_zone,
                                   "system_prompt": system_prompt, "append_system_prompt": append_system_prompt, "thinking": thinking,
                                   "allowed_tools": allowed_tools, "excluded_tools": excluded_tools or [],
                                   "resource_options": (resource_options or ResourceOptions()).model_dump(),
                                   "model_selection":model_selection.model_dump() if model_selection is not None else None,
                                   "tool_call":tool_call.model_dump() if tool_call is not None else None}
        if images:
            body["images"] = [image.model_dump() for image in images]
        if approval_policy is not None:
            body["approval_policy"] = approval_policy
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/submissions",
            json_body=body,
            headers=self._write(attachment_id))
        return Receipt.model_validate(payload)

    async def put_artifact(self, *, session_id: str, workspace: str, attachment_id: str, artifact_id: str,
                           name: str, data: bytes, media_type: str = "application/octet-stream") -> ArtifactView:
        await self._require_workspace(session_id, workspace)
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/artifacts",
            json_body={
                "artifact_id": artifact_id, "name": name, "media_type": media_type,
                "data_base64": base64.b64encode(data).decode(),
            },
            headers=self._write(attachment_id))
        return ArtifactView.model_validate(payload)

    async def artifact(self, *, session_id: str, artifact_id: str) -> ArtifactBody:
        payload = await self._send("GET", f"/api/v1/sessions/{session_id}/artifacts/{artifact_id}")
        return ArtifactBody.model_validate(payload)

    async def cancel(self, *, session_id: str, workspace: str, attachment_id: str, request_id: str) -> Receipt:
        await self._require_workspace(session_id, workspace)
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/requests/{request_id}/cancel",
            headers=self._write(attachment_id))
        return Receipt.model_validate(payload)

    async def request(self, *, session_id: str, request_id: str) -> Receipt:
        payload = await self._send("GET", f"/api/v1/sessions/{session_id}/requests/{request_id}")
        return Receipt.model_validate(payload)

    async def wait(self, *, session_id: str, request_id: str, attempts: int = 200) -> Receipt:
        for _ in range(attempts):
            receipt = await self.request(session_id=session_id, request_id=request_id)
            if receipt.status in {"succeeded", "cancelled", "interrupted", "failed", "unknown"}:
                return receipt
            await asyncio.sleep(0.05)
        raise BackendError("request_pending", status=503)

    async def snapshot(self, session_id: str) -> Snapshot:
        payload = await self._send("GET", f"/api/v1/sessions/{session_id}/snapshot")
        return Snapshot.model_validate(payload)

    async def await_user_decision(self, *, session_id: str, request_id: str, attempts: int = 200) -> tuple[Receipt, Approval | None]:
        """Return a pending approval, or the terminal receipt. Waiting is not a grant."""
        for _ in range(attempts):
            receipt = await self.request(session_id=session_id, request_id=request_id)
            if receipt.status in {"succeeded", "cancelled", "interrupted", "failed", "unknown"}:
                return receipt, None
            if receipt.status == "waiting_approval":
                pending = next((
                    item for item in (await self.snapshot(session_id)).approvals
                    if item.request_id == request_id and item.state == "pending"), None)
                if pending is not None:
                    return receipt, pending
            await asyncio.sleep(0.05)
        raise BackendError("request_pending", status=503)

    async def decide(self, *, session_id: str, attachment_id: str, decision_id: str, approval_id: str,
                     expected_revision: str, proposal_digest: str, approve: bool) -> Receipt:
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/approvals",
            json_body={
                "decision_id": decision_id, "approval_id": approval_id,
                "expected_revision": expected_revision, "proposal_digest": proposal_digest, "approve": approve,
            },
            headers=self._write(attachment_id))
        return Receipt.model_validate(payload)

    async def read_file(self, path: str, *, offset: int = 0, limit: int = FILE_READ_LIMIT) -> FileContent:
        payload = await self._send(
            "GET", "/api/v1/files/content?path=" + quote(path, safe="") + "&offset=" + str(offset) + "&limit=" + str(limit))
        return FileContent.model_validate(payload)

    async def list_files(self, path: str = "", *, offset: int = 0) -> FileList:
        return FileList.model_validate(await self._send("GET", "/api/v1/files?path=" + quote(path, safe="") + "&offset=" + str(offset)))

    async def save_checkpoint(self, *, checkpoint_id: str, workspace: str, path: str) -> CheckpointView:
        payload = await self._send(
            "POST", "/api/v1/checkpoints",
            json_body={"checkpoint_id": checkpoint_id, "workspace": workspace, "path": path},
            headers=self._write())
        return CheckpointView.model_validate(payload)

    async def list_jobs(self, session_id: str) -> JobList:
        return JobList.model_validate(await self._send("GET", f"/api/v1/sessions/{session_id}/jobs"))

    async def job_output(self, session_id: str, job_id: str, *, stream: Literal["stdout", "stderr"] = "stdout",
                         offset: int = 0, limit: int = 16000) -> JobOutputView:
        query = JobOutput(job_id=job_id, stream=stream, offset=offset, limit=limit)
        payload = await self._send("GET", f"/api/v1/sessions/{session_id}/jobs/{quote(query.job_id, safe='')}/output"
                                   f"?stream={query.stream}&offset={query.offset}&limit={query.limit}")
        return JobOutputView.model_validate(payload)

    async def kill_job(self, *, session_id: str, attachment_id: str, job_id: str) -> JobView:
        payload = await self._send("POST", f"/api/v1/sessions/{session_id}/jobs/{quote(job_id, safe='')}/kill",
                                   headers=self._write(attachment_id))
        return JobView.model_validate(payload)

    async def list_terminals(self, session_id: str) -> TerminalList:
        payload = await self._send("GET", f"/api/v1/sessions/{session_id}/terminals")
        return TerminalList.model_validate(payload)

    async def open_terminal(self, *, session_id: str, attachment_id: str, terminal_id: str, command: str,
                            cols: int, rows: int, workspace: str) -> TerminalView:
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/terminals",
            json_body={"terminal_id": terminal_id, "command": command, "cols": cols, "rows": rows, "workspace": workspace},
            headers=self._write(attachment_id))
        return TerminalView.model_validate(payload)

    async def write_terminal(self, *, session_id: str, attachment_id: str, terminal_id: str,
                             input_id: str, data: str) -> TerminalView:
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/terminals/{terminal_id}/input",
            json_body={"input_id": input_id, "data": data},
            headers=self._write(attachment_id))
        return TerminalView.model_validate(payload)

    async def read_terminal(self, *, session_id: str, attachment_id: str, terminal_id: str) -> TerminalView:
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/terminals/{terminal_id}/read",
            headers=self._write(attachment_id))
        return TerminalView.model_validate(payload)

    async def resize_terminal(self, *, session_id: str, attachment_id: str, terminal_id: str,
                              cols: int, rows: int) -> TerminalView:
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/terminals/{terminal_id}/resize",
            json_body={"cols": cols, "rows": rows},
            headers=self._write(attachment_id))
        return TerminalView.model_validate(payload)

    async def close_terminal(self, *, session_id: str, attachment_id: str, terminal_id: str) -> TerminalView:
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/terminals/{terminal_id}/close",
            headers=self._write(attachment_id))
        return TerminalView.model_validate(payload)

    async def mcp_state(self, session_id: str) -> McpState:
        payload = await self._send("GET", f"/api/v1/sessions/{session_id}/mcp")
        return McpState.model_validate(payload)

    async def mcp_configuration(self, session_id: str = "") -> McpConfiguration:
        path = f"/api/v1/sessions/{session_id}/mcp-configuration" if session_id else "/api/v1/mcp-configuration"
        return McpConfiguration.model_validate(await self._send("GET", path))

    async def mcp_login(self, value: McpLoginRequest) -> OAuthView:
        return OAuthView.model_validate(await self._send("POST", "/api/v1/mcp-configuration/logins", json_body=value.model_dump(), headers=self._write()))

    async def mcp_login_status(self, login_id: str) -> OAuthView:
        return OAuthView.model_validate(await self._send("GET", f"/api/v1/mcp-configuration/logins/{login_id}"))

    async def mcp_login_input(self, login_id: str, value: OAuthInput) -> OAuthView:
        return OAuthView.model_validate(await self._send("POST", f"/api/v1/mcp-configuration/logins/{login_id}/input", json_body={"value": value.value.get_secret_value()}, headers=self._write()))

    async def mcp_login_cancel(self, login_id: str) -> OAuthView:
        return OAuthView.model_validate(await self._send("DELETE", f"/api/v1/mcp-configuration/logins/{login_id}", headers=self._write()))

    async def change_mcp_configuration(self, session_id: str, workspace: str, attachment_id: str,
                                       value: McpConfigWrite | McpConfigPatch) -> McpConfiguration:
        if session_id:
            await self._require_workspace(session_id, workspace)
        elif workspace or attachment_id:
            raise BackendError("binding_required")
        return McpConfiguration.model_validate(await self._send("POST" if isinstance(value, McpConfigWrite) else "PATCH",
            f"/api/v1/sessions/{session_id}/mcp-configuration" if session_id else "/api/v1/mcp-configuration", json_body=value.model_dump(mode="json", by_alias=True),
            headers=self._write(attachment_id)))

    async def reload_mcp_configuration(self, session_id: str, workspace: str, attachment_id: str) -> McpState:
        await self._require_workspace(session_id, workspace)
        return McpState.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/mcp-configuration/reload",
            headers=self._write(attachment_id)))

    async def reconnect_mcp(self, session_id: str, workspace: str, attachment_id: str, value: McpReconnect) -> McpView:
        await self._require_workspace(session_id, workspace)
        return McpView.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/mcp-configuration/reconnect",
            json_body=value.model_dump(), headers=self._write(attachment_id)))

    async def open_mcp(self, *, session_id: str, attachment_id: str, server_id: str, command: str, workspace: str,
                       cwd: str = "", environment: dict[str, str] | None = None) -> McpView:
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/mcp",
            json_body={"server_id": server_id, "command": command, "workspace": workspace,
                       "cwd": cwd, "environment": environment or {}},
            headers=self._write(attachment_id))
        return McpView.model_validate(payload)

    async def request_mcp(self, *, session_id: str, attachment_id: str, server_id: str, call_id: str,
                          name: str, arguments: dict[str, JsonValue]) -> McpCall:
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/mcp/{server_id}/calls",
            json_body={"call_id": call_id, "name": name, "arguments": arguments, "origin": "manual"},
            headers=self._write(attachment_id))
        return McpCall.model_validate(payload)

    async def decide_mcp(self, *, session_id: str, attachment_id: str, server_id: str, call_id: str,
                         decision_id: str, digest: str, approve: bool) -> McpCall:
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/mcp/{server_id}/calls/{call_id}/decision",
            json_body={"decision_id": decision_id, "approve": approve, "digest": digest},
            headers=self._write(attachment_id))
        return McpCall.model_validate(payload)

    async def close_mcp(self, *, session_id: str, attachment_id: str, server_id: str) -> McpView:
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/mcp/{server_id}/cancel",
            headers=self._write(attachment_id))
        return McpView.model_validate(payload)

    async def await_mcp(self, session_id: str, call_id: str, attempts: int = 200) -> McpCall:
        for _ in range(attempts):
            found = next((item for item in (await self.mcp_state(session_id)).calls if item.call_id == call_id), None)
            if found is None:
                raise BackendError("mcp_call_not_found", status=404)
            if found.phase in {"done", "denied", "unknown", "conflict"}:
                return found
            await asyncio.sleep(0.05)
        raise BackendError("request_pending", status=503)

    async def rpc(self, method: str, **params: object) -> dict[str, object]:
        body = {"jsonrpc": "2.0", "id": method, "method": method, "params": params}
        attachment = str(params.get("attachment_id") or "")
        payload = await self._send("POST", "/api/v1/rpc", json_body=body, headers=self._write(attachment))
        if not isinstance(payload, dict):
            raise BackendError("invalid_rpc_result")
        record = {str(key): value for key, value in cast(dict[object, object], payload).items()}
        error = record.get("error")
        if isinstance(error, dict):
            message = cast(dict[object, object], error).get("message")
            raise BackendError(str(message or "rpc_error"))
        result = record.get("result")
        if not isinstance(result, dict):
            raise BackendError("invalid_rpc_result")
        return {str(key): value for key, value in cast(dict[object, object], result).items()}
