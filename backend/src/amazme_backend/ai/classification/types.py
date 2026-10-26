"""Strict classifier questions, answers, model metadata and result values."""
from __future__ import annotations

import time
from typing import Annotated, Literal

from pydantic import Field, JsonValue, model_validator

from amazme_backend.contracts.models import ImagePart
from amazme_backend.shared.model import Model

Probability = Annotated[float, Field(ge=0,le=1,allow_inf_nan=False)]


class ChoiceQuestion(Model):
    type: Literal['choice'] = 'choice'
    instructions: JsonValue
    criteria: dict[str, JsonValue] = Field(min_length=2,max_length=64)


class BoolQuestion(Model):
    type: Literal['bool'] = 'bool'
    instructions: JsonValue
    criteria: dict[Literal['true','false'], JsonValue] = Field(default_factory=lambda:dict[Literal['true','false'], JsonValue]())


class BoxQuestion(Model):
    type: Literal['box'] = 'box'
    instructions: JsonValue


class ScoreQuestion(Model):
    type: Literal['score'] = 'score'
    instructions: JsonValue
    criteria: list[JsonValue] = Field(min_length=2,max_length=10)


Question = Annotated[ChoiceQuestion | BoolQuestion | BoxQuestion | ScoreQuestion,Field(discriminator='type')]


class ClassifierContext(Model):
    state: dict[str, JsonValue]
    questions: dict[str, Question] = Field(min_length=1,max_length=64)
    assets: dict[str, ImagePart] = Field(default_factory=lambda:dict[str, ImagePart](),max_length=8)


class BoolAnswer(Model):
    type: Literal['bool'] = 'bool'
    probability: Probability


class ChoiceAnswer(Model):
    type: Literal['choice'] = 'choice'
    choice: str
    probabilities: dict[str, Probability]
    confidence: Probability


class Box(Model):
    left: Probability
    top: Probability
    right: Probability
    bottom: Probability

    @model_validator(mode='after')
    def edges(self) -> Box:
        if self.left >= self.right or self.top >= self.bottom:
            raise ValueError('box edges must be ordered')
        return self


class BoxAnswer(Model):
    type: Literal['box'] = 'box'
    box: Box
    confidence: Probability


class ScoreAnswer(Model):
    type: Literal['score'] = 'score'
    score: float = Field(allow_inf_nan=False)
    confidence: Probability


Answer = Annotated[BoolAnswer | ChoiceAnswer | BoxAnswer | ScoreAnswer,Field(discriminator='type')]


class ClassifierResult(Model):
    provider: str
    model: str
    answers: dict[str, Answer] = Field(default_factory=lambda:dict[str, Answer]())
    stop_reason: Literal['stop','error','aborted'] = 'stop'
    error: str = ''
    usage: dict[str, JsonValue] = Field(default_factory=lambda:dict[str, JsonValue]())
    timestamp: int = Field(default_factory=lambda:time.time_ns() // 1_000_000)


class ClassifierModel(Model):
    id: str
    provider: str
    name: str
    api: Literal['typesafe-system-one']
    base_url: str = Field(alias='baseUrl')
    input: list[str]
    compat: dict[str, JsonValue] = Field(default_factory=lambda:dict[str, JsonValue]())
    headers: dict[str, str] = Field(default_factory=dict)
    cost: dict[str, JsonValue] = Field(default_factory=lambda:dict[str, JsonValue]())


class ClassifierCatalog(Model):
    models: list[ClassifierModel]
