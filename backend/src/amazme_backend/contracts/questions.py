from __future__ import annotations

from typing import Literal

from pydantic import Field, model_validator

from amazme_backend.shared.model import Model


class QuestionOption(Model):
    label: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    recommended: bool = False


class UserQuestion(Model):
    id: str = Field(min_length=1, max_length=64)
    question: str = Field(min_length=1, max_length=2000)
    header: str = Field(default="", max_length=64)
    options: list[QuestionOption] = Field(default_factory=lambda: list[QuestionOption](), max_length=8)
    multi_select: bool = False

    @model_validator(mode="after")
    def unique_options(self) -> UserQuestion:
        if len({option.label for option in self.options}) != len(self.options):
            raise ValueError("question option labels must be unique")
        return self


class AskUser(Model):
    questions: list[UserQuestion] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def unique_questions(self) -> AskUser:
        if len({question.id for question in self.questions}) != len(self.questions):
            raise ValueError("question ids must be unique")
        if sum(len(question.model_dump_json().encode()) for question in self.questions) > 16000:
            raise ValueError("questions exceed 16000 bytes")
        return self


class UserAnswer(Model):
    id: str = Field(min_length=1, max_length=64)
    selected: list[str] = Field(default_factory=list, max_length=8)
    custom: str = Field(default="", max_length=8000)


class QuestionAnswer(Model):
    decision_id: str = Field(min_length=1, max_length=128)
    question_id: str = Field(min_length=1, max_length=128)
    request_id: str = Field(min_length=1, max_length=128)
    proposal_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    generation: int = Field(ge=1)
    kind: Literal["answered", "skipped"]
    answers: list[UserAnswer] = Field(default_factory=lambda: list[UserAnswer](), max_length=3)

    @model_validator(mode="after")
    def answer_shape(self) -> QuestionAnswer:
        if self.kind == "skipped" and self.answers or self.kind == "answered" and not self.answers:
            raise ValueError("an answer requires values; a skip cannot contain values")
        return self


class QuestionResult(Model):
    kind: Literal["answered", "skipped"]
    answers: list[UserAnswer]
    guidance: str = ""


class QuestionView(AskUser):
    question_id: str
    request_id: str
    proposal_digest: str
    generation: int
    state: Literal["pending", "answered", "skipped"] = "pending"
