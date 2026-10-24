"""Async client for one explicit host, session, and workspace."""

import asyncio
import base64
from typing import cast
from urllib.parse import quote

import httpx
from pydantic import JsonValue

from .accounts import AccountsView
from .artifacts import ArtifactBody, ArtifactView
from .contracts import (
    Approval,
    Attachment,
    BackendError,
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
    CredentialUpdate,
    ErrorBody,
    ExportBundle,
    Health,
    Identity,
    ImagePart,
    ImportResult,
    McpCall,
    McpState,
    McpView,
    ModelCatalog,
    ModelSettings,
    PluginCallRequest,
    PluginCallView,
    PluginDraft,
    PluginList,
    PluginReload,
    PluginView,
    Receipt,
    ResourceOptions,
    Session,
    SessionList,
    Snapshot,
    TerminalList,
    TerminalView,
    ThinkingLevel,
    ToolCall,
    UpdateModelSettings,
    UsageReport,
    WorkspaceGrantRequest,
    WorkspaceGrantView,
    WorkspaceList,
    WorkspaceSelect,
)
from .oauth import OAuthInput, OAuthStart, OAuthView
from .resources import ResourceCatalog
from .workspace_files import FileContent


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

    async def session_usage(self, session_id: str) -> UsageReport:
        return UsageReport.model_validate(await self._send("GET", f"/api/v1/sessions/{session_id}/usage"))

    async def health(self) -> Health:
        return Health.model_validate(await self._send("GET", "/api/v1/health"))

    async def export_bundle(self) -> ExportBundle:
        return ExportBundle.model_validate(await self._send("GET", "/api/v1/export"))

    async def import_bundle(self, value: ExportBundle) -> ImportResult:
        return ImportResult.model_validate(await self._send("POST", "/api/v1/import",
            json_body=value.model_dump(mode="json"), headers=self._write()))

    async def computer_policy(self, session_id: str) -> ComputerPolicy:
        return ComputerPolicy.model_validate(await self._send("GET", f"/api/v1/sessions/{session_id}/computer"))

    async def configure_computer(self, session_id: str, attachment_id: str, value: ComputerPolicy) -> ComputerPolicy:
        return ComputerPolicy.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/computer",
            json_body=value.model_dump(mode="json"), headers=self._write(attachment_id)))

    async def observe_computer(self, session_id: str, attachment_id: str, value: ComputerInspect | None = None) -> ComputerObserve:
        return ComputerObserve.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/computer/observe",
            json_body=(value or ComputerInspect()).model_dump(mode="json"), headers=self._write(attachment_id)))

    async def act_computer(self, session_id: str, attachment_id: str, value: ComputerActionRequest) -> ComputerActionView:
        return ComputerActionView.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/computer/actions",
            json_body=value.model_dump(mode="json"), headers=self._write(attachment_id)))

    async def locate_computer(self, session_id: str, workspace: str, attachment_id: str, value: ComputerLocateRequest) -> ComputerActionView:
        await self._require_workspace(session_id,workspace)
        return ComputerActionView.model_validate(await self._send("POST",f"/api/v1/sessions/{session_id}/computer/locate",
            json_body=value.model_dump(mode="json"),headers=self._write(attachment_id)))

    async def ground_computer(self, session_id: str, workspace: str, attachment_id: str, value: ComputerGroundRequest) -> ComputerActionView:
        await self._require_workspace(session_id,workspace)
        return ComputerActionView.model_validate(await self._send("POST",f"/api/v1/sessions/{session_id}/computer/ground",
            json_body=value.model_dump(mode="json"),headers=self._write(attachment_id)))

    async def cleanup_computer(self, session_id: str, attachment_id: str) -> ComputerCleanup:
        return ComputerCleanup.model_validate(await self._send("POST", f"/api/v1/sessions/{session_id}/computer/cleanup",
            json_body={}, headers=self._write(attachment_id)))

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
                     tool_call: ToolCall | None = None) -> Receipt:
        await self._require_workspace(session_id, workspace)
        body: dict[str, object] = {"request_id": request_id, "text": text, "not_before_ms": not_before_ms,
                                   "system_prompt": system_prompt, "append_system_prompt": append_system_prompt, "thinking": thinking,
                                   "allowed_tools": allowed_tools, "excluded_tools": excluded_tools or [],
                                   "resource_options": (resource_options or ResourceOptions()).model_dump(),
                                   "tool_call":tool_call.model_dump() if tool_call is not None else None}
        if images:
            body["images"] = [image.model_dump() for image in images]
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

    async def read_file(self, path: str) -> FileContent:
        payload = await self._send("GET", "/api/v1/files/content?path=" + quote(path, safe=""))
        return FileContent.model_validate(payload)

    async def save_checkpoint(self, *, checkpoint_id: str, workspace: str, path: str) -> CheckpointView:
        payload = await self._send(
            "POST", "/api/v1/checkpoints",
            json_body={"checkpoint_id": checkpoint_id, "workspace": workspace, "path": path},
            headers=self._write())
        return CheckpointView.model_validate(payload)

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

    async def open_mcp(self, *, session_id: str, attachment_id: str, server_id: str, command: str, workspace: str) -> McpView:
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/mcp",
            json_body={"server_id": server_id, "command": command, "workspace": workspace},
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
