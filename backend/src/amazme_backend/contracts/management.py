from __future__ import annotations

from typing import Literal

from pydantic import Field

from amazme_backend.contracts.feedback import AnswerFeedback, FeedbackView
from amazme_backend.contracts.projects import ProjectView
from amazme_backend.contracts.settings import ProductSettings
from amazme_backend.shared.model import Model


class ExportMessage(Model):
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    role: Literal["user", "assistant", "tool"]
    content: str = Field(min_length=1, max_length=16000)


class ExportSession(Model):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    title: str = Field(min_length=1, max_length=100)
    project_id: str = ""
    workspace: str = "primary"
    messages: list[ExportMessage] = Field(default_factory=lambda: list[ExportMessage]())


class ExportBundle(Model):
    format: str = Field(min_length=1, max_length=64)
    digest: str = ""
    projects: list[ProjectView] = Field(default_factory=lambda: list[ProjectView]())
    sessions: list[ExportSession] = Field(default_factory=lambda: list[ExportSession]())
    feedback: list[FeedbackView] = Field(default_factory=lambda: list[FeedbackView]())
    answer_feedback: list[AnswerFeedback] = Field(default_factory=lambda: list[AnswerFeedback]())
    settings: ProductSettings = Field(default_factory=ProductSettings)


class ImportResult(Model):
    format: Literal["amazme-export/1"]
    sessions: int
    created: int
