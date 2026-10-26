"""System One bool/noul mapping, named assets and strict answer decoding."""
from pydantic import JsonValue, TypeAdapter

from amazme_backend.ai.classification.types import (
    Answer,
    BoolAnswer,
    BoolQuestion,
    BoxQuestion,
    ClassifierContext,
    ClassifierModel,
)
from amazme_backend.contracts.models import checked_images
from amazme_backend.shared.errors import BackendError

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
