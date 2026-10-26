"""Complete session operations and the closed IPC dispatcher."""
from __future__ import annotations

import json
import secrets
import sqlite3
from collections.abc import AsyncGenerator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Protocol

from pydantic import BaseModel, JsonValue, TypeAdapter

from amazme_backend.ai.pricing import token_cost_micro
from amazme_backend.contracts.computer import ComputerActionView, ComputerCaptureView, ComputerPolicy
from amazme_backend.contracts.events import CommitBatch, Event, HistoryPage, Replay, Snapshot
from amazme_backend.contracts.execution import Cleanup, EffectHold, EffectResolution
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.ipc.host import ComputerToolRequest
from amazme_backend.contracts.ipc.worker import (
    BeginCompactionBody,
    BeginComputerBody,
    BeginComputerResult,
    BeginWebBody,
    BeginWebResult,
    CancelBody,
    ChildBody,
    CodeChild,
    CompactBody,
    CompactionClaim,
    EpochValue,
    ExitBody,
    FindActionBody,
    FlagValue,
    FoundAction,
    IdBody,
    MessageList,
    OpenWorkflowBody,
    PrepareBranchBody,
    RuntimeValue,
    SessionOpName,
    SettleComputerBody,
    SettleWebBody,
    SnapshotBody,
    StoppingBody,
    TextValue,
    TranscriptBody,
    VerdictBody,
    WorkerActivity,
)
from amazme_backend.contracts.models import CatalogModel, ImagePart, Message, checked_images
from amazme_backend.contracts.plugins import PluginOffer
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.resources import ResourceOptions
from amazme_backend.contracts.sessions import (
    Approval,
    ApprovalDecision,
    Compaction,
    Decision,
    Preview,
    Receipt,
    SearchHit,
    SessionDiagnostic,
    Submit,
    UsageReport,
    WorkerState,
    WorkflowChild,
    WorkflowView,
)
from amazme_backend.contracts.web import WebCallView, WebPolicy
from amazme_backend.diagnostics.faults import Faults
from amazme_backend.sessions.maintenance import read_settled_root
from amazme_backend.sessions.persistence import clock, schema
from amazme_backend.sessions.persistence.driver import advance_request, apply_observation
from amazme_backend.sessions.persistence.records import (
    Changes,
    append_message,
    check_fence,
    compaction_source,
    expire_approvals,
    list_requests,
    list_steps,
    load_active_summary,
    load_computer_policy,
    load_computer_runtime,
    load_message_payloads,
    load_messages,
    load_prompt_images,
    load_request,
    load_run,
    load_step,
    load_transcript,
    load_web_call,
    load_web_policy,
    load_workflow,
    loaded_mcp_keys,
    metadata_value,
    pending_request_ids,
    refresh_workflow,
    save_prompt_images,
    save_request,
    save_run,
    save_step,
    save_workflow,
    session_activity,
    set_metadata_value,
)
from amazme_backend.sessions.persistence.requests import (
    approval_binding,
    cancel_request_tree,
    create_request,
    decide_request,
    join_children,
    settle_request,
)
from amazme_backend.sessions.persistence.state import ResourceExpander, SecretSource, SessionContext
from amazme_backend.sessions.persistence.workflows import (
    add_workflow_child,
    finish_workflow_parent,
)
from amazme_backend.sessions.policy.limits import (
    PENDING_LIMIT,
    SNAPSHOT_CHILD_BYTES,
    SNAPSHOT_MAX_BYTES,
    SNAPSHOT_VIEW_BYTES,
    TERMINAL,
)
from amazme_backend.sessions.policy.projection import (
    compaction_basis,
    correction_text,
    digest,
    display_message,
    event_step_text,
    public_error_code,
    search_text,
    verdict_body,
    workflow_body,
)
from amazme_backend.sessions.store import SessionTransactions
from amazme_backend.sessions.types import (
    Action,
    CloseEpoch,
    Completion,
    Continue,
    Observation,
    Park,
    ReconcileEffect,
    Run,
    Step,
)
from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model


