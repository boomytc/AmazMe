"""Private session records operations; the caller owns the transaction."""
from __future__ import annotations

import json
import sqlite3

from pydantic import TypeAdapter

from amazme_backend.contracts.events import Event
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.ipc.worker import WorkerActivity
from amazme_backend.contracts.mcp import McpOffer
from amazme_backend.contracts.models import ImagePart, Message, checked_images
from amazme_backend.contracts.sessions import (
    Approval,
    Compaction,
    Preview,
    Receipt,
    TranscriptMessage,
    WorkerState,
    WorkflowView,
)
from amazme_backend.contracts.tools import ToolSearchOutput
from amazme_backend.contracts.web import WebCallView, WebPolicy
from amazme_backend.sessions.persistence import clock
from amazme_backend.sessions.persistence.state import SessionContext
from amazme_backend.sessions.policy.limits import (
    CONTEXT_BYTES,
    TERMINAL,
)
from amazme_backend.sessions.policy.projection import (
    compaction_basis,
    display_message,
)
from amazme_backend.sessions.types import (
    Run,
    Step,
)
from amazme_backend.shared.errors import BackendError


class Changes:
    def __init__(self, seq: int):
        self.seq = seq
        self.events: list[Event] = []
        self.hooks: list[tuple[str, str, str]] = []

    def emit(self, kind: str, request_id: str = "", text: str = "", *,
             receipt: Receipt | None = None, approval: Approval | None = None,
             preview: Preview | None = None, message: TranscriptMessage | None = None) -> None:
        self.events.append(Event.model_validate(dict(seq=str(self.seq), kind=kind, request_id=request_id, text=text,
                                                     receipt=receipt, approval=approval, preview=preview,
                                                     message=message)))

    def hit(self, point: str, request_id: str = "", call_id: str = "") -> None:
        self.hooks.append((point, request_id, call_id))


def context_requests(db: sqlite3.Connection, request_id: str) -> tuple[int, list[str]]:
    row = db.execute("SELECT payload FROM requests WHERE id=?", (request_id,)).fetchone()
    if row is None:
        raise BackendError("request_not_found", status=404)
    current = Receipt.model_validate_json(row[0])
    ancestors = [current.request_id]
    while current.parent_id:
        row = db.execute("SELECT payload FROM requests WHERE id=?", (current.parent_id,)).fetchone()
        if row is None:
            raise BackendError("storage_corrupt", status=503)
        current = Receipt.model_validate_json(row[0])
        ancestors.append(current.request_id)
    ordinal = db.execute("SELECT ordinal FROM requests WHERE id=?", (current.request_id,)).fetchone()[0]
    return int(ordinal), ancestors


def loaded_mcp_keys(db: sqlite3.Connection, request_id: str) -> list[str]:
    ordinal, ancestors = context_requests(db, request_id)
    seed = db.execute("SELECT value FROM metadata WHERE key='loaded_mcp_tools'").fetchone()
    loaded = set(TypeAdapter(list[str]).validate_json(seed[0]) if seed else [])
    placeholders = ",".join("?" for _ in ancestors)
    rows = db.execute("SELECT s.payload FROM steps s JOIN requests r ON r.id=s.request_id WHERE "
                      f"((r.kind='root' AND r.ordinal<=?) OR r.id IN ({placeholders})) "
                      "AND json_extract(s.payload,'$.call.name')='tool_search' "
                      "AND json_extract(s.payload,'$.phase') IN ('result','applied') ORDER BY r.ordinal,s.ordinal",
                      (ordinal, *ancestors))
    for row in rows:
        step = Step.model_validate_json(row[0])
        result = ToolSearchOutput.model_validate_json(step.result)
        offers = TypeAdapter(list[McpOffer]).validate_json(step.search_catalog or "[]")
        loaded.update(offer.activation_key() for offer in offers if offer.alias in result.details.loaded)
    return sorted(loaded)


