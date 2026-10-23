"""Async client for one explicit host, session, and workspace."""

import asyncio
from typing import cast

import httpx

from .contracts import Attachment, BackendError, ErrorBody, Identity, ImagePart, Receipt, Session, SessionList


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

    async def sessions(self) -> SessionList:
        return SessionList.model_validate(await self._send("GET", "/api/v1/sessions"))

    async def session(self, session_id: str) -> Session:
        found = next((item for item in (await self.sessions()).sessions if item.session_id == session_id), None)
        if found is None:
            raise BackendError("session_not_found", status=404)
        return found

    async def create_session(self, *, title: str, workspace: str) -> Session:
        if not workspace:
            raise BackendError("workspace_required")
        payload = await self._send("POST", "/api/v1/sessions", json_body={"title": title, "workspace": workspace},
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
                     not_before_ms: int = 0, images: list[ImagePart] | None = None) -> Receipt:
        await self._require_workspace(session_id, workspace)
        body: dict[str, object] = {"request_id": request_id, "text": text, "not_before_ms": not_before_ms}
        if images:
            body["images"] = [image.model_dump() for image in images]
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/submissions",
            json_body=body,
            headers=self._write(attachment_id))
        return Receipt.model_validate(payload)

    async def cancel(self, *, session_id: str, workspace: str, attachment_id: str, request_id: str) -> Receipt:
        await self._require_workspace(session_id, workspace)
        payload = await self._send(
            "POST", f"/api/v1/sessions/{session_id}/requests/{request_id}/cancel",
            headers=self._write(attachment_id))
        return Receipt.model_validate(payload)

    async def request(self, *, session_id: str, request_id: str) -> Receipt:
        payload = await self._send("GET", f"/api/v1/sessions/{session_id}/requests/{request_id}")
        return Receipt.model_validate(payload)

    async def wait(self, *, session_id: str, request_id: str) -> Receipt:
        for _ in range(200):
            receipt = await self.request(session_id=session_id, request_id=request_id)
            if receipt.status in {"succeeded", "cancelled", "interrupted", "failed", "unknown"}:
                return receipt
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
