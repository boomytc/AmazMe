"""Human answers settle the existing tool step in the same session transaction."""
from __future__ import annotations

import sqlite3

from amazme_backend.contracts.execution import ToolResult
from amazme_backend.contracts.questions import AskUser, QuestionAnswer, QuestionResult, QuestionView
from amazme_backend.contracts.sessions import Receipt
from amazme_backend.sessions.persistence.records import (
    Changes,
    load_request,
    load_step,
    metadata_value,
    save_request,
    save_step,
)
from amazme_backend.sessions.policy.projection import digest, event_step_text
from amazme_backend.sessions.types import Step
from amazme_backend.shared.errors import BackendError


def question_view(request: Receipt, step: Step) -> QuestionView:
    assert step.call is not None and step.call.name == "ask_user_question"
    questions = AskUser.model_validate_json(step.call.arguments)
    return QuestionView(**questions.model_dump(), question_id=step.step_id, request_id=request.request_id,
        proposal_digest=digest(step.step_id + str(step.generation) + step.call.model_dump_json()),
        generation=step.generation)


def pending_questions(db: sqlite3.Connection) -> list[QuestionView]:
    rows = db.execute("SELECT s.payload,r.payload FROM steps s JOIN requests r ON r.id=s.request_id "
        "WHERE r.status='waiting_input' AND json_extract(s.payload,'$.phase')='question' "
        "AND json_extract(s.payload,'$.call.name')='ask_user_question' ORDER BY r.ordinal,s.ordinal")
    return [question_view(Receipt.model_validate_json(row[1]), Step.model_validate_json(row[0])) for row in rows]


def answer_question(db: sqlite3.Connection, c: Changes, value: QuestionAnswer) -> Receipt:
    identity = "question:" + value.decision_id
    key = digest(value.model_dump_json())
    old = db.execute("SELECT digest,request_id FROM decisions WHERE id=?", (identity,)).fetchone()
    if old:
        if old[0] != key:
            raise BackendError("question_answer_conflict")
        return load_request(db, old[1])
    if metadata_value(db, "freeze_id") or metadata_value(db, "stopping"):
        raise BackendError("worker_frozen")
    if metadata_value(db, "blocked"):
        raise BackendError("worker_blocked", status=503)
    try:
        step = load_step(db, value.question_id)
    except BackendError as error:
        raise BackendError("question_not_found", status=404) from error
    request = load_request(db, step.request_id)
    if (step.call is None or step.call.name != "ask_user_question" or step.phase != "question"
        or request.request_id != value.request_id or request.status != "waiting_input"
        or request.cancel_requested or request.decision):
        raise BackendError("stale_question")
    view = question_view(request, step)
    if value.proposal_digest != view.proposal_digest or value.generation != view.generation:
        raise BackendError("stale_question")
    if value.kind == "answered":
        answers = {answer.id: answer for answer in value.answers}
        if len(answers) != len(value.answers) or answers.keys() != {question.id for question in view.questions}:
            raise BackendError("question_answer_invalid")
        for question in view.questions:
            answer = answers[question.id]
            if (len(set(answer.selected)) != len(answer.selected)
                or any(label not in {option.label for option in question.options} for label in answer.selected)
                or not question.multi_select and len(answer.selected) > 1
                or not answer.selected and not answer.custom.strip()):
                raise BackendError("question_answer_invalid")
    output = QuestionResult(kind=value.kind, answers=value.answers,
        guidance="The user skipped this question. Treat it as answered; do not ask it again. Continue with a stated assumption when possible, or explain the missing requirement." if value.kind == "skipped" else "")
    step.result = ToolResult(call_id=step.step_id, exit_code=0, stdout=output.model_dump_json(), stderr="").model_dump_json()
    step.phase = "result"
    request.status = "running"
    save_step(db, step)
    save_request(db, c, request)
    db.execute("INSERT INTO decisions VALUES(?,?,?)", (identity, key, request.request_id))
    c.emit("question", request.request_id, value.kind, question=view.model_copy(update={"state": value.kind}))
    c.emit("tool", request.request_id, event_step_text(step))
    return request
