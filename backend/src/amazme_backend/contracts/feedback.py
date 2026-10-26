from __future__ import annotations

from typing import Literal

from pydantic import Field

from amazme_backend.shared.model import Model


class FeedbackWrite(Model):
    feedback_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    session_id: str = ""
    text: str = Field(min_length=1, max_length=4000)


class FeedbackView(Model):
    feedback_id: str
    session_id: str
    text: str


class AnswerFeedbackWrite(Model):
    operation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    rating: Literal["up", "down"] | None = None
    expected_revision: int = Field(ge=0)


class AnswerFeedback(Model):
    operation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")
    rating: Literal["up", "down"] | None = None
    revision: int = Field(ge=1)


class AnswerFeedbackList(Model):
    session_id: str
    records: list[AnswerFeedback] = Field(default_factory=lambda: list[AnswerFeedback]())
