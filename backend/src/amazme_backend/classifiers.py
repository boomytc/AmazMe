"""Pi System One questions and typed answers; credentials remain in the existing account vault."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Annotated, Literal

import httpx
from pydantic import Field, JsonValue, TypeAdapter, model_validator

from .accounts import AccountStore, ApiKeyCredential
from .contracts import BackendError, ImagePart, Model, checked_images

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


MODELS = TypeAdapter(list[ClassifierModel]).validate_json(Path(__file__).with_name('classifier_catalog.json').read_bytes())
INDEX = {(model.provider,model.id):model for model in MODELS}
RECORD = TypeAdapter(dict[str, JsonValue])
ANSWER = TypeAdapter(Answer)


def wire_request(model: ClassifierModel, context: ClassifierContext) -> tuple[dict[str, object], dict[str, str]]:
    questions = {name:{**question.model_dump(mode='json'),'type':'noul' if isinstance(question,BoolQuestion) else question.type}
                 for name,question in context.questions.items()}
    payload: dict[str, object] = {'model':model.id,'state':context.state,'questions':questions}
    headers: dict[str,str] = {}
    if context.assets:
        if 'image' not in model.input or model.compat.get('imageInput','assets') != 'assets':
            raise BackendError('classifier_image_unsupported')
        checked_images(list(context.assets.values()))
        references: list[str] = []
        def collect(value: JsonValue) -> None:
            if isinstance(value,str):
                references.append(value)
            elif isinstance(value,dict):
                for item in value.values():
                    collect(item)
            elif isinstance(value,list):
                for item in value:
                    collect(item)
        collect(context.state)
        for question in context.questions.values():
            collect(question.instructions)
            if not isinstance(question,BoxQuestion):
                collect(question.model_dump(mode='json')['criteria'])
        total = 0
        assets: dict[str, object] = {}
        for reference,image in context.assets.items():
            total += len(reference.encode())
            if not reference.strip() or len(reference.encode()) > 1024 or total > 65536 or not any(reference in value for value in references):
                raise BackendError('classifier_image_reference')
            if image.media_type not in {'image/png','image/jpeg'}:
                raise BackendError('classifier_image_unsupported')
            assets[reference] = {'type':'image','format':'png' if image.media_type == 'image/png' else 'jpg','data_base64':image.data_base64}
        payload['assets'] = assets
    if context.assets or any(isinstance(question,BoxQuestion) for question in context.questions.values()):
        if model.compat.get('sendImageOptInHeader',True):
            headers['TypeSafe-Danger-Zone-Images'] = 'true'
    return payload,headers


def parse_answers(body: dict[str, JsonValue], context: ClassifierContext) -> dict[str, Answer]:
    raw = RECORD.validate_python(body.get('answers'))
    answers: dict[str, Answer] = {}
    for name,question in context.questions.items():
        entry = RECORD.validate_python(raw.get(name))
        if isinstance(question,BoolQuestion):
            if entry.get('type') != 'noul':
                raise BackendError('classifier_answer_type')
            answer: Answer = BoolAnswer.model_validate({'probability':entry.get('noul')})
        else:
            answer = ANSWER.validate_python(entry)
            if answer.type != question.type:
                raise BackendError('classifier_answer_type')
        answers[name] = answer
    return answers


async def classify(accounts: AccountStore, provider: str, model_id: str, context: ClassifierContext,
                   timeout_ms: int = 30000) -> ClassifierResult:
    result = ClassifierResult(provider=provider,model=model_id)
    try:
        model = INDEX.get((provider,model_id))
        if model is None:
            raise BackendError('classifier_model_missing')
        payload,headers = wire_request(model,context)
        transport = accounts.read().transports.get(provider)
        credential = await accounts.resolve(provider,proxy=transport.proxy if transport else '')
        if credential is None:
            raise BackendError('provider_not_configured')
        key = credential.key if isinstance(credential,ApiKeyCredential) else credential.access
        headers = {'User-Agent':'pi',**model.headers,**headers,**(transport.headers if transport else {}),
            'Authorization':'Bearer '+key.get_secret_value()}
        async with httpx.AsyncClient(proxy=transport.proxy if transport and transport.proxy else None,
                                     trust_env=False,timeout=timeout_ms / 1000) as client:
            async with client.stream('POST',model.base_url.rstrip('/')+'/systemone',json=payload,headers=headers) as response:
                if response.is_error:
                    raise BackendError('classifier_http_'+str(response.status_code))
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > 2 * 1024 * 1024:
                        raise BackendError('classifier_response_limit')
        body = RECORD.validate_json(content)
        result.usage = RECORD.validate_python(body.get('usage',{}))
        result.answers = parse_answers(body,context)
    except asyncio.CancelledError:
        raise
    except (BackendError,httpx.HTTPError,ValueError) as error:
        result.stop_reason = 'error'
        result.error = error.code if isinstance(error,BackendError) else 'classifier_response_invalid' if isinstance(error,ValueError) else 'classifier_transport'
    return result
