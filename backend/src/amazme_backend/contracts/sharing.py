from __future__ import annotations

from typing import Literal

from pydantic import Field

from amazme_backend.shared.model import Model


class ShareWrite(Model):
    share_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class ShareMessage(Model):
    request_id: str
    role: Literal["user", "assistant", "tool"]
    content: str


class ShareView(Model):
    share_id: str
    session_id: str
    digest: str
    messages: list[ShareMessage] = Field(default_factory=lambda: list[ShareMessage]())
