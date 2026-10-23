"""JSON-RPC over the product host. Every call names its session and workspace."""

import json
from typing import Literal, Protocol, cast

from pydantic import Field

from .contracts import (
    Attachment,
    BackendError,
    Cancel,
    CreateSession,
    Model,
    Receipt,
    Session,
    SessionList,
    Submit,
)


class RpcParams(Model):
    session_id: str = ""
    workspace: str = ""
    attachment_id: str = ""
    request_id: str = ""
    title: str = ""
    text: str = ""
    not_before_ms: int = 0


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
    async def sessions(self) -> SessionList: ...

    async def create_session(self, value: CreateSession) -> Session: ...

    def check_attachment(self, identity: str, session: str) -> Attachment: ...

    def release_attachment(self, session: str, attachment_id: str) -> None: ...

    async def deliver(self, session: str, kind: Literal["submit", "cancel", "approval", "resolve"],
                      key: str, value: Model) -> Receipt: ...


async def _workspace(owner: RpcHost, session_id: str) -> str:
    listed = await owner.sessions()
    found = next((item for item in listed.sessions if item.session_id == session_id), None)
    if found is None:
        raise BackendError("session_not_found", status=404)
    return found.workspace


def _require_workspace(params: RpcParams) -> None:
    if not params.workspace:
        raise BackendError("workspace_required")


async def handle_rpc(owner: RpcHost, call: RpcCall) -> dict[str, object]:
    if call.jsonrpc != "2.0" or not call.id or not call.method:
        return rpc_error(call.id or "0", "invalid_rpc")
    params = call.params
    try:
        if call.method == "session.create":
            _require_workspace(params)
            created = await owner.create_session(CreateSession(title=params.title or "新会话", workspace=params.workspace))
            return rpc_result(call.id, created)
        if call.method == "session.release":
            if not params.session_id or not params.attachment_id:
                raise BackendError("binding_required")
            owner.release_attachment(params.session_id, params.attachment_id)
            return {"jsonrpc": "2.0", "id": call.id, "result": {"detached": True, "cancelled": False}}
        if call.method in {"request.submit", "request.cancel"}:
            _require_workspace(params)
            if not params.session_id or not params.attachment_id or not params.request_id:
                raise BackendError("binding_required")
            if await _workspace(owner, params.session_id) != params.workspace:
                raise BackendError("workspace_mismatch")
            owner.check_attachment(params.attachment_id, params.session_id)
            if call.method == "request.submit":
                if not params.text:
                    raise BackendError("missing_user_context")
                receipt = await owner.deliver(
                    params.session_id, "submit", params.request_id,
                    Submit(request_id=params.request_id, text=params.text, not_before_ms=params.not_before_ms))
            else:
                receipt = await owner.deliver(
                    params.session_id, "cancel", params.request_id,
                    Cancel(host_epoch=0, build_id="", request_id=params.request_id))
            return rpc_result(call.id, receipt)
        return rpc_error(call.id, "method_not_found")
    except BackendError as exc:
        return rpc_error(call.id, exc.code)