def codemode_state_at(db: sqlite3.Connection, request_id: str) -> str:
    ordinal, ancestors = context_requests(db, request_id)
    seed = db.execute("SELECT value FROM metadata WHERE key='codemode_state'").fetchone()
    state = str(seed[0]) if seed else "{}"
    placeholders = ",".join("?" for _ in ancestors)
    for row in db.execute("SELECT s.payload FROM steps s JOIN requests r ON r.id=s.request_id WHERE "
                          f"((r.kind='root' AND r.ordinal<=?) OR r.id IN ({placeholders})) "
                          "AND coalesce(json_extract(s.payload,'$.code_state'),'')!='' ORDER BY r.ordinal,s.ordinal", (ordinal, *ancestors)):
        state = Step.model_validate_json(row[0]).code_state
    return state


def metadata_value(db: sqlite3.Connection, key: str) -> str:
    return str(db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()[0])


def set_metadata_value(db: sqlite3.Connection, key: str, value: str) -> None:
    db.execute("UPDATE metadata SET value=? WHERE key=?", (value, key))


def check_fence(state: SessionContext, db: sqlite3.Connection, fence: HostFence) -> None:
    if fence.build_id != state.build:
        raise BackendError("build_mismatch")
    if fence.host_epoch != int(metadata_value(db, "host_epoch")):
        raise BackendError("stale_host_epoch")


def load_request(db: sqlite3.Connection, request_id: str) -> Receipt:
    row = db.execute("SELECT payload FROM requests WHERE id=?", (request_id,)).fetchone()
    if row is None:
        raise BackendError("request_not_found", status=404)
    return Receipt.model_validate_json(row[0])


def list_requests(db: sqlite3.Connection) -> list[Receipt]:
    return [Receipt.model_validate_json(r[0]) for r in db.execute("SELECT payload FROM requests ORDER BY ordinal")]


def save_request(db: sqlite3.Connection, c: Changes, receipt: Receipt, kind: str = "status") -> None:
    receipt.revision = str(c.seq)
    db.execute("UPDATE requests SET payload=? WHERE id=?", (receipt.model_dump_json(), receipt.request_id))
    c.emit(kind, receipt.request_id,
           receipt.status, receipt=receipt.model_copy(deep=True))


def load_run(db: sqlite3.Connection, request_id: str) -> Run:
    return Run.model_validate_json(db.execute("SELECT payload FROM runs WHERE request_id=?", (request_id,)).fetchone()[0])


def save_run(db: sqlite3.Connection, run: Run) -> None:
    db.execute("INSERT INTO runs VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET payload=excluded.payload",
               (run.request_id, run.model_dump_json()))


def save_step(db: sqlite3.Connection, step: Step) -> None:
    db.execute("INSERT INTO steps VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
               (step.step_id, step.request_id, step.ordinal, step.model_dump_json()))


def list_steps(db: sqlite3.Connection, request_id: str) -> list[Step]:
    return [Step.model_validate_json(r[0]) for r in db.execute(
        "SELECT payload FROM steps WHERE request_id=? ORDER BY ordinal", (request_id,))]


def load_step(db: sqlite3.Connection, step_id: str) -> Step:
    row = db.execute("SELECT payload FROM steps WHERE id=?", (step_id,)).fetchone()
    if row is None:
        raise BackendError("checkpoint_not_found")
    return Step.model_validate_json(row[0])


def load_messages(db: sqlite3.Connection, request_id: str) -> list[Message]:
    return [Message.model_validate_json(r[0]) for r in db.execute(
        "SELECT payload FROM messages WHERE request_id=? ORDER BY ordinal", (request_id,))]


def message_text_bytes(payload: str) -> int:
    message = Message.model_validate_json(payload)
    return len(message.model_copy(update={"images": []}).model_dump_json().encode())


