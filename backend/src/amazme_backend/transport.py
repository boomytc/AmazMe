import asyncio
import secrets
from collections.abc import Mapping
from re import fullmatch

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .contracts import IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, BackendError, ErrorBody

DEFAULT_BODY_BYTES = 256 * 1024
MEDIA_BODY_BYTES = IMAGE_MAX_COUNT * ((IMAGE_MAX_BYTES + 2) // 3 * 4) + 1024 * 1024
DOCUMENT_BODY_BYTES = 32 * 1024 * 1024
CONFIG_BODY_BYTES = 16 * 1024 * 1024


class BoundedHTTP:
    def __init__(self, app: ASGIApp, token: str = "", body_limits: Mapping[str, int] | None = None):
        self.app, self.token = app, token
        self.body_limits = dict(body_limits or {})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope["headers"])
        if self.token and not secrets.compare_digest(headers.get(b"authorization", b""),
                                                    ("Bearer " + self.token).encode()):
            await JSONResponse(ErrorBody(code="unauthenticated", message="Authentication required").model_dump(),
                               status_code=401)(scope, receive, send)
            return
        chunks: list[bytes] = []
        size = 0
        limit = next((limit for pattern, limit in self.body_limits.items()
                      if scope["method"] == "POST" and fullmatch(pattern, scope["path"])), DEFAULT_BODY_BYTES)
        try:
            async with asyncio.timeout(10):
                while True:
                    part = await receive()
                    if part["type"] == "http.disconnect":
                        return
                    body = part.get("body", b"")
                    size += len(body)
                    if size > limit:
                        await JSONResponse({"code": "request_too_large", "message": f"Request body exceeds {limit} bytes"},
                                           status_code=413)(scope, receive, send)
                        return
                    chunks.append(body)
                    if not part.get("more_body", False):
                        break
        except TimeoutError:
            await JSONResponse({"code": "request_timeout", "message": "Request body timeout"},
                               status_code=408)(scope, receive, send)
            return
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()
        await self.app(scope, replay, send)


def app_factory(token: str = "", *, body_limits: Mapping[str, int] | None = None) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None)
    app.add_middleware(BoundedHTTP, token=token, body_limits=body_limits)

    @app.exception_handler(BackendError)
    async def backend_error(_request: Request, error: BackendError) -> JSONResponse:
        return JSONResponse(ErrorBody(code=error.code, message=error.message,
                                      retryable=error.status in {429, 503, 504}).model_dump(), status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, _error: RequestValidationError) -> JSONResponse:
        # Validation input can be a credential. The response keeps only the code.
        return JSONResponse(ErrorBody(code="invalid_request", message="invalid_request").model_dump(), status_code=422)

    return app
