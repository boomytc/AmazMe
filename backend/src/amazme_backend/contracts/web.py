from __future__ import annotations

from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field

from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model


class WebSearch(Model):
    query: str = Field(min_length=1, max_length=512)
    count: int | None = Field(default=None, ge=1, le=50)


class WebFetch(Model):
    url: str = Field(min_length=1, max_length=8192)


class WebPolicy(Model):
    enabled: bool = False
    base_url: str = "https://api.deepseek.com/v1/tools"
    count: int = Field(default=10, ge=1, le=50)
    send_original_question: bool = True
    timeout_ms: int = Field(default=30000, ge=1, le=300000)
    max_response_bytes: int = Field(default=2097152, ge=1, le=16777216)
    max_content_chars: int = Field(default=20000, ge=1, le=200000)


class WebCallRequest(Model):
    call_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    kind: Literal["search", "fetch"]
    query: str = ""
    url: str = ""
    count: int | None = Field(default=None, ge=1, le=50)


class WebCallView(Model):
    call_id: str
    session_id: str
    kind: Literal["search", "fetch"]
    phase: Literal["unknown", "done", "failed"]
    error: str = ""
    result: str = ""


def validate_base_url(value: str) -> str:
    if len(value) > 8192:
        raise BackendError("web_address")
    parsed = urlsplit(value)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment):
        raise BackendError("web_address")
    return value.rstrip("/")


def validate_fetch_url(value: str) -> str:
    if not value or len(value) > 8192:
        raise BackendError("web_address")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise BackendError("web_address")
    return value