def append_message(db: sqlite3.Connection, c: Changes, request_id: str, key: str, message: Message) -> None:
    size = 0
    for row in db.execute("SELECT payload FROM messages WHERE request_id=?", (request_id,)):
        size += message_text_bytes(str(row[0]))
    payload = message.model_dump_json()
    if size + message_text_bytes(payload) > CONTEXT_BYTES:
        raise BackendError("context_limit")
    ordinal = db.execute("SELECT coalesce(max(ordinal),0)+1 FROM messages WHERE request_id=?", (request_id,)).fetchone()[0]
    changed = db.execute("INSERT OR IGNORE INTO messages VALUES(?,?,?,?)",
                         (request_id, ordinal, key, payload)).rowcount
    if changed:
        c.emit("message", request_id, message=display_message(key, ordinal, message))


def save_prompt_images(db: sqlite3.Connection, request_id: str, images: list[ImagePart]) -> None:
    checked_images(images)
    if not images:
        return
    db.execute("INSERT INTO prompt_images(request_id,payload) VALUES(?,?)",
               (request_id, json.dumps([image.model_dump() for image in images], separators=(",", ":"))))


def load_prompt_images(db: sqlite3.Connection, request_id: str) -> list[ImagePart]:
    row = db.execute("SELECT payload FROM prompt_images WHERE request_id=?", (request_id,)).fetchone()
    if row is None:
        return []
    return [ImagePart.model_validate(item) for item in json.loads(str(row[0]))]


def load_step_images(db: sqlite3.Connection, step_id: str) -> list[ImagePart]:
    try:
        row = db.execute("SELECT payload FROM step_images WHERE step_id=?", (step_id,)).fetchone()
    except sqlite3.OperationalError:
        return []
    return [ImagePart.model_validate(item) for item in json.loads(str(row[0]))] if row else []


def load_workflow(db: sqlite3.Connection, workflow_id: str) -> tuple[str, WorkflowView]:
    row = db.execute("SELECT digest,payload FROM workflows WHERE id=?", (workflow_id,)).fetchone()
    if row is None:
        raise BackendError("workflow_not_found", status=404)
    return str(row[0]), WorkflowView.model_validate_json(row[1])


def refresh_workflow(db: sqlite3.Connection, view: WorkflowView) -> WorkflowView:
    children = [child.model_copy(update={"status": load_request(db, child.request_id).status})
                for child in view.children]
    parent = load_request(db, view.parent_id)
    return view.model_copy(update={"children": children, "parent_status": parent.status})


def save_workflow(db: sqlite3.Connection, view: WorkflowView) -> None:
    db.execute("UPDATE workflows SET payload=? WHERE id=?", (view.model_dump_json(), view.workflow_id))


def workflow_for_parent(db: sqlite3.Connection, request_id: str) -> WorkflowView | None:
    row = db.execute("SELECT payload FROM workflows WHERE parent_id=?", (request_id,)).fetchone()
    if row is None:
        return None
    return WorkflowView.model_validate_json(row[0])


def mark_workflow_cancelled(db: sqlite3.Connection, request_id: str) -> None:
    view = workflow_for_parent(db, request_id)
    if view is None or view.stage == "cancelled":
        return
    save_workflow(db, view.model_copy(update={"stage": "cancelled"}))


def load_web_policy(db: sqlite3.Connection) -> WebPolicy:
    row = db.execute("SELECT payload FROM web_policies WHERE id='policy'").fetchone()
    if row is None:
        return WebPolicy()
    return WebPolicy.model_validate_json(row[0])


def load_web_call(db: sqlite3.Connection, call_id: str) -> WebCallView:
    row = db.execute("SELECT payload FROM web_calls WHERE id=?", (call_id,)).fetchone()
    if row is None:
        raise BackendError("web_call_not_found", status=404)
    return WebCallView.model_validate_json(row[0])


def expire_approvals(db: sqlite3.Connection, c: Changes, request_id: str) -> None:
    for row in db.execute("SELECT payload FROM approvals WHERE request_id=?", (request_id,)).fetchall():
        approval = Approval.model_validate_json(row[0])
        if approval.state in {"pending", "approved"}:
            approval.state = "expired"
            db.execute("UPDATE approvals SET payload=? WHERE id=?", (approval.model_dump_json(), approval.approval_id))
            c.emit("approval", request_id, "expired", approval=approval)


