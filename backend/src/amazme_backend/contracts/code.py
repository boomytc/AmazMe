from __future__ import annotations

from typing import Literal

from pydantic import Field, JsonValue

from amazme_backend.shared.model import Model


class CodeRun(Model):
    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    source: str = Field(min_length=1, max_length=8000)


class CodeTools(Model):
    tools: list[dict[str, JsonValue]] = Field(default_factory=lambda: list[dict[str, JsonValue]]())


class CodeText(Model):
    type: Literal["text"] = "text"
    text: str
    console: bool = False


class CodeImage(Model):
    type: Literal["image"] = "image"
    data: str = Field(max_length=8 * 1024 * 1024, pattern=r"^[A-Za-z0-9+/]*={0,2}$")
    mimeType: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]


class CodeCall(Model):
    name: str
    status: Literal["ok", "error", "cancelled"]
    durationMs: float = Field(ge=0)


class CodeView(Model):
    run_id: str
    phase: Literal["success", "failed", "cancelled", "unknown", "conflict"]
    value: str = ""
    state: str = ""
    output: list[CodeText | CodeImage] = Field(default_factory=lambda: list[CodeText | CodeImage]())
    calls: list[CodeCall] = Field(default_factory=lambda: list[CodeCall]())
    error: str = ""
    # The script service has exited; child tools retain their own independent effect holds.
    clean: bool = False
    cancel_requested: bool = False