class SessionStore:
    """Complete session operations; one private writer commits their durable intents and events."""

    def __init__(self, path: Path, session_id: str, *, build: str = 'test-build',
                 config: ProviderConfig | None = None, approval_policy: str = 'mutations',
                 faults: Faults | None = None, require_existing: bool = False, read_only: bool = False,
                 instance: str = '', model_catalog: Mapping[tuple[str, str], CatalogModel] | None = None,
                 expand_resources: ResourceExpander | None = None, secret_source: SecretSource | None = None):
        if expand_resources is not None and secret_source is None:
            raise ValueError('Resource expansion requires a fresh secret source')
        self._state = SessionContext(session_id, build, config or ProviderConfig(provider='faux'),
            approval_policy, faults, instance or secrets.token_hex(16),
            {} if model_catalog is None else model_catalog, expand_resources,
            (lambda: ()) if secret_source is None else secret_source)
        self._store = SessionTransactions(path, self._state, require_existing=require_existing, read_only=read_only)

    @property
    def config(self) -> ProviderConfig:
        return self._state.config

    @config.setter
    def config(self, value: ProviderConfig) -> None:
        self._state.config = value

    @property
    def session_id(self) -> str:
        return self._state.session_id

    @property
    def read_only(self) -> bool:
        return self._store.database.read_only

    async def initialize(self) -> None:
        if self.read_only:
            await self._store.database.call(lambda _db: None)
            return
        await self._store.database.call(schema.initialize)

    async def close(self) -> None:
        await self._store.database.close()

    async def fence(self, value: HostFence) -> int:
        def operation(db: sqlite3.Connection, c: Changes) -> int:
            if value.build_id != self._state.build:
                raise BackendError("build_mismatch")
            previous = int(metadata_value(db, "host_epoch"))
            if value.host_epoch < previous:
                raise BackendError("stale_host_epoch")
            if value.host_epoch != previous:
                set_metadata_value(db, "host_epoch", str(value.host_epoch))
                c.emit("status", text="host_fence:" + str(value.host_epoch))
            return value.host_epoch
        return await self._store.transact(operation)

    async def host_epoch(self) -> int:
        return await self._store.database.call(lambda db: int(metadata_value(db, "host_epoch")))

    async def accept(self, value: Submit, fence: HostFence, *, accepted_config: ProviderConfig | None = None) -> Receipt:
        def operation(db: sqlite3.Connection, c: Changes) -> Receipt:
            check_fence(self._state, db, fence)
            row = db.execute("SELECT digest,payload FROM requests WHERE id=?", (value.request_id,)).fetchone()
            if row:
                if row[0] != digest(value.model_dump_json()):
                    raise BackendError("request_conflict")
                return Receipt.model_validate_json(row[1])
            if metadata_value(db, "freeze_id") or metadata_value(db, "stopping"):
                raise BackendError("worker_frozen")
            if metadata_value(db, "blocked"):
                raise BackendError("worker_blocked", status=503)
            pending = pending_request_ids(db)
            tombstone = db.execute("SELECT payload FROM cancellations WHERE id=?", (value.request_id,)).fetchone()
            if len(pending) >= PENDING_LIMIT and not tombstone:
                raise BackendError("queue_full", status=429)
            if value.mode == "reject_busy" and pending and not tombstone:
                raise BackendError("session_busy")
            if value.mode == "steer" and not tombstone:
                if value.approval_policy is not None:
                    raise BackendError("run_options_immutable")
                if value.tool_call is not None or value.system_prompt is not None or value.append_system_prompt or value.allowed_tools is not None or value.excluded_tools or value.resource_options != ResourceOptions() or value.thinking is not None or value.model_selection is not None:
                    raise BackendError("run_options_immutable")
                if value.not_before_ms:
                    raise BackendError("scheduled_steer_unsupported")
                if load_run(db, value.target_run_id).direct_call is not None:
                    raise BackendError("direct_tool_steer_unsupported")
                target = load_request(db, value.target_run_id)
                if target.status in TERMINAL or target.decision or target.kind == "steer":
                    raise BackendError("steer_target_settled")
                run = load_run(db, target.request_id)
                run.started_at_ms = clock.now_ms()
                if value.time_zone:
                    run.config.time_zone = value.time_zone
                save_run(db, run)
                receipt = Receipt(request_id=value.request_id, run_id=target.run_id, parent_id=target.request_id,
                                  kind="steer", text=value.text, status="queued", accepted_revision=str(c.seq),
                                  revision=str(c.seq), image_count=len(value.images))
                db.execute("INSERT INTO requests(id,digest,payload) VALUES(?,?,?)",
                           (value.request_id, digest(value.model_dump_json()), receipt.model_dump_json()))
                save_prompt_images(db, value.request_id, value.images)
                expire_approvals(db, c, target.request_id)
                c.emit("accepted", receipt.request_id, receipt.text, receipt=receipt.model_copy(deep=True))
                c.hit("accepted", receipt.request_id)
                return receipt
            receipt = create_request(self._state, db, c, value, accepted_config=accepted_config)
            if tombstone:
                receipt.cancel_requested = True
                decide_request(db, c, receipt, Decision(status="cancelled", error="cancelled_before_acceptance"))
                settle_request(db, c, receipt)
            return receipt
        return await self._store.transact(operation)

    async def get(self, request_id: str) -> Receipt:
        def operation(db: sqlite3.Connection) -> Receipt:
            row = db.execute("SELECT payload FROM requests WHERE id=?", (request_id,)).fetchone()
            if row:
                return Receipt.model_validate_json(row[0])
            row = db.execute("SELECT payload FROM cancellations WHERE id=?", (request_id,)).fetchone()
            if row:
                return Receipt.model_validate_json(row[0])
            raise BackendError("request_not_found", status=404)
        return await self._store.database.call(operation)

    async def request_cleanup_complete(self, request_id: str) -> bool:
        """Read the original subtree's process and effect facts without starting a worker."""
        def operation(db: sqlite3.Connection) -> bool:
            ids = {str(row[0]) for row in db.execute(
                "WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT r.id FROM requests r JOIN tree t "
                "ON json_extract(r.payload,'$.parent_id')=t.id) SELECT id FROM tree", (request_id,))}
            if ids & pending_request_ids(db):
                return False
            slots = ",".join("?" for _ in ids)
            for row in db.execute(f"SELECT payload FROM runs WHERE request_id IN ({slots})", tuple(ids)):
                run = Run.model_validate_json(row[0])
                if run.lease is not None or run.opening or run.cleanup_required:
                    return False
            return True
        return await self._store.database.call(operation)

    async def open_workflow(self, workflow_id: str, check: str, correction_limit: int, *,
                            accepted_config: ProviderConfig | None = None) -> WorkflowView:
        text = check.strip()
        if not text:
            raise BackendError("workflow_check_empty")
        if correction_limit < 0 or correction_limit > 8:
            raise BackendError("workflow_limit")

        def operation(db: sqlite3.Connection, c: Changes) -> WorkflowView:
            key = digest(workflow_body(text, correction_limit))
            row = db.execute("SELECT digest,payload FROM workflows WHERE id=?", (workflow_id,)).fetchone()
            if row:
                if str(row[0]) != key:
                    raise BackendError("workflow_conflict")
                return refresh_workflow(db, WorkflowView.model_validate_json(row[1]))
            if metadata_value(db, "freeze_id") or metadata_value(db, "stopping"):
                raise BackendError("worker_frozen")
            if metadata_value(db, "blocked"):
                raise BackendError("worker_blocked", status=503)
            if len(pending_request_ids(db)) + 2 > PENDING_LIMIT:
                raise BackendError("queue_full", status=429)
            parent_id = digest(f"{self._state.session_id}:{workflow_id}:parent")
            child_id = digest(f"{self._state.session_id}:{workflow_id}:check")
            parent = create_request(self._state, db, c, Submit(request_id=parent_id, text=f"工作流 {workflow_id}"),
                                       accepted_config=accepted_config)
            create_request(self._state, db, c, Submit(request_id=child_id, text=text), parent_id=parent_id, depth=1,
                              inherited=load_run(db, parent_id).config)
            append_message(db, c, child_id, "input", Message(role="user", content=text))
            parent.children = [child_id]
            parent.status = "waiting_children"
            save_request(db, c, parent)
            view = WorkflowView(
                workflow_id=workflow_id, session_id=self._state.session_id, stage="check",
                correction_limit=correction_limit, attempts=0, parent_id=parent_id,
                parent_status="waiting_children", check=text,
                children=[WorkflowChild(request_id=child_id, role="check", text=text, status="queued")])
            db.execute("INSERT INTO workflows(id,digest,parent_id,payload) VALUES(?,?,?,?)",
                       (workflow_id, key, parent_id, view.model_dump_json()))
            return view
        return await self._store.transact(operation)

    async def workflow(self, workflow_id: str) -> WorkflowView:
        def operation(db: sqlite3.Connection) -> WorkflowView:
            return refresh_workflow(db, load_workflow(db, workflow_id)[1])
        return await self._store.database.call(operation)

    async def workflow_check_text(self, request_id: str) -> str:
        """The stored check when this request is that child. Empty when it is ordinary user text."""
        def operation(db: sqlite3.Connection) -> str:
            try:
                rows = db.execute("SELECT payload FROM workflows").fetchall()
            except sqlite3.OperationalError:
                return ""
            for row in rows:
                view = WorkflowView.model_validate_json(row[0])
                if any(child.request_id == request_id and child.role == "check" for child in view.children):
                    return view.check
            return ""
        return await self._store.database.call(operation)

    async def resume_workflow(self, workflow_id: str) -> WorkflowView:
        def operation(db: sqlite3.Connection, _c: Changes) -> WorkflowView:
            return refresh_workflow(db, load_workflow(db, workflow_id)[1])
        return await self._store.transact(operation)

    async def record_verdict(self, workflow_id: str, verdict_id: str, passed: bool, *,
                             allow_new_child: bool = True) -> WorkflowView:
        def operation(db: sqlite3.Connection, c: Changes) -> WorkflowView:
            view = load_workflow(db, workflow_id)[1]
            key = digest(verdict_body(verdict_id, passed))
            existing = db.execute(
                "SELECT digest FROM workflow_verdicts WHERE workflow_id=? AND verdict_id=?",
                (workflow_id, verdict_id)).fetchone()
            if existing:
                if str(existing[0]) != key:
                    raise BackendError("verdict_conflict")
                return refresh_workflow(db, view)
            if view.stage in {"passed", "exhausted", "cancelled"}:
                raise BackendError("workflow_settled")
            if not passed:
                corrections = [child for child in view.children if child.role == "correction"]
                if corrections and load_request(db, corrections[-1].request_id).status not in TERMINAL:
                    raise BackendError("workflow_busy")
                if view.attempts >= view.correction_limit:
                    view = view.model_copy(update={"stage": "exhausted"})
                else:
                    if not allow_new_child:
                        raise BackendError("workspace_not_found", status=404)
                    attempt = view.attempts + 1
                    prompt = correction_text(attempt)
                    child_id = digest(f"{self._state.session_id}:{workflow_id}:correction:{attempt}")
                    view = add_workflow_child(self._state,
                        db, c, view, role="correction", text=prompt, child_id=child_id)
                    view = view.model_copy(update={"stage": "correction", "attempts": attempt})
            else:
                view = view.model_copy(update={"stage": "passed"})
            db.execute("INSERT INTO workflow_verdicts(workflow_id,verdict_id,digest,passed) VALUES(?,?,?,?)",
                       (workflow_id, verdict_id, key, int(passed)))
            save_workflow(db, view)
            finish_workflow_parent(db, c, view.parent_id)
            return refresh_workflow(db, view)
        return await self._store.transact(operation)

    async def cancel_workflow_child(self, workflow_id: str, request_id: str) -> WorkflowView:
        def operation(db: sqlite3.Connection, c: Changes) -> WorkflowView:
            view = load_workflow(db, workflow_id)[1]
            if not any(child.request_id == request_id for child in view.children):
                raise BackendError("workflow_child_mismatch")
            cancel_request_tree(db, c, request_id)
            return refresh_workflow(db, load_workflow(db, workflow_id)[1])
        return await self._store.transact(operation)

    async def web_policy(self) -> WebPolicy:
        return await self._store.database.call(load_web_policy)

    async def save_web_policy(self, value: WebPolicy) -> WebPolicy:
        def operation(db: sqlite3.Connection, _changes: Changes) -> WebPolicy:
            if metadata_value(db, "freeze_id") or metadata_value(db, "stopping"):
                raise BackendError("worker_frozen")
            payload = value.model_dump_json()
            db.execute(
                "INSERT INTO web_policies(id,digest,payload) VALUES('policy',?,?) "
                "ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,payload=excluded.payload",
                (digest(payload), payload))
            return value
        return await self._store.transact(operation)

    async def begin_web_call(self, call_id: str, kind: Literal["search", "fetch"], body: str) -> tuple[WebCallView, bool]:
        """Reserve one paid call. An existing row is returned and must not be sent again."""
        def operation(db: sqlite3.Connection, _changes: Changes) -> tuple[WebCallView, bool]:
            key = digest(body)
            row = db.execute("SELECT digest,payload FROM web_calls WHERE id=?", (call_id,)).fetchone()
            if row:
                if str(row[0]) != key:
                    raise BackendError("web_call_conflict")
                return WebCallView.model_validate_json(row[1]), False
            if metadata_value(db, "freeze_id") or metadata_value(db, "stopping"):
                raise BackendError("worker_frozen")
            view = WebCallView(call_id=call_id, session_id=self._state.session_id, kind=kind, phase="unknown")
            db.execute("INSERT INTO web_calls(id,digest,payload) VALUES(?,?,?)",
                       (call_id, key, view.model_dump_json()))
            return view, True
        return await self._store.transact(operation)

    async def settle_web_call(self, call_id: str, phase: Literal["unknown", "done", "failed"],
                              error: str, result: str) -> WebCallView:
        def operation(db: sqlite3.Connection, _changes: Changes) -> WebCallView:
            current = load_web_call(db, call_id)
            if current.phase != "unknown":
                return current
            current.phase = phase
            current.error = error
            current.result = result
            db.execute("UPDATE web_calls SET payload=? WHERE id=? AND json_extract(payload,'$.phase')='unknown'",
                       (current.model_dump_json(), call_id))
            return load_web_call(db, call_id)
        return await self._store.transact(operation)

    async def computer_policy(self) -> ComputerPolicy:
        return await self._store.database.call(load_computer_policy)

    async def save_computer_policy(self, value: ComputerPolicy) -> ComputerPolicy:
        def operation(db: sqlite3.Connection, _changes: Changes) -> ComputerPolicy:
            if metadata_value(db, "freeze_id") or metadata_value(db, "stopping"):
                raise BackendError("worker_frozen")
            db.execute(
                "INSERT INTO computer_policies(id,payload) VALUES('policy',?) "
                "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                (value.model_dump_json(),))
            return value
        return await self._store.transact(operation)

    async def computer_blocked(self) -> bool:
        blocked, _exit, _proof = await self._store.database.call(load_computer_runtime)
        return blocked

    async def computer_runtime(self) -> tuple[bool, int | None, str]:
        return await self._store.database.call(load_computer_runtime)

    async def note_computer_exit(self, exit_code: int | None) -> None:
        def operation(db: sqlite3.Connection, _changes: Changes) -> None:
            _blocked, previous, proof = load_computer_runtime(db)
            code = previous if exit_code is None else exit_code
            db.execute(
                "INSERT INTO computer_runtime(id,blocked,exit_code,proof) VALUES('current',1,?,?) "
                "ON CONFLICT(id) DO UPDATE SET blocked=1,exit_code=excluded.exit_code,proof=computer_runtime.proof",
                (code, proof))
        await self._store.transact(operation)

    async def finish_computer_cleanup(self, proof: str) -> str:
        def operation(db: sqlite3.Connection, _changes: Changes) -> str:
            blocked, exit_code, existing = load_computer_runtime(db)
            if not blocked:
                return existing
            if exit_code is None or not proof:
                raise BackendError("computer_exit_unproven")
            db.execute("UPDATE computer_runtime SET blocked=0,proof=? WHERE id='current'", (proof,))
            return proof
        return await self._store.transact(operation)

    async def save_computer_capture(self, value: ComputerCaptureView) -> ComputerCaptureView:
        def operation(db: sqlite3.Connection, _changes: Changes) -> ComputerCaptureView:
            db.execute("INSERT INTO computer_captures(id,observed_ms,payload) VALUES(?,?,?)",
                       (value.capture_id, value.observed_ms, value.model_dump_json()))
            return value
        return await self._store.transact(operation)

    async def latest_computer_capture(self) -> ComputerCaptureView | None:
        def operation(db: sqlite3.Connection) -> ComputerCaptureView | None:
            row = db.execute("SELECT payload FROM computer_captures ORDER BY ordinal DESC LIMIT 1").fetchone()
            if row is None:
                return None
            return ComputerCaptureView.model_validate_json(row[0])
        return await self._store.database.call(operation)

    async def find_computer_action(self, action_id: str, body: str) -> ComputerActionView | None:
        def operation(db: sqlite3.Connection) -> ComputerActionView | None:
            row = db.execute("SELECT digest,payload FROM computer_actions WHERE id=?", (action_id,)).fetchone()
            if row is None:
                return None
            if str(row[0]) != digest(body):
                raise BackendError("computer_action_conflict")
            return ComputerActionView.model_validate_json(row[1])
        return await self._store.database.call(operation)

    async def begin_computer_action(self, action_id: str, body: str) -> tuple[ComputerActionView, bool]:
        def operation(db: sqlite3.Connection, _changes: Changes) -> tuple[ComputerActionView, bool]:
            blocked, _exit, _proof = load_computer_runtime(db)
            key = digest(body)
            row = db.execute("SELECT digest,payload FROM computer_actions WHERE id=?", (action_id,)).fetchone()
            if row:
                if str(row[0]) != key:
                    raise BackendError("computer_action_conflict")
                return ComputerActionView.model_validate_json(row[1]), False
            if blocked:
                raise BackendError("computer_blocked")
            view = ComputerActionView(action_id=action_id, session_id=self._state.session_id, phase="unknown")
            db.execute("INSERT INTO computer_actions(id,digest,payload) VALUES(?,?,?)",
                       (action_id, key, view.model_dump_json()))
            return view, True
        return await self._store.transact(operation)

    async def settle_computer_action(self, action_id: str, phase: Literal["unknown", "done", "failed"],
                                     error: str, driver_x: int | None, driver_y: int | None,
                                     result: dict[str, JsonValue] | None = None, images: list[ImagePart] | None = None) -> ComputerActionView:
        def operation(db: sqlite3.Connection, _changes: Changes) -> ComputerActionView:
            row = db.execute("SELECT payload FROM computer_actions WHERE id=?", (action_id,)).fetchone()
            if row is None:
                raise BackendError("computer_action_missing", status=404)
            current = ComputerActionView.model_validate_json(row[0])
            if current.phase != "unknown":
                return current
            current.phase = phase
            current.error = error
            current.driver_x = driver_x
            current.driver_y = driver_y
            current.result = result or {}
            current.images = checked_images(images or [])
            db.execute(
                "UPDATE computer_actions SET payload=? WHERE id=? AND json_extract(payload,'$.phase')='unknown'",
                (current.model_dump_json(), action_id))
            return current
        return await self._store.transact(operation)

    async def cancel(self, request_id: str, fence: HostFence) -> Receipt:
        def operation(db: sqlite3.Connection, c: Changes) -> Receipt:
            check_fence(self._state, db, fence)
            if (not db.execute("SELECT 1 FROM requests WHERE id=?", (request_id,)).fetchone()
                    and not db.execute("SELECT 1 FROM cancellations WHERE id=?", (request_id,)).fetchone()):
                tombstone = Receipt(request_id=request_id, run_id=request_id, text="", status="cancelled",
                                    cancel_requested=True, decision=Decision(status="cancelled"),
                                    accepted_revision=str(c.seq), revision=str(c.seq))
                db.execute("INSERT INTO cancellations VALUES(?,?)", (request_id, tombstone.model_dump_json()))
                c.emit("status", request_id, "cancel_tombstone", receipt=tombstone)
            cancel_request_tree(db, c, request_id)
            finish_workflow_parent(db, c, request_id)
            row = db.execute("SELECT payload FROM requests WHERE id=?", (request_id,)).fetchone()
            return Receipt.model_validate_json(row[0] if row else db.execute(
                "SELECT payload FROM cancellations WHERE id=?", (request_id,)).fetchone()[0])
        return await self._store.transact(operation)

    async def approve(self, value: ApprovalDecision, fence: HostFence) -> Receipt:
        def operation(db: sqlite3.Connection, c: Changes) -> Receipt:
            check_fence(self._state, db, fence)
            old = db.execute("SELECT digest,request_id FROM decisions WHERE id=?", (value.decision_id,)).fetchone()
            key = digest(value.model_dump_json())
            if old:
                if old[0] != key:
                    raise BackendError("approval_decision_conflict")
                return load_request(db, old[1])
            if metadata_value(db, "freeze_id") or metadata_value(db, "stopping"):
                raise BackendError("worker_frozen")
            if metadata_value(db, "blocked"):
                raise BackendError("worker_blocked", status=503)
            row = db.execute("SELECT payload FROM approvals WHERE id=?", (value.approval_id,)).fetchone()
            if not row:
                raise BackendError("approval_not_found", status=404)
            approval = Approval.model_validate_json(row[0])
            request = load_request(db, approval.request_id)
            if (approval.state != "pending" or approval.build_id != self._state.build or request.cancel_requested
                    or request.decision or approval.revision != value.expected_revision
                    or approval.proposal_digest != value.proposal_digest
                    or approval_binding(self._state, db, request.request_id, approval.call) != approval.proposal_digest):
                raise BackendError("stale_approval")
            approval.state = "approved" if value.approve else "denied"
            db.execute("UPDATE approvals SET payload=? WHERE id=?", (approval.model_dump_json(), approval.approval_id))
            db.execute("INSERT INTO decisions VALUES(?,?,?)", (value.decision_id, key, request.request_id))
            c.emit("approval", request.request_id, approval.state, approval=approval)
            c.hit("approval", request.request_id, approval.call_id)
            return request
        return await self._store.transact(operation)

    async def active_mcp_tools(self, request_id: str) -> list[str]:
        return await self._store.database.call(lambda db: loaded_mcp_keys(db, request_id))

    async def accept_code_tool(self, value: CodeChild) -> Receipt:
        submitted = Submit(request_id=value.request_id, text=f"Script {value.parent_step_id[:32]} tool {value.call.name}", tool_call=value.call)

        def operation(db: sqlite3.Connection, c: Changes) -> Receipt:
            existing = db.execute("SELECT digest,payload FROM requests WHERE id=?", (value.request_id,)).fetchone()
            if existing is not None:
                receipt = Receipt.model_validate_json(existing[1])
                if str(existing[0]) != digest(submitted.model_dump_json()) or receipt.parent_id != value.parent_request_id:
                    raise BackendError("codemode_tool_conflict")
                return receipt
            if metadata_value(db, "freeze_id") or metadata_value(db, "stopping") or metadata_value(db, "blocked"):
                raise BackendError("worker_frozen", status=503)
            parent = load_request(db, value.parent_request_id)
            step = load_step(db, value.parent_step_id)
            run = load_run(db, parent.request_id)
            if (parent.cancel_requested or parent.decision or step.request_id != parent.request_id or step.call is None
                    or step.call.name != "codemode" or step.phase not in {"intent", "code"} or value.call.name == "codemode"):
                raise BackendError("codemode_run_inactive")
            if run.depth >= 4 or len(pending_request_ids(db)) >= PENDING_LIMIT:
                raise BackendError("child_capacity")
            child = create_request(self._state, db, c, submitted, parent_id=parent.request_id, depth=run.depth + 1, inherited=run.config)
            step.children.append(child.request_id)
            parent.children.append(child.request_id)
            save_step(db, step)
            parent.status = "waiting_children"
            save_request(db, c, parent, "children")
            return child
        return await self._store.transact(operation)

    async def bind_model_tools(self, step_id: str, generation: int, catalog_json: str, plugin_catalog_json: str = "[]", search_catalog: str = "[]") -> None:
        """Persist the tool list before the provider stream. A later catalog cannot replace it."""
        plugins = TypeAdapter(list[PluginOffer]).validate_json(plugin_catalog_json)
        if any(plugin.session_id != self._state.session_id for plugin in plugins):
            raise BackendError("plugin_session_mismatch")
        def operation(db: sqlite3.Connection, _changes: Changes) -> None:
            step = load_step(db, step_id)
            request = load_request(db, step.request_id)
            if (step.kind != "model" or step.phase != "intent" or step.generation != generation
                    or request.generation != generation):
                raise BackendError("stale_generation")
            if step.plugin_catalog and step.plugin_catalog != plugin_catalog_json:
                raise BackendError("plugin_catalog_conflict")
            if step.mcp_catalog and step.mcp_catalog != catalog_json:
                raise BackendError("mcp_catalog_conflict")
            if step.search_catalog and step.search_catalog != search_catalog:
                raise BackendError("mcp_catalog_conflict")
            if step.mcp_catalog != catalog_json or step.plugin_catalog != plugin_catalog_json or step.search_catalog != search_catalog:
                step.mcp_catalog = catalog_json
                step.plugin_catalog = plugin_catalog_json
                step.search_catalog = search_catalog
                save_step(db, step)
        await self._store.transact(operation)

    async def check_computer_intent(self, value: ComputerToolRequest) -> None:
        def operation(db: sqlite3.Connection) -> None:
            check_fence(self._state, db, value)
            step = load_step(db, value.step_id)
            request = load_request(db, value.request_id)
            if (step.phase != "intent" or step.request_id != value.request_id or step.generation != value.generation
                    or request.generation != value.generation or request.cancel_requested or request.decision
                    or step.call != value.call or value.call.name not in {"computer_observe", "computer_act", "computer_locate", "computer_ground"}
                    or metadata_value(db, "freeze_id") or metadata_value(db, "stopping") or metadata_value(db, "blocked")):
                raise BackendError("computer_intent_mismatch")
        await self._store.database.call(operation)

    async def refresh_effect_proofs(self, proofs: list[EffectHold]) -> None:
        """Accept monotone cleanup facts from the current execution authority, never user reconciliation."""
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            for proof in proofs:
                row = db.execute("SELECT payload FROM effects WHERE id=?", (proof.call_id,)).fetchone()
                if row is None or proof.session_id != self._state.session_id or not proof.resource_clean:
                    continue
                hold = EffectHold.model_validate_json(str(row[0]))
                if hold.resource_clean or hold.request_id != proof.request_id:
                    continue
                hold.resource_clean = True
                db.execute("UPDATE effects SET payload=? WHERE id=?", (hold.model_dump_json(), hold.call_id))
                c.emit("effect", hold.request_id, hold.model_dump_json())
        await self._store.transact(operation)

    async def resolve(self, value: EffectResolution, fence: HostFence) -> Receipt:
        def operation(db: sqlite3.Connection, c: Changes) -> Receipt:
            check_fence(self._state, db, fence)
            row = db.execute("SELECT digest,request_id FROM resolutions WHERE id=? OR json_extract(payload,'$.call_id')=?",
                             (value.resolution_id, value.call_id)).fetchone()
            key = digest(value.model_dump_json())
            if row:
                if row[0] != key:
                    raise BackendError("resolution_conflict")
                return load_request(db, row[1])
            if metadata_value(db, "freeze_id") or metadata_value(db, "stopping"):
                raise BackendError("worker_frozen")
            if metadata_value(db, "blocked"):
                raise BackendError("worker_blocked", status=503)
            row = db.execute("SELECT payload FROM effects WHERE id=?", (value.call_id,)).fetchone()
            if not row:
                raise BackendError("effect_not_found", status=404)
            hold = EffectHold.model_validate_json(row[0])
            if hold.reconciled:
                raise BackendError("resolution_conflict")
            if not hold.resource_clean:
                raise BackendError("execution_cleanup_pending")
            db.execute("INSERT INTO resolutions(id,digest,request_id,payload) VALUES(?,?,?,?)",
                       (value.resolution_id, key, hold.request_id, value.model_dump_json()))
            c.emit("effect", hold.request_id, value.model_dump_json())
            return load_request(db, hold.request_id)
        return await self._store.transact(operation)

    async def recover(self, *, frozen: bool = False, initial_cleanup: Cleanup | None = None,
                      validation: bool = False) -> None:
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            if initial_cleanup and (initial_cleanup.session_id != self._state.session_id
                                    or initial_cleanup.state != "clean" or not initial_cleanup.proof_id):
                raise BackendError("cleanup_identity_mismatch")
            if metadata_value(db, "driver_id") != self._state.instance:
                set_metadata_value(db, "stopping", "")
                if initial_cleanup and initial_cleanup.state == "clean" and initial_cleanup.proof_id:
                    set_metadata_value(db, "blocked", "")
                set_metadata_value(db, "driver_id", self._state.instance)
                set_metadata_value(db, "execution_epoch", "0")
            if initial_cleanup:
                set_metadata_value(db, "execution_epoch", str(initial_cleanup.execution_epoch))
            if frozen and not metadata_value(db, "freeze_id"):
                set_metadata_value(db, "freeze_id", "startup")
                c.emit("freeze", text="startup")
            if validation:
                return
            db.execute("DELETE FROM previews")
            for r in list_requests(db):
                if r.status in TERMINAL or r.kind == "steer":
                    continue
                r.generation += 1
                save_request(db, c, r)
                run = load_run(db, r.request_id)
                run.opening = False
                if run.lease:
                    run.cleanup_required = True
                save_run(db, run)
                for step in list_steps(db, r.request_id):
                    if step.kind == "model" and step.phase == "intent":
                        step.phase = "unknown"
                        save_step(db, step)
                        decide_request(db, c, r, Decision(status="unknown", error="model_outcome_unknown"))
                for row in db.execute("SELECT payload FROM approvals WHERE request_id=?", (r.request_id,)).fetchall():
                    approval = Approval.model_validate_json(row[0])
                    if approval.state in {"pending", "approved"} and (
                        approval.build_id != self._state.build or approval.proposal_digest != approval_binding(self._state, db, r.request_id, approval.call)
                    ):
                        expire_approvals(db, c, r.request_id)
                        break
        await self._store.transact(operation)

    async def active_summary(self) -> str:
        return await self._store.database.call(load_active_summary)

    async def advance(self, observation: Observation | None = None) -> Action:
        def operation(db: sqlite3.Connection, c: Changes) -> Action:
            if observation is not None:
                apply_observation(self._state, db, c, observation)
                return Continue()
            if metadata_value(db, "blocked"):
                return Park("blocked")
            resolution = db.execute("SELECT request_id,payload FROM resolutions WHERE result='' ORDER BY rowid LIMIT 1").fetchone()
            if resolution and not metadata_value(db, "freeze_id") and not metadata_value(db, "stopping"):
                return ReconcileEffect(resolution[0], EffectResolution.model_validate_json(resolution[1]))
            requests = [r for r in list_requests(db) if r.status not in TERMINAL and r.kind != "steer"]
            # Clean every owned lease before selecting more business work, including when frozen.
            for request in requests:
                run = load_run(db, request.request_id)
                if run.lease and (run.cleanup_required or request.decision or request.status in {"waiting_approval", "waiting_children"}
                                  or metadata_value(db, "freeze_id") or metadata_value(db, "stopping")):
                    return CloseEpoch(request.request_id, run.lease)
            for request in requests:
                if request.status == "waiting_children":
                    for step in list_steps(db, request.request_id):
                        if step.phase == "children" and any(
                            (child := load_request(db, key)).status in TERMINAL and child.status != "succeeded"
                            for key in step.children
                        ):
                            join_children(db, c, request, step)
                            if c.events:
                                return Continue()
            # Children are independent contexts, driven deepest first; root FIFO remains intact.
            active = [r for r in requests if r.status not in {"queued", "waiting_time"}]
            root = next((r for r in active if r.kind == "root"), None)
            candidates = requests
            if root:
                tree = {root.request_id}
                for _ in range(4):
                    tree.update(r.request_id for r in requests if r.parent_id in tree)
                candidates = [r for r in requests if r.request_id in tree]
            candidates.sort(key=lambda r: -load_run(db, r.request_id).depth)
            wake = min((r.not_before_ms for r in requests if r.not_before_ms > clock.now_ms()), default=0)
            for request in candidates:
                db.execute("SAVEPOINT advance_request")
                event_count, hook_count = len(c.events), len(c.hooks)
                try:
                    action = advance_request(self._state, db, c, request)
                    db.execute("RELEASE advance_request")
                except (ValueError, BackendError) as exc:
                    db.execute("ROLLBACK TO advance_request")
                    db.execute("RELEASE advance_request")
                    del c.events[event_count:]
                    del c.hooks[hook_count:]
                    request = load_request(db, request.request_id)
                    decide_request(db, c, request, Decision(status="failed", error=exc.code if isinstance(exc, BackendError) else "invalid_tool_arguments"))
                    return Continue()
                if not isinstance(action, Park):
                    return action
                if action.reason in {"approval", "children"}:
                    return action
            return Park("frozen" if metadata_value(db, "freeze_id") else "idle", wake)
        return await self._store.transact(operation)

    async def begin_compaction(self, compaction_id: str, through_request_id: str, instructions: str = "") -> Compaction | None:
        """Reserve one summary. A stored row is returned. An open claim is not sent again."""
        def operation(db: sqlite3.Connection, _c: Changes) -> Compaction | None:
            _, basis = compaction_source(db, through_request_id)
            claim_basis = compaction_basis([basis, instructions])
            stored = db.execute("SELECT payload FROM compactions WHERE id=?", (compaction_id,)).fetchone()
            if stored is not None:
                previous = Compaction.model_validate_json(stored[0])
                if previous.through_request_id != through_request_id or previous.basis != basis or previous.instructions != instructions:
                    raise BackendError("compaction_conflict")
                return previous
            own_claim = db.execute("SELECT through_request_id,basis FROM compaction_claims WHERE id=?", (compaction_id,)).fetchone()
            if own_claim is not None and (str(own_claim["through_request_id"]) != through_request_id or str(own_claim["basis"]) != claim_basis):
                raise BackendError("compaction_conflict")
            same = db.execute(
                "SELECT payload FROM compactions WHERE basis=? "
                "AND json_extract(payload,'$.through_request_id')=? "
                "AND coalesce(json_extract(payload,'$.instructions'),'')=? ORDER BY rowid LIMIT 1",
                (basis, through_request_id, instructions)).fetchone()
            if same is not None:
                reused = Compaction.model_validate_json(same[0]).model_copy(update={"compaction_id": compaction_id})
                db.execute("INSERT INTO compactions(id,basis,payload) VALUES(?,?,?)", (compaction_id, basis, reused.model_dump_json()))
                return reused
            claim = db.execute(
                "SELECT id,basis FROM compaction_claims WHERE through_request_id=? "
                "AND NOT EXISTS (SELECT 1 FROM compactions WHERE id=compaction_claims.id) "
                "ORDER BY rowid LIMIT 1",
                (through_request_id,)).fetchone()
            if claim is not None:
                if str(claim["id"]) != compaction_id or str(claim["basis"]) != claim_basis:
                    raise BackendError("compaction_conflict")
                raise BackendError("compaction_pending", status=503)
            db.execute(
                "INSERT INTO compaction_claims(id,through_request_id,basis) VALUES(?,?,?)",
                (compaction_id, through_request_id, claim_basis))
            return None
        return await self._store.transact(operation)

    async def release_compaction(self, compaction_id: str) -> None:
        """Drop a claim that never reached the model. A stored summary stays."""
        def operation(db: sqlite3.Connection, _c: Changes) -> None:
            stored = db.execute("SELECT 1 FROM compactions WHERE id=?", (compaction_id,)).fetchone()
            if stored is not None:
                return
            db.execute("DELETE FROM compaction_claims WHERE id=?", (compaction_id,))
        await self._store.transact(operation)

    async def commit_compaction(self, compaction_id: str, through_request_id: str, summary: str, basis: str, instructions: str = "") -> Compaction:
        """Store a summary without deleting the messages it covers. A stale basis writes nothing."""
        def operation(db: sqlite3.Connection, c: Changes) -> Compaction:
            row = db.execute("SELECT payload FROM requests WHERE id=?", (through_request_id,)).fetchone()
            if row is None:
                raise BackendError("compaction_unsettled")
            receipt = Receipt.model_validate_json(row[0])
            payloads = load_message_payloads(db, through_request_id)
            if receipt.kind != "root" or receipt.status != "succeeded" or receipt.decision is None or not payloads:
                raise BackendError("compaction_unsettled")
            current = compaction_basis(payloads)
            if current != basis:
                raise BackendError("compaction_expired")
            claim = db.execute("SELECT through_request_id,basis FROM compaction_claims WHERE id=?", (compaction_id,)).fetchone()
            if claim is not None and (str(claim["through_request_id"]) != through_request_id
                                      or str(claim["basis"]) != compaction_basis([basis, instructions])):
                raise BackendError("compaction_conflict")
            record = Compaction(compaction_id=compaction_id, through_request_id=through_request_id, basis=current,
                                message_count=len(payloads), summary=summary, instructions=instructions)
            existing = db.execute("SELECT payload FROM compactions WHERE id=?", (compaction_id,)).fetchone()
            if existing:
                previous = Compaction.model_validate_json(existing[0])
                if previous != record:
                    raise BackendError("compaction_conflict")
                return previous
            db.execute("INSERT INTO compactions(id,basis,payload) VALUES(?,?,?)",
                       (compaction_id, current, record.model_dump_json()))
            c.emit("compaction", through_request_id, summary)
            return record
        return await self._store.transact(operation)

    async def freeze(self, fence: HostFence, freeze_id: str, *, cancel_work: bool = False) -> None:
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            check_fence(self._state, db, fence)
            existing = metadata_value(db, "freeze_id")
            if existing and existing not in {freeze_id, "startup"}:
                raise BackendError("freeze_conflict")
            if not freeze_id:
                raise BackendError("invalid_freeze_id")
            set_metadata_value(db, "freeze_id", freeze_id)
            c.emit("freeze", text=freeze_id)
            if cancel_work:
                for r in list_requests(db):
                    if r.kind == "root" and r.status not in TERMINAL:
                        cancel_request_tree(db, c, r.request_id)
        await self._store.transact(operation)

    async def thaw(self, fence: HostFence, freeze_id: str) -> None:
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            check_fence(self._state, db, fence)
            if metadata_value(db, "freeze_id") != freeze_id or not freeze_id:
                raise BackendError("freeze_conflict")
            if metadata_value(db, "blocked") or metadata_value(db, "stopping"):
                raise BackendError("worker_blocked")
            set_metadata_value(db, "freeze_id", "")
            c.emit("freeze", text="thawed:" + freeze_id)
        await self._store.transact(operation)

    async def stopping(self, fence: HostFence, execution_epoch: int | None = None, *,
                       cancel_work: bool = True, require_idle: bool = False) -> None:
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            check_fence(self._state, db, fence)
            if execution_epoch is not None and execution_epoch != int(metadata_value(db, "execution_epoch")):
                raise BackendError("stale_execution_epoch")
            if require_idle:
                activity = session_activity(db)
                if activity.state != "ready" or activity.pending or activity.runnable:
                    raise BackendError("worker_busy", status=409)
            set_metadata_value(db, "stopping", "1")
            c.emit("status", text="stopping")
            if cancel_work:
                for r in list_requests(db):
                    if r.kind == "root" and r.status not in TERMINAL:
                        cancel_request_tree(db, c, r.request_id)
        await self._store.transact(operation)

    async def block(self, reason: str) -> None:
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            set_metadata_value(db, "blocked", reason)
            c.emit("status", text="blocked:" + reason)
        await self._store.transact(operation)

    async def activity(self) -> WorkerActivity:
        return await self._store.database.call(session_activity)

    async def messages(self, request_id: str) -> list[Message]:
        return await self._store.database.call(lambda db: load_messages(db, request_id))

    async def input_image(self, request_id: str, index: int) -> ImagePart:
        def operation(db: sqlite3.Connection) -> ImagePart:
            images = load_prompt_images(db, request_id)
            if index < 0 or index >= len(images):
                raise BackendError("image_not_found", status=404)
            return images[index]
        return await self._store.database.call(operation)

    async def history(self, before: str = "") -> HistoryPage:
        def operation(db: sqlite3.Connection) -> HistoryPage:
            cursor = 2**63 - 1
            if before:
                row = db.execute("SELECT ordinal FROM requests WHERE id=? AND kind='root'", (before,)).fetchone()
                if row is None:
                    raise BackendError("history_cursor_missing", status=404)
                cursor = int(row[0])
            rows = db.execute("SELECT id,payload FROM requests WHERE kind='root' AND ordinal<? ORDER BY ordinal DESC LIMIT 21", (cursor,)).fetchall()
            requests: list[Receipt] = []
            events: list[Event] = []
            used, event_bytes, truncated = 0, 0, False
            seq = metadata_value(db, "revision")
            for row in rows[:20]:
                payload = str(row["payload"])
                request = Receipt.model_validate_json(payload)
                if not request.answer:
                    imported = [Message.model_validate_json(str(item[0])).content for item in db.execute(
                        "SELECT payload FROM messages WHERE request_id=? AND message_key LIKE 'import:%' "
                        "AND json_extract(payload,'$.role')='assistant' ORDER BY ordinal", (request.request_id,))]
                    if imported:
                        request = request.model_copy(update={"answer": "\n\n".join(imported)})
                size = len(request.model_dump_json().encode())
                if used + size > SNAPSHOT_MAX_BYTES - SNAPSHOT_VIEW_BYTES - 65536:
                    if not requests:
                        raise BackendError("history_entry_limit", status=503)
                    break
                used += size
                requests.append(request)
                for message_row in db.execute("SELECT message_key,ordinal,payload FROM messages WHERE request_id=? ORDER BY ordinal", (request.request_id,)):
                    key = str(message_row[0])
                    if key == "compaction" or key.startswith("history:"):
                        continue
                    event = Event(seq=seq, kind="message", request_id=request.request_id, text="",
                        message=display_message(key, int(message_row[1]), Message.model_validate_json(str(message_row[2]))))
                    event_size = len(event.model_dump_json().encode())
                    if event_bytes + event_size > SNAPSHOT_VIEW_BYTES:
                        truncated = True
                        continue
                    event_bytes += event_size
                    events.append(event)
                for step_row in db.execute("SELECT payload FROM steps WHERE request_id=? ORDER BY ordinal", (request.request_id,)):
                    text = str(step_row[0])
                    if Step.model_validate_json(text).kind != "tool":
                        continue
                    event = Event(seq=seq, kind="tool", request_id=request.request_id, text=text)
                    event_size = len(event.model_dump_json().encode())
                    if event_bytes + event_size > SNAPSHOT_VIEW_BYTES:
                        truncated = True
                        continue
                    event_bytes += event_size
                    events.append(event)
            return HistoryPage(session_id=self._state.session_id, requests=list(reversed(requests)), events=events,
                               cursor=requests[-1].request_id if requests else before,
                               more=len(rows) > len(requests), truncated=truncated)
        return await self._store.database.call(operation)

    async def message_payloads(self, request_id: str) -> list[str]:
        return await self._store.database.call(lambda db: load_message_payloads(db, request_id))

    async def transcript(self) -> list[tuple[str, str, str]]:
        return await self._store.database.call(load_transcript)

    async def import_transcript(self, messages: list[tuple[str, str, str]]) -> None:
        def operation(db: sqlite3.Connection, c: Changes) -> None:
            existing = load_transcript(db)
            if existing:
                if existing != messages:
                    raise BackendError("import_conflict")
                return
            grouped: dict[str, list[tuple[str, str]]] = {}
            order: list[str] = []
            for request_id, role, content in messages:
                if request_id not in grouped:
                    order.append(request_id)
                    grouped[request_id] = []
                grouped[request_id].append((role, content))
            for request_id in order:
                items = grouped[request_id]
                text = next((content for role, content in items if role == "user"), items[0][1])
                receipt = create_request(self._state, db, c, Submit(request_id=request_id, text=text[:16000]))
                for index, (role, content) in enumerate(items):
                    message = Message.model_validate({"role": role, "content": content})
                    append_message(db, c, request_id, f"import:{index}", message)
                answer = next((content for role, content in reversed(items) if role == "assistant"), "")
                decide_request(db, c, receipt, Decision(status="succeeded", answer=answer))
                settle_request(db, c, receipt)
        await self._store.transact(operation)

    async def search(self, query: str) -> list[SearchHit]:
        text = query.strip()
        if not text or len(text) > 200:
            raise BackendError("search_query")
        needle = text.casefold()

        def operation(db: sqlite3.Connection) -> list[SearchHit]:
            hits: list[SearchHit] = []
            rows = db.execute(
                "SELECT id, payload FROM requests ORDER BY ordinal")
            messages = db.execute(
                "SELECT request_id, ordinal, payload FROM messages ORDER BY rowid")
            grouped: dict[str, list[tuple[int, str]]] = {}
            for request_id, ordinal, payload in messages:
                grouped.setdefault(str(request_id), []).append((int(ordinal), str(payload)))
            for request_id, payload in rows:
                if len(hits) >= 50:
                    break
                receipt = Receipt.model_validate_json(str(payload))
                hits.extend(search_text(str(request_id), 0, "user", receipt.text, needle))
                for ordinal, body in sorted(grouped.get(str(request_id), [])):
                    if len(hits) >= 50:
                        break
                    message = Message.model_validate_json(body)
                    hits.extend(search_text(str(request_id), ordinal, message.role, message.content, needle))
            return hits[:50]

        return await self._store.database.call(operation)

    async def usage(self) -> UsageReport:
        """Sum tokens from finished model steps. In-progress calls and tool results are not usage."""

        def operation(db: sqlite3.Connection) -> UsageReport:
            calls = 0
            input_tokens = 0
            output_tokens = 0
            cache_read_tokens = 0
            cache_write_tokens = 0
            signatures = 0
            priced_calls = 0
            unpriced_calls = 0
            cost = 0
            for (payload,) in db.execute("SELECT payload FROM steps"):
                step = Step.model_validate_json(str(payload))
                if step.kind != "model" or step.phase not in {"result", "applied"} or not step.result:
                    continue
                completion = Completion.model_validate_json(step.result)
                calls += 1
                input_tokens += completion.input_tokens
                output_tokens += completion.output_tokens
                cache_read_tokens += completion.cache_read_tokens
                cache_write_tokens += completion.cache_write_tokens
                if completion.message.reasoning_signature:
                    signatures += 1
                pin = completion.price_input_micro_per_million
                pout = completion.price_output_micro_per_million
                pcr = completion.price_cache_read_micro_per_million
                pcw = completion.price_cache_write_micro_per_million
                cache_priced = pcr is not None and pcw is not None
                if pin is None or pout is None or ((completion.cache_read_tokens or completion.cache_write_tokens) and not cache_priced):
                    unpriced_calls += 1
                    continue
                priced_calls += 1
                cost += token_cost_micro(
                    completion.input_tokens, completion.output_tokens,
                    completion.cache_read_tokens, completion.cache_write_tokens,
                    (pin, pout, pcr or 0, pcw or 0))
            priced = unpriced_calls == 0
            return UsageReport(
                session_id=self._state.session_id, model_calls=calls, input_tokens=input_tokens,
                output_tokens=output_tokens, cache_read_tokens=cache_read_tokens,
                cache_write_tokens=cache_write_tokens, reasoning_signatures=signatures,
                priced_calls=priced_calls, unpriced_calls=unpriced_calls,
                priced=priced, cost_micro_usd=cost if priced else None)

        return await self._store.database.call(operation)

    async def diagnostic(self) -> SessionDiagnostic:
        """Read persisted session state. Free-form errors stay in the database."""

        def operation(db: sqlite3.Connection) -> SessionDiagnostic:
            blocked_raw = metadata_value(db, "blocked")
            state: Literal["ready", "blocked", "stopping", "frozen"]
            if blocked_raw:
                state = "blocked"
            elif metadata_value(db, "stopping"):
                state = "stopping"
            elif metadata_value(db, "freeze_id"):
                state = "frozen"
            else:
                state = "ready"
            failed = 0
            unknown = 0
            codes: set[str] = set()
            for (payload,) in db.execute("SELECT payload FROM requests"):
                receipt = Receipt.model_validate_json(str(payload))
                if receipt.decision is None:
                    continue
                if receipt.decision.status == "failed":
                    failed += 1
                elif receipt.decision.status == "unknown":
                    unknown += 1
                if receipt.decision.error:
                    codes.add(public_error_code(receipt.decision.error))
            return SessionDiagnostic(
                session_id=self._state.session_id, present=True, state=state,
                blocked_code=public_error_code(blocked_raw) if blocked_raw else "",
                failed=failed, unknown=unknown, error_codes=sorted(codes))

        return await self._store.database.call(operation)

    async def prepare_branch(self, parent: Path, request_id: str, web: WebPolicy,
                             computer: ComputerPolicy) -> Receipt:
        """Copy a settled turn and its policies on the writer already owned by this worker."""
        await self.initialize()
        receipt = await self.import_settled_root(parent, request_id)
        await self.save_web_policy(web)
        await self.save_computer_policy(computer)
        return receipt

    async def import_settled_root(self, parent: Path, request_id: str) -> Receipt:
        """Copy one settled root into an empty session. No lease, effect, or approval is copied."""
        copied_digest, receipt, messages, run_payload = read_settled_root(parent, request_id)

        def operation(db: sqlite3.Connection, c: Changes) -> Receipt:
            count = int(db.execute("SELECT count(*) FROM requests").fetchone()[0])
            existing = db.execute("SELECT digest FROM requests WHERE id=?", (request_id,)).fetchone()
            if count:
                if count == 1 and existing is not None and str(existing[0]) == copied_digest:
                    return load_request(db, request_id)
                raise BackendError("branch_target_not_empty")
            local = receipt.model_copy(update={"accepted_revision": str(c.seq), "revision": str(c.seq)})
            db.execute("INSERT INTO requests(id,digest,payload) VALUES(?,?,?)",
                       (request_id, copied_digest, local.model_dump_json()))
            db.execute("INSERT INTO runs(request_id,payload) VALUES(?,?)", (request_id, run_payload))
            loaded = Run.model_validate_json(run_payload).loaded_mcp_tools
            set_metadata_value(db, "loaded_mcp_tools", json.dumps(loaded))
            set_metadata_value(db, "codemode_state", Run.model_validate_json(run_payload).codemode_state)
            for key, payload in messages:
                message = Message.model_validate_json(payload)
                append_message(db, c, request_id, key, message)
                if key == "input" and message.images:
                    save_prompt_images(db, request_id, message.images)
            c.emit("status", request_id, "branched", receipt=local.model_copy(deep=True))
            return local

        return await self._store.transact(operation)

    async def snapshot(self, state: WorkerState | None = None) -> Snapshot:
        def operation(db: sqlite3.Connection) -> Snapshot:
            activity = session_activity(db)
            fact_bytes = 0

            def load[T: Model](model: type[T], query: str, args: tuple[str | int, ...] = ()) -> list[T]:
                nonlocal fact_bytes
                values: list[T] = []
                for row in db.execute(query, args):
                    payload = str(row[0])
                    fact_bytes += len(payload.encode())
                    if fact_bytes > SNAPSHOT_MAX_BYTES - SNAPSHOT_VIEW_BYTES - 65536:
                        raise BackendError("snapshot_fact_limit", status=503)
                    values.append(model.model_validate_json(payload))
                return values

            selected = pending_request_ids(db)
            terminal = ",".join("?" for _ in TERMINAL)
            selected.update(str(r[0]) for r in db.execute(
                f"SELECT id FROM requests WHERE kind='root' AND status IN ({terminal}) "
                "ORDER BY CAST(json_extract(payload,'$.revision') AS INTEGER) DESC,ordinal DESC LIMIT 20", tuple(TERMINAL)))
            children = db.execute(f"SELECT id,payload FROM requests WHERE kind!='root' AND status IN ({terminal}) "
                "ORDER BY CAST(json_extract(payload,'$.revision') AS INTEGER) DESC,ordinal DESC LIMIT 21", tuple(TERMINAL)).fetchall()
            child_bytes = 0
            truncated = len(children) > 20
            for row in children[:20]:
                if str(row[0]) in selected:
                    continue
                size = len(str(row[1]).encode())
                if child_bytes + size > SNAPSHOT_CHILD_BYTES:
                    truncated = True
                    continue
                child_bytes += size
                selected.add(str(row[0]))
            ids = tuple(sorted(selected))
            slots = ",".join("?" for _ in ids) or "NULL"
            requests = load(Receipt, f"SELECT payload FROM requests WHERE id IN ({slots}) ORDER BY ordinal", ids)
            requests.extend(load(Receipt,
                "SELECT payload FROM cancellations WHERE id NOT IN (SELECT id FROM requests) ORDER BY rowid DESC LIMIT 20"))
            effects = load(EffectHold, "SELECT payload FROM effects WHERE "
                "NOT json_extract(payload,'$.reconciled') OR NOT json_extract(payload,'$.resource_clean') "
                "OR rowid IN (SELECT rowid FROM effects WHERE json_extract(payload,'$.reconciled') "
                "AND json_extract(payload,'$.resource_clean') ORDER BY rowid DESC LIMIT 20) ORDER BY rowid")
            approvals = load(Approval, f"SELECT payload FROM approvals WHERE request_id IN ({slots}) AND "
                "(json_extract(payload,'$.state') IN ('pending','approved') OR rowid IN "
                "(SELECT rowid FROM approvals ORDER BY rowid DESC LIMIT 20)) ORDER BY rowid", ids)
            previews = load(Preview, "SELECT p.payload FROM previews p JOIN requests r ON r.id=p.request_id "
                "WHERE r.status='running' AND json_extract(r.payload,'$.decision') IS NULL "
                "AND json_extract(p.payload,'$.generation')=json_extract(r.payload,'$.generation')")
            seq = metadata_value(db, "revision")
            events: list[Event] = []
            for run in load(Run, f"SELECT payload FROM runs WHERE request_id IN ({slots})", ids):
                if run.lease or run.opening or run.cleanup:
                    events.append(Event(seq=seq, kind="cleanup", request_id=run.request_id, text=run.model_dump_json()))
            for row in db.execute("SELECT request_id,payload FROM resolutions WHERE result=''"):
                event = Event(seq=seq, kind="effect", request_id=str(row[0]), text=str(row[1]))
                fact_bytes += len(event.model_dump_json().encode())
                if fact_bytes > SNAPSHOT_MAX_BYTES - SNAPSHOT_VIEW_BYTES - 65536:
                    raise BackendError("snapshot_fact_limit", status=503)
                events.append(event)

            view_bytes = 0
            # Display history is bounded separately from all pending business facts.
            for request in reversed(requests):
                for table, kind in (("messages", "message"), ("steps", "tool")):
                    columns = "payload,message_key,ordinal" if kind == "message" else "payload"
                    rows = db.execute(f"SELECT {columns} FROM {table} WHERE request_id=? ORDER BY ordinal DESC LIMIT 9",
                                      (request.request_id,)).fetchall()
                    truncated = truncated or len(rows) > 8
                    accepted: list[Event] = []
                    for row in rows[:8]:
                        text = str(row[0])
                        message = None
                        if kind == "message":
                            key = str(row[1])
                            if key == "compaction" or key.startswith("history:"):
                                continue
                            message = display_message(key, int(row[2]), Message.model_validate_json(text))
                            text = ""
                        else:
                            text = event_step_text(Step.model_validate_json(text))
                        event = Event.model_validate(dict(seq=seq, kind=kind, request_id=request.request_id,
                                                          text=text, message=message))
                        size = len(event.model_dump_json().encode())
                        if view_bytes + size > SNAPSHOT_VIEW_BYTES - 256:
                            truncated = True
                            continue
                        view_bytes += size
                        accepted.append(event)
                    events.extend(reversed(accepted))
            if truncated:
                events.append(Event(seq=seq, kind="status", request_id="", text="snapshot_view_truncated"))
            snapshot = Snapshot(session_id=self._state.session_id, stream_id=metadata_value(db, "stream_id"), seq=seq,
                                compaction=load_active_summary(db),
                                state=activity.state if activity.state != "ready" else state or "ready", requests=requests,
                                events=events, approvals=approvals, effects=effects, previews=previews,
                                next_wake_ms=activity.next_wake_ms, pending=activity.pending)
            if len(snapshot.model_dump_json().encode()) > SNAPSHOT_MAX_BYTES:
                raise BackendError("snapshot_fact_limit", status=503)
            return snapshot
        return await self._store.database.call(operation)

    async def events(self, after: int, stream_id: str = "") -> Replay:
        def operation(db: sqlite3.Connection) -> Replay:
            current = metadata_value(db, "stream_id")
            seq = int(metadata_value(db, "revision"))
            earliest = db.execute("SELECT coalesce(min(seq),?) FROM batches", (seq + 1,)).fetchone()[0]
            resync = (bool(stream_id and stream_id != current) or after < 0 or after > seq or after < earliest - 1)
            batches: list[CommitBatch] = []
            size = 0
            if not resync:
                for row in db.execute("SELECT payload,bytes FROM batches WHERE seq>? ORDER BY seq LIMIT 16", (after,)):
                    if batches and size + row[1] > 524288:
                        break
                    batches.append(CommitBatch.model_validate_json(row[0]))
                    size += row[1]
            # seq is the watermark actually delivered, never an unseen later transaction.
            return Replay(stream_id=current, seq=str(seq if resync else int(batches[-1].seq) if batches else after),
                          batches=batches, resync=resync)
        return await self._store.database.call(operation)


def _model(value: BaseModel) -> str:
    return value.model_dump_json()


async def run_session_op(store: SessionStore, name: SessionOpName, payload: str) -> str:
    if name == "prepare_branch":
        body = PrepareBranchBody.model_validate_json(payload)
        return _model(await store.prepare_branch(Path(body.parent_path), body.request_id, body.web, body.computer))
    if name == "stopping":
        body = StoppingBody.model_validate_json(payload)
        await store.stopping(body.fence, body.execution_epoch, cancel_work=body.cancel_work)
        return ""
    if name == "accept_code_tool":
        return _model(await store.accept_code_tool(CodeChild.model_validate_json(payload)))
    """Run one session-library operation on the store that already holds the lock."""
    if name == "host_epoch":
        return _model(EpochValue(value=await store.host_epoch()))
    if name == "snapshot":
        body = SnapshotBody.model_validate_json(payload or "{}")
        return _model(await store.snapshot(body.state))
    if name == "workflow":
        return _model(await store.workflow(IdBody.model_validate_json(payload).id))
    if name == "resume_workflow":
        return _model(await store.resume_workflow(IdBody.model_validate_json(payload).id))
    if name == "open_workflow":
        body = OpenWorkflowBody.model_validate_json(payload)
        return _model(await store.open_workflow(body.workflow_id, body.check, body.correction_limit,
                                                accepted_config=body.accepted_config))
    if name == "record_verdict":
        body = VerdictBody.model_validate_json(payload)
        return _model(await store.record_verdict(
            body.workflow_id, body.verdict_id, body.passed, allow_new_child=body.allow_new_child))
    if name == "cancel":
        body = CancelBody.model_validate_json(payload)
        return _model(await store.cancel(body.request_id, body.fence))
    if name == "cancel_workflow_child":
        body = ChildBody.model_validate_json(payload)
        return _model(await store.cancel_workflow_child(body.workflow_id, body.request_id))
    if name == "save_web_policy":
        return _model(await store.save_web_policy(WebPolicy.model_validate_json(payload)))
    if name == "web_policy":
        return _model(await store.web_policy())
    if name == "begin_web_call":
        body = BeginWebBody.model_validate_json(payload)
        view, send = await store.begin_web_call(body.call_id, body.kind, body.body)
        return _model(BeginWebResult(view=view, send=send))
    if name == "settle_web_call":
        body = SettleWebBody.model_validate_json(payload)
        return _model(await store.settle_web_call(body.call_id, body.phase, body.error, body.result))
    if name == "save_computer_policy":
        return _model(await store.save_computer_policy(ComputerPolicy.model_validate_json(payload)))
    if name == "computer_policy":
        return _model(await store.computer_policy())
    if name == "computer_blocked":
        return _model(FlagValue(value=await store.computer_blocked()))
    if name == "computer_runtime":
        blocked, exit_code, proof = await store.computer_runtime()
        return _model(RuntimeValue(blocked=blocked, exit_code=exit_code, proof=proof))
    if name == "find_computer_action":
        body = FindActionBody.model_validate_json(payload)
        return _model(FoundAction(view=await store.find_computer_action(body.action_id, body.body)))
    if name == "latest_computer_capture":
        found = await store.latest_computer_capture()
        return "" if found is None else _model(found)
    if name == "messages":
        return _model(MessageList(messages=await store.messages(IdBody.model_validate_json(payload).id)))
    if name == "note_computer_exit":
        await store.note_computer_exit(ExitBody.model_validate_json(payload or "{}").exit_code)
        return ""
    if name == "save_computer_capture":
        return _model(await store.save_computer_capture(ComputerCaptureView.model_validate_json(payload)))
    if name == "begin_computer_action":
        body = BeginComputerBody.model_validate_json(payload)
        view, send = await store.begin_computer_action(body.action_id, body.body)
        return _model(BeginComputerResult(view=view, send=send))
    if name == "settle_computer_action":
        body = SettleComputerBody.model_validate_json(payload)
        return _model(await store.settle_computer_action(
            body.action_id, body.phase, body.error, body.driver_x, body.driver_y, body.result, body.images))
    if name == "finish_computer_cleanup":
        return _model(TextValue(value=await store.finish_computer_cleanup(TextValue.model_validate_json(payload).value)))
    if name == "begin_compaction":
        body = BeginCompactionBody.model_validate_json(payload)
        return _model(CompactionClaim(compaction=await store.begin_compaction(
            body.compaction_id, body.through_request_id, body.instructions)))
    if name == "release_compaction":
        await store.release_compaction(BeginCompactionBody.model_validate_json(payload).compaction_id)
        return ""
    if name == "commit_compaction":
        body = CompactBody.model_validate_json(payload)
        return _model(await store.commit_compaction(
            body.compaction_id, body.through_request_id, body.summary, body.basis, body.instructions))
    if name == "import_transcript":
        body = TranscriptBody.model_validate_json(payload)
        await store.import_transcript([(item.request_id, item.role, item.content) for item in body.messages])
        return ""
    raise BackendError("session_op_unknown")


class SessionOps(Protocol):
    async def prepare_branch(self, parent: Path, request_id: str, web: WebPolicy, computer: ComputerPolicy) -> Receipt: ...
    async def stopping(self, fence: HostFence, execution_epoch: int | None = None, *, cancel_work: bool = True) -> None: ...
    async def accept_code_tool(self, value: CodeChild) -> Receipt: ...
    async def open_workflow(self, workflow_id: str, check: str, correction_limit: int, *,
                            accepted_config: ProviderConfig | None = None) -> WorkflowView: ...
    async def workflow(self, workflow_id: str) -> WorkflowView: ...
    async def resume_workflow(self, workflow_id: str) -> WorkflowView: ...
    async def record_verdict(self, workflow_id: str, verdict_id: str, passed: bool, *,
                             allow_new_child: bool = True) -> WorkflowView: ...
    async def cancel(self, request_id: str, fence: HostFence) -> Receipt: ...
    async def host_epoch(self) -> int: ...
    async def snapshot(self, state: WorkerState | None = None) -> Snapshot: ...
    async def cancel_workflow_child(self, workflow_id: str, request_id: str) -> WorkflowView: ...
    async def save_web_policy(self, value: WebPolicy) -> WebPolicy: ...
    async def web_policy(self) -> WebPolicy: ...
    async def begin_web_call(self, call_id: str, kind: Literal["search", "fetch"], body: str) -> tuple[WebCallView, bool]: ...
    async def settle_web_call(self, call_id: str, phase: Literal["unknown", "done", "failed"], error: str, result: str) -> WebCallView: ...
    async def save_computer_policy(self, value: ComputerPolicy) -> ComputerPolicy: ...
    async def computer_policy(self) -> ComputerPolicy: ...
    async def computer_blocked(self) -> bool: ...
    async def computer_runtime(self) -> tuple[bool, int | None, str]: ...
    async def find_computer_action(self, action_id: str, body: str) -> ComputerActionView | None: ...
    async def latest_computer_capture(self) -> ComputerCaptureView | None: ...
    async def messages(self, request_id: str) -> list[Message]: ...
    async def note_computer_exit(self, exit_code: int | None) -> None: ...
    async def save_computer_capture(self, value: ComputerCaptureView) -> ComputerCaptureView: ...
    async def begin_computer_action(self, action_id: str, body: str) -> tuple[ComputerActionView, bool]: ...
    async def settle_computer_action(self, action_id: str, phase: Literal["unknown", "done", "failed"], error: str, driver_x: int | None, driver_y: int | None, result: dict[str, JsonValue] | None = None,
                                     images: list[ImagePart] | None = None) -> ComputerActionView: ...
    async def finish_computer_cleanup(self, proof: str) -> str: ...
    async def begin_compaction(self, compaction_id: str, through_request_id: str, instructions: str = "") -> Compaction | None: ...
    async def release_compaction(self, compaction_id: str) -> None: ...
    async def commit_compaction(self, compaction_id: str, through_request_id: str, summary: str, basis: str, instructions: str = "") -> Compaction: ...
    async def import_transcript(self, messages: list[tuple[str, str, str]]) -> None: ...


@asynccontextmanager
async def read_session(path: Path, session_id: str, *, build: str = 'test-build') -> AsyncGenerator[SessionStore]:
    """A short-lived read-only session owner; never acquires a writer or starts an agent."""
    store = SessionStore(path, session_id, build=build, require_existing=True, read_only=True)
    try:
        await store.initialize()
        yield store
    finally:
        await store.close()