def load_message_payloads(db: sqlite3.Connection, request_id: str) -> list[str]:
    return [str(row[0]) for row in db.execute(
        "SELECT payload FROM messages WHERE request_id=? ORDER BY ordinal", (request_id,))]


def match_compaction(db: sqlite3.Connection, payloads: list[str]) -> Compaction | None:
    best: Compaction | None = None
    for row in db.execute("SELECT payload FROM compactions ORDER BY rowid"):
        record = Compaction.model_validate_json(row[0])
        if record.message_count > len(payloads):
            continue
        if compaction_basis(payloads[:record.message_count]) != record.basis:
            continue
        if best is None or record.message_count >= best.message_count:
            best = record
    return best


def load_active_summary(db: sqlite3.Connection) -> str:
    previous = db.execute(
        "SELECT id FROM requests WHERE kind='root' AND status='succeeded' ORDER BY ordinal DESC LIMIT 1").fetchone()
    if previous is None:
        return ""
    matched = match_compaction(db, load_message_payloads(db, str(previous[0])))
    return matched.summary if matched else ""


def compaction_source(db: sqlite3.Connection, through_request_id: str) -> tuple[list[str], str]:
    row = db.execute("SELECT payload FROM requests WHERE id=?", (through_request_id,)).fetchone()
    if row is None:
        raise BackendError("compaction_unsettled")
    receipt = Receipt.model_validate_json(row[0])
    payloads = load_message_payloads(db, through_request_id)
    if receipt.kind != "root" or receipt.status != "succeeded" or receipt.decision is None or not payloads:
        raise BackendError("compaction_unsettled")
    return payloads, compaction_basis(payloads)


def session_activity(db: sqlite3.Connection) -> WorkerActivity:
    terminal = ",".join("?" for _ in TERMINAL)
    requests = [Receipt.model_validate_json(r[0]) for r in db.execute(
        f"SELECT payload FROM requests WHERE status NOT IN ({terminal})", tuple(TERMINAL))]
    resolutions = db.execute("SELECT count(*) FROM resolutions WHERE result=''").fetchone()[0]
    due = min((r.not_before_ms for r in requests if r.not_before_ms > clock.now_ms()), default=0)
    state: WorkerState = "blocked" if metadata_value(db, "blocked") else (
        "stopping" if metadata_value(db, "stopping") else "frozen" if metadata_value(db, "freeze_id") else "ready")
    runnable = state == "ready" and (resolutions > 0 or any(
        r.kind != "steer" and r.status not in {"waiting_approval", "waiting_children"} and r.not_before_ms <= clock.now_ms()
        for r in requests))
    return WorkerActivity(pending=len(pending_request_ids(db)),
                          runnable=runnable, next_wake_ms=due, state=state)


def load_transcript(db: sqlite3.Connection) -> list[tuple[str, str, str]]:
    rows = db.execute(
        "SELECT m.request_id, m.payload FROM messages m JOIN requests r ON r.id=m.request_id "
        "ORDER BY r.ordinal, m.ordinal").fetchall()
    result: list[tuple[str, str, str]] = []
    for request_id, payload in rows:
        message = Message.model_validate_json(payload)
        result.append((str(request_id), message.role, message.content))
    return result


def pending_request_ids(db: sqlite3.Connection) -> set[str]:
    terminal = ",".join("?" for _ in TERMINAL)
    requests = {str(r[0]) for r in db.execute(
        f"SELECT id FROM requests WHERE status NOT IN ({terminal})", tuple(TERMINAL))}
    requests.update(str(r[0]) for r in db.execute(
        "SELECT json_extract(payload,'$.request_id') FROM effects "
        "WHERE NOT json_extract(payload,'$.reconciled') OR NOT json_extract(payload,'$.resource_clean')"))
    requests.update(str(r[0]) for r in db.execute("SELECT request_id FROM resolutions WHERE result=''"))
    return requests
