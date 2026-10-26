"""Private session workflows operations; the caller owns the transaction."""
from __future__ import annotations

import sqlite3
from typing import Literal

from amazme_backend.contracts.models import Message
from amazme_backend.contracts.sessions import (
    Decision,
    Receipt,
    Submit,
    WorkflowChild,
    WorkflowView,
)
from amazme_backend.sessions.persistence.records import (
    Changes,
    append_message,
    load_request,
    load_run,
    pending_request_ids,
    save_request,
    workflow_for_parent,
)
from amazme_backend.sessions.persistence.requests import (
    create_request,
    decide_request,
    settle_request,
)
from amazme_backend.sessions.persistence.state import SessionContext
from amazme_backend.sessions.policy.limits import (
    PENDING_LIMIT,
    TERMINAL,
)
from amazme_backend.sessions.types import (
    Action,
    Continue,
    Park,
)
from amazme_backend.shared.errors import BackendError


def finish_workflow_parent(db: sqlite3.Connection, c: Changes, request_id: str) -> None:
    view = workflow_for_parent(db, request_id)
    if view is None or view.stage not in {"passed", "exhausted", "cancelled"}:
        return
    parent = load_request(db, view.parent_id)
    if parent.decision or parent.status in TERMINAL:
        return
    if any(load_request(db, child.request_id).status not in TERMINAL for child in view.children):
        return
    if view.stage == "passed":
        decision = Decision(status="succeeded", answer="workflow_passed")
    elif view.stage == "exhausted":
        decision = Decision(status="failed", error="workflow_exhausted")
    else:
        decision = Decision(status="cancelled")
    decide_request(db, c, parent, decision)
    settle_request(db, c, parent)


def park_or_settle_workflow(db: sqlite3.Connection, c: Changes, request: Receipt,
                             view: WorkflowView) -> Action:
    if view.stage in {"passed", "exhausted", "cancelled"} and all(
            load_request(db, child.request_id).status in TERMINAL for child in view.children):
        finish_workflow_parent(db, c, request.request_id)
        return Continue()
    return Park("children")


def add_workflow_child(state: SessionContext, db: sqlite3.Connection, c: Changes, view: WorkflowView, *,
                        role: Literal["check", "correction"], text: str, child_id: str) -> WorkflowView:
    if len(pending_request_ids(db)) + 1 > PENDING_LIMIT:
        raise BackendError("queue_full", status=429)
    create_request(state, db, c, Submit(request_id=child_id, text=text), parent_id=view.parent_id, depth=1,
                      inherited=load_run(db, view.parent_id).config)
    append_message(db, c, child_id, "input", Message(role="user", content=text))
    parent = load_request(db, view.parent_id)
    parent.children = [*parent.children, child_id]
    if parent.status not in TERMINAL and not parent.decision:
        parent.status = "waiting_children"
    save_request(db, c, parent)
    child = WorkflowChild(request_id=child_id, role=role, text=text, status="queued")
    return view.model_copy(update={"children": [*view.children, child]})
