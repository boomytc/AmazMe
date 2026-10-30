"""Private session driver operations; the caller owns the transaction."""
from __future__ import annotations

import json
import sqlite3

from pydantic import TypeAdapter

from amazme_backend.contracts.execution import EffectHold, EffectResolution, Shell, ToolResult
from amazme_backend.contracts.mcp import McpOffer
from amazme_backend.contracts.models import ImagePart, Message, checked_images
from amazme_backend.contracts.plugins import PluginToolCall
from amazme_backend.contracts.sessions import (
    Decision,
    Preview,
    Receipt,
)
from amazme_backend.contracts.tools import ToolSearchInput
from amazme_backend.contracts.web import WebCallView
from amazme_backend.features.tools.search import rank_tools, search_result
from amazme_backend.sessions.persistence import clock
from amazme_backend.sessions.persistence.records import (
    Changes,
    append_message,
    codemode_state_at,
    list_requests,
    list_steps,
    load_messages,
    load_prompt_images,
    load_request,
    load_run,
    load_step,
    loaded_mcp_keys,
    metadata_value,
    save_request,
    save_run,
    save_step,
    set_metadata_value,
    workflow_for_parent,
)
from amazme_backend.sessions.persistence.requests import (
    apply_step_result,
    claim_request,
    consume_approval,
    decide_request,
    delegate_children,
    grant_step,
    join_children,
    settle_request,
)
from amazme_backend.sessions.persistence.state import SessionContext
from amazme_backend.sessions.persistence.workflows import (
    park_or_settle_workflow,
)
from amazme_backend.sessions.policy.limits import (
    TERMINAL,
)
from amazme_backend.sessions.policy.projection import (
    digest,
    event_step_text,
)
from amazme_backend.sessions.types import (
    Action,
    CloseEpoch,
    CodemodeInput,
    CodeRetrieval,
    CodeReturned,
    Continue,
    EffectResolved,
    EpochClosed,
    EpochOpened,
    Failed,
    McpRetrieval,
    McpReturned,
    ModelInvocation,
    ModelReturned,
    Observation,
    OpenEpoch,
    Park,
    PluginRetrieval,
    PluginReturned,
    Previewed,
    QueryTool,
    ReconcileEffect,
    Step,
    ToolInvocation,
    ToolObserved,
    ToolReturned,
    WebRetrieval,
    WebReturned,
)
from amazme_backend.shared.errors import BackendError


def advance_request(state: SessionContext, db: sqlite3.Connection, c: Changes, request: Receipt) -> Action:
    run = load_run(db, request.request_id)
    steps = list_steps(db, request.request_id)
    for step in steps:
        if step.kind == "tool" and step.phase in {"intent", "code"} and step.call and step.call.name == "codemode":
            stopping = bool(request.cancel_requested or request.decision or metadata_value(db, "freeze_id") or metadata_value(db, "stopping"))
            if step.code_poll_ms > clock.now_ms():
                return Park("children", step.code_poll_ms)
            if not step.code_input_state:
                step.code_input_state = codemode_state_at(db, request.request_id)
                save_step(db, step)
            return CodeRetrieval(step.step_id, request.request_id, request.generation, step.call, run.config,
                                 state_scope=request.request_id if request.kind == "child" else "", initial_state=step.code_input_state,
                                 start=step.phase == "intent", stop=stopping)
        if step.kind == "tool" and step.phase == "intent" and step.call and step.call.name == "plugin_tool":
            return PluginRetrieval(step.step_id, request.request_id, request.generation, step.call,
                stop=bool(request.cancel_requested or request.decision or metadata_value(db, "freeze_id") or metadata_value(db, "stopping")))
        mcp_intent = step.kind == "tool" and step.phase == "intent" and step.call and step.call.name == "mcp_tool"
        if mcp_intent:
            if metadata_value(db, "freeze_id") or metadata_value(db, "stopping"):
                return Park("frozen")
            assert step.call is not None
            return McpRetrieval(step.step_id, request.request_id, request.generation, step.call,
                                stop=request.cancel_requested and not request.decision)
        web_intent = step.kind == "tool" and step.phase == "intent" and step.call and step.call.name in {
            "web_search", "web_fetch"}
        if web_intent:
            row = db.execute("SELECT payload FROM web_calls WHERE id=?", (step.step_id,)).fetchone()
            if row:
                held = WebCallView.model_validate_json(row[0])
                if held.phase == "unknown":
                    step.phase = "unknown"
                    save_step(db, step)
                    decide_request(db, c, request, Decision(
                        status="cancelled" if request.cancel_requested else "unknown",
                        error=held.error or "web_transport"))
                    c.emit("tool", request.request_id, held.error or "web_transport")
                    return Continue()
            if metadata_value(db, "freeze_id") or metadata_value(db, "stopping"):
                return Park("frozen")
            if request.cancel_requested and not request.decision:
                decide_request(db, c, request, Decision(status="cancelled"))
                return Continue()
            assert step.call is not None
            return WebRetrieval(step.step_id, request.request_id, request.generation, step.call)
        if step.kind == "tool" and step.phase == "intent":
            if step.call is not None and step.call.name in {"job_list", "job_output", "job_kill"}:
                if request.cancel_requested or request.decision:
                    step.phase = "result"
                    step.result = ToolResult(call_id=step.step_id, exit_code=1, stdout="", stderr="cancelled").model_dump_json()
                    save_step(db, step)
                    return Continue()
                assert run.lease is not None
                return ToolInvocation(step.step_id, request.request_id, request.generation, run.lease, step.call)
            return QueryTool(step.step_id, request.request_id, request.generation)
    if request.cancel_requested and not request.decision:
        for child in list_requests(db):
            if child.parent_id == request.request_id and child.status not in TERMINAL:
                return Park("children")
        decide_request(db, c, request, Decision(status="cancelled"))
        return Continue()
    if request.decision:
        if run.lease:
            return CloseEpoch(request.request_id, run.lease)
        if any(r.parent_id == request.request_id and r.kind == "child" and r.status not in TERMINAL
               for r in list_requests(db)):
            return Park("children")
        settle_request(db, c, request)
        return Continue()
    if run.cleanup_required and run.lease:
        return CloseEpoch(request.request_id, run.lease)
    if metadata_value(db, "freeze_id") or metadata_value(db, "stopping"):
        if run.lease:
            return CloseEpoch(request.request_id, run.lease)
        return Park("frozen")
    if request.status in {"queued", "waiting_time"}:
        if request.not_before_ms > clock.now_ms():
            return Park("time", request.not_before_ms)
        claim_request(state, db, c, request)
        return Continue()
    for step in steps:
        if step.phase == "result":
            apply_step_result(state, db, c, request, step)
            return Continue()
        if step.phase == "children":
            if run.lease:
                return CloseEpoch(request.request_id, run.lease)
            if join_children(db, c, request, step):
                return Continue()
            return Park("children")
        if step.phase == "proposed":
            if step.call is not None and step.call.name == "tool_search":
                search = ToolSearchInput.model_validate_json(step.call.arguments)
                loaded = set(loaded_mcp_keys(db, request.request_id))
                candidates = [offer for offer in TypeAdapter(list[McpOffer]).validate_json(step.search_catalog or "[]")
                              if offer.exposure in {"codemode", "deferred"} and offer.activation_key() not in loaded
                              and run.config.tool_allowed(offer.alias)]
                step.result = search_result(rank_tools(search.query, candidates, search.limit)).model_dump_json()
                step.phase = "result"
                save_step(db, step)
                c.emit("tool", request.request_id, event_step_text(step))
                return Continue()
            if step.call is not None and step.call.name == "codemode":
                CodemodeInput.model_validate_json(step.call.arguments)
                if run.lease:
                    return CloseEpoch(request.request_id, run.lease)
                step.phase, step.generation = "intent", request.generation
                step.code_input_state = codemode_state_at(db, request.request_id)
                save_step(db, step)
                c.emit("tool", request.request_id, event_step_text(step))
                return CodeRetrieval(step.step_id, request.request_id, request.generation, step.call, run.config, state_scope=request.request_id if request.kind == "child" else "", initial_state=step.code_input_state, start=True)
            if not grant_step(state, db, c, request, step):
                if request.decision:
                    return Continue()
                if run.lease:
                    return CloseEpoch(request.request_id, run.lease)
                return Park("approval")
            assert step.call is not None
            if request.status != "running":
                request.status = "running"
                save_request(db, c, request)
            if step.call.name == "delegate_task":
                delegate_children(state, db, c, request, step)
                return Continue()
            if step.call.name == "plugin_tool":
                consume_approval(db, c, step)
                step.phase, step.generation = "intent", request.generation
                save_step(db, step)
                request.status = "running"
                save_request(db, c, request)
                c.emit("tool", request.request_id, event_step_text(step))
                return PluginRetrieval(step.step_id, request.request_id, request.generation, step.call)
            if step.call.name == "mcp_tool":
                consume_approval(db, c, step)
                step.phase, step.generation = "intent", request.generation
                save_step(db, step)
                request.status = "running"
                save_request(db, c, request)
                c.emit("tool", request.request_id, event_step_text(step))
                return McpRetrieval(step.step_id, request.request_id, request.generation, step.call)
            if step.call.name in {"web_search", "web_fetch"}:
                # The call id is the step id. No epoch: the supervisor cannot prove a paid HTTP call.
                consume_approval(db, c, step)
                step.phase, step.generation = "intent", request.generation
                save_step(db, step)
                request.status = "running"
                save_request(db, c, request)
                c.emit("tool", request.request_id, event_step_text(step))
                return WebRetrieval(step.step_id, request.request_id, request.generation, step.call)
            if not run.lease:
                run.opening = True
                save_run(db, run)
                c.emit("cleanup", request.request_id, "epoch_open_intent")
                return OpenEpoch(request.request_id)
            if step.call.name == "shell" and Shell.model_validate_json(step.call.arguments).run_in_background:
                anchor = run.background_anchor or request.request_id
                used = db.execute("SELECT count(*) FROM steps WHERE json_extract(payload,'$.background_anchor')=?",
                                  (anchor,)).fetchone()[0]
                if used >= 8:
                    step.result = ToolResult(call_id=step.step_id, exit_code=1, stdout="",
                                             stderr="background_request_budget").model_dump_json()
                    step.phase = "result"
                    save_step(db, step)
                    c.emit("tool", request.request_id, event_step_text(step))
                    return Continue()
                step.background_anchor = anchor
            consume_approval(db, c, step)
            step.phase, step.generation = "intent", request.generation
            save_step(db, step)
            request.status = "running"
            save_request(db, c, request)
            c.emit("tool", request.request_id, event_step_text(step))
            return ToolInvocation(step.step_id, request.request_id, request.generation, run.lease, step.call)
        if step.kind == "model" and step.phase == "intent":
            decide_request(db, c, request, Decision(status="unknown", error="model_outcome_unknown"))
            return Continue()
    if run.lease:
        return CloseEpoch(request.request_id, run.lease)
    # A workflow parent waits for an independent verdict. It must not claim and copy session history.
    held = workflow_for_parent(db, request.request_id)
    if held is not None and not request.decision:
        return park_or_settle_workflow(db, c, request, held)
    if len([s for s in steps if s.kind == "model"]) >= 32:
        decide_request(db, c, request, Decision(status="failed", error="model_round_limit"))
        return Continue()
    for steer in list_requests(db):
        if steer.kind == "steer" and steer.parent_id == request.request_id and steer.status not in TERMINAL:
            append_message(db, c, request.request_id, "steer:" + steer.request_id, Message(
                role="user", content=steer.text, images=load_prompt_images(db, steer.request_id)))
            decide_request(db, c, steer, Decision(status="succeeded", answer="steering_applied"))
            settle_request(db, c, steer)
    ordinal = max((s.ordinal for s in steps), default=0) + 1
    if run.started_at_ms is None:
        run.started_at_ms = clock.now_ms()
        save_run(db, run)
    step_id = digest(f"{state.session_id}:{request.request_id}:model:{ordinal}")
    step = Step(step_id=step_id, request_id=request.request_id, ordinal=ordinal, kind="model",
                phase="intent", generation=request.generation)
    save_step(db, step)
    request.status = "running"
    save_request(db, c, request)
    c.emit("tool", request.request_id, event_step_text(step))
    return ModelInvocation(step_id, request.request_id, request.generation,
                           load_messages(db, request.request_id), run.config, run.started_at_ms)


def apply_observation(state: SessionContext, db: sqlite3.Connection, c: Changes, observation: Observation) -> None:
    if isinstance(observation, EpochOpened):
        run = load_run(db, observation.request_id)
        if not run.opening or run.lease:
            raise BackendError("stale_epoch_result")
        lease = observation.lease
        if (lease.session_id != state.session_id or lease.worker_id != state.instance
                or lease.build_id != state.build or not lease.supervisor_id
                or lease.execution_epoch <= int(metadata_value(db, "execution_epoch"))):
            raise BackendError("execution_lease_mismatch")
        run.lease, run.opening = observation.lease, False
        set_metadata_value(db, "execution_epoch", str(observation.lease.execution_epoch))
        run.cleanup, run.cleanup_required = None, False
        save_run(db, run)
        c.emit("cleanup", run.request_id, run.lease.model_dump_json())
        return
    if isinstance(observation, EpochClosed):
        run = load_run(db, observation.request_id)
        if run.lease != observation.lease:
            raise BackendError("stale_cleanup_result")
        proof = observation.cleanup
        if proof.session_id != state.session_id or proof.execution_epoch != observation.lease.execution_epoch:
            raise BackendError("cleanup_identity_mismatch")
        if proof.state != "clean" or not proof.proof_id:
            set_metadata_value(db, "blocked", proof.reason or "execution_cleanup_pending")
            c.emit("cleanup", run.request_id, proof.model_dump_json())
            return
        run.cleanup, run.lease, run.cleanup_required = proof, None, False
        save_run(db, run)
        for row in db.execute("SELECT payload FROM effects").fetchall():
            hold = EffectHold.model_validate_json(row[0])
            if hold.request_id == run.request_id:
                hold.resource_clean = True
                db.execute("UPDATE effects SET payload=? WHERE id=?", (hold.model_dump_json(), hold.call_id))
        c.emit("cleanup", run.request_id, proof.model_dump_json())
        return
    if isinstance(observation, EffectResolved):
        value, hold = observation.resolution, observation.hold
        if hold.call_id != value.call_id or hold.session_id != state.session_id or not hold.resource_clean or not hold.reconciled:
            raise BackendError("invalid_effect_resolution")
        row = db.execute("SELECT payload,request_id FROM resolutions WHERE id=?", (value.resolution_id,)).fetchone()
        if row is None or EffectResolution.model_validate_json(row[0]) != value or row[1] != hold.request_id:
            raise BackendError("stale_effect_resolution")
        db.execute("UPDATE resolutions SET result=? WHERE id=?", (hold.model_dump_json(), value.resolution_id))
        db.execute("UPDATE effects SET payload=? WHERE id=?", (hold.model_dump_json(), hold.call_id))
        c.emit("effect", hold.request_id, hold.model_dump_json())
        return
    if isinstance(observation, WebReturned):
        action = observation.invocation
        request = load_request(db, action.request_id)
        step = load_step(db, action.step_id)
        if (request.generation != action.generation or step.phase != "intent"
                or step.request_id != request.request_id or step.call is None
                or step.call.name not in {"web_search", "web_fetch"}):
            raise BackendError("stale_generation")
        if observation.phase == "refused":
            step.phase = "applied"
            save_step(db, step)
            decide_request(db, c, request, Decision(status="failed", error=observation.error or "web_disabled"))
            c.emit("tool", request.request_id, observation.error or "web_disabled")
            return
        if observation.phase == "unknown":
            step.phase = "unknown"
            save_step(db, step)
            decide_request(db, c, request, Decision(
                status="cancelled" if request.cancel_requested else "unknown",
                error=observation.error or "web_transport"))
            c.emit("tool", request.request_id, observation.error or "web_transport")
            return
        step.result = observation.result if observation.phase == "done" else observation.error
        step.phase = "result"
        save_step(db, step)
        c.emit("tool", request.request_id, event_step_text(step))
        return
    if isinstance(observation, CodeReturned):
        action, status = observation.invocation, observation.status
        request = load_request(db, action.request_id)
        step = load_step(db, action.step_id)
        if (request.generation != action.generation or step.request_id != request.request_id or step.phase not in {"intent", "code"}
                or step.call != action.call or status.view.run_id != action.step_id[:32]):
            raise BackendError("stale_generation")
        view = status.view
        if status.running or view.phase != "unknown" and not view.clean:
            step.phase = "code"
            step.code_poll_ms = clock.now_ms() + 1000
            save_step(db, step)
            if request.status != "waiting_children" and not request.decision:
                request.status = "waiting_children"
                save_request(db, c, request)
            return
        if view.phase == "unknown":
            step.phase = "unknown"
            save_step(db, step)
            hold = EffectHold(call_id=step.step_id, session_id=state.session_id, request_id=request.request_id,
                              reason="codemode_outcome_unknown", resource_clean=view.clean)
            db.execute("INSERT INTO effects VALUES(?,?) ON CONFLICT(id) DO NOTHING", (hold.call_id, hold.model_dump_json()))
            c.emit("effect", request.request_id, hold.model_dump_json())
            decide_request(db, c, request, Decision(status="cancelled" if request.cancel_requested else "unknown", error="codemode_outcome_unknown"))
            return
        text = ["Script completed" if view.phase == "success" else "Script " + view.phase]
        images: list[ImagePart] = []
        for part in view.output:
            if part.type == "text":
                text.append(part.text)
            else:
                images.append(ImagePart(media_type=part.mimeType, data_base64=part.data))
        if view.value and view.value != "null":
            text.append(view.value)
        if view.error:
            text.append("Script error: " + view.error)
        try:
            checked_images(images)
        except BackendError as error:
            images = []
            text.append("Script media omitted: " + error.code)
        if images:
            db.execute("INSERT INTO step_images(step_id,payload) VALUES(?,?)",
                       (step.step_id, json.dumps([image.model_dump() for image in images])))
        step.result, step.phase = "\n".join(text)[:64000], "result"
        if view.phase == "success":
            step.code_state = view.state
        save_step(db, step)
        c.emit("tool", request.request_id, event_step_text(step))
        if request.cancel_requested:
            apply_step_result(state, db, c, request, step)
            decide_request(db, c, request, Decision(status="cancelled"))
        elif not request.decision:
            request.status = "running"
            save_request(db, c, request)
        return
    if isinstance(observation, PluginReturned):
        action, view = observation.invocation, observation.view
        request = load_request(db, action.request_id)
        step = load_step(db, action.step_id)
        if (request.generation != action.generation or step.phase != "intent" or step.call != action.call
                or step.request_id != request.request_id):
            raise BackendError("stale_generation")
        args = PluginToolCall.model_validate_json(action.call.arguments)
        if view.call_id != args.call_id:
            raise BackendError("plugin_call_identity")
        if view.phase == "unknown":
            step.phase = "unknown"
            save_step(db, step)
            hold = EffectHold(call_id=step.step_id, session_id=state.session_id, request_id=request.request_id,
                              reason="plugin_outcome_unknown", resource_clean=view.clean)
            db.execute("INSERT INTO effects VALUES(?,?) ON CONFLICT(id) DO NOTHING", (hold.call_id, hold.model_dump_json()))
            c.emit("effect", request.request_id, hold.model_dump_json())
            decide_request(db, c, request, Decision(status="cancelled" if request.cancel_requested and view.clean else "unknown",
                                                 error="plugin_outcome_unknown"))
        elif view.phase in {"done", "failed"}:
            step.result, step.phase = observation.text or view.error, "result"
            if observation.images:
                checked_images(observation.images)
                db.execute("INSERT INTO step_images(step_id,payload) VALUES(?,?)",
                           (step.step_id, json.dumps([image.model_dump() for image in observation.images])))
            save_step(db, step)
            c.emit("tool", request.request_id, event_step_text(step))
        else:
            decide_request(db, c, request, Decision(status="cancelled" if view.phase == "cancelled" else "failed",
                                                 error=view.error))
        return
    if isinstance(observation, McpReturned):
        action = observation.invocation
        request = load_request(db, action.request_id)
        step = load_step(db, action.step_id)
        if (request.generation != action.generation or step.phase != "intent"
                or step.request_id != request.request_id or step.call is None or step.call.name != "mcp_tool"
                or action.call != step.call):
            raise BackendError("stale_generation")
        if observation.phase == "done":
            if observation.images:
                checked_images(observation.images)
                db.execute("INSERT INTO step_images(step_id,payload) VALUES(?,?)",
                           (step.step_id, json.dumps([image.model_dump() for image in observation.images])))
            step.result, step.phase = observation.result, "result"
            save_step(db, step)
            c.emit("tool", request.request_id, event_step_text(step))
            # A result that arrives after cancel stays in the transcript and does not start another model turn.
            if request.cancel_requested and not request.decision:
                apply_step_result(state, db, c, request, step)
                decide_request(db, c, request, Decision(status="cancelled"))
            return
        step.phase = "unknown" if observation.phase == "unknown" else "applied"
        save_step(db, step)
        if observation.phase == "unknown":
            decide_request(db, c, request, Decision(
                status="cancelled" if request.cancel_requested else "unknown",
                error=observation.error or "mcp_outcome_unknown"))
        elif observation.phase == "conflict":
            decide_request(db, c, request, Decision(status="failed", error=observation.error or "mcp_tool_identity"))
        else:
            cancelled = request.cancel_requested or observation.phase == "cancelled"
            decide_request(db, c, request, Decision(
                status="cancelled" if cancelled else "failed",
                error="" if cancelled else (observation.error or "mcp_call_denied")))
        c.emit("tool", request.request_id, observation.error or observation.phase)
        return
    if isinstance(observation, Failed):
        action = observation.action
        if isinstance(action, (CloseEpoch, OpenEpoch, QueryTool, ReconcileEffect)):
            set_metadata_value(db, "blocked", observation.error)
            c.emit("cleanup", action.request_id, observation.error)
            return
        if isinstance(action, CodeRetrieval):
            step = load_step(db, action.step_id)
            step.code_poll_ms = clock.now_ms() + 1000
            save_step(db, step)
            return
        if isinstance(action, (McpRetrieval, PluginRetrieval)):
            # The call may already exist. Leave the intent so the next advance queries it.
            return
        if isinstance(action, (ModelInvocation, ToolInvocation, WebRetrieval)):
            request = load_request(db, action.request_id)
            step = load_step(db, action.step_id)
            if request.generation != action.generation or step.request_id != request.request_id or step.phase != "intent":
                raise BackendError("stale_generation")
            if isinstance(action, ModelInvocation):
                step.phase = "unknown"
                save_step(db, step)
                decide_request(db, c, request, Decision(status="cancelled" if request.cancel_requested else "unknown",
                                                     error=observation.error))
            elif isinstance(action, WebRetrieval):
                row = db.execute("SELECT payload FROM web_calls WHERE id=?", (action.step_id,)).fetchone()
                step.phase = "unknown"
                save_step(db, step)
                if row:
                    decide_request(db, c, request, Decision(status="unknown", error=observation.error or "web_transport"))
                else:
                    decide_request(db, c, request, Decision(
                        status="cancelled" if request.cancel_requested else "failed", error=observation.error))
            # Tool failures are queried; a transport exception says nothing about effects.
            return
        raise BackendError("invalid_failed_action")
    action = observation.query if isinstance(observation, ToolObserved) else observation.invocation
    request = load_request(db, action.request_id)
    step = load_step(db, action.step_id)
    if (request.generation != action.generation or step.phase != "intent"
            or step.request_id != request.request_id):
        raise BackendError("stale_generation")
    if isinstance(observation, Previewed):
        preview = observation.preview
        if (preview.generation != request.generation or preview.run_id != request.run_id
                or preview.request_id != request.request_id or request.cancel_requested or request.decision
                or metadata_value(db, "freeze_id") or metadata_value(db, "stopping")):
            raise BackendError("stale_generation")
        row = db.execute("SELECT payload FROM previews WHERE request_id=?", (request.request_id,)).fetchone()
        if row and int(Preview.model_validate_json(row[0]).preview_seq) >= int(preview.preview_seq):
            return
        db.execute("INSERT INTO previews VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET payload=excluded.payload",
                   (request.request_id, preview.model_dump_json()))
        c.emit("preview", request.request_id, preview=preview)
        return
    if isinstance(observation, ModelReturned):
        completion = observation.completion.model_copy(update={
            "message": observation.completion.message.model_copy(update={"thinking": observation.invocation.config.thinking or "off"}),
        })
        calls = completion.message.tool_calls
        if (completion.message.role != "assistant" or len(calls) > 16
                or any(not call.id for call in calls) or len({call.id for call in calls}) != len(calls)):
            raise BackendError("invalid_tool_calls")
        step.result, step.phase = completion.model_dump_json(), "result"
        c.emit("tool", request.request_id, event_step_text(step))
    elif isinstance(observation, ToolReturned) or observation.observation.state == "completed":
        result = observation.result if isinstance(observation, ToolReturned) else observation.observation.result
        if result is None or result.call_id != step.step_id:
            raise BackendError("tool_result_identity_mismatch")
        step.result, step.phase = result.model_dump_json(), "result"
        c.emit("tool", request.request_id, event_step_text(step))
    else:
        observed = observation.observation
        if observed.call_id != step.step_id:
            raise BackendError("tool_result_identity_mismatch")
        run = load_run(db, request.request_id)
        if observed.state == "pending" and run.lease:
            run.cleanup_required = True
            save_run(db, run)
            step.query_after_cleanup = True
        elif observed.state == "pending":
            set_metadata_value(db, "blocked", "tool_pending_after_cleanup")
        else:
            step.phase = "unknown"
            if observed.state == "unknown" and step.call and step.call.name in {"shell", "write_file", "edit_file", "apply_patch"}:
                hold = EffectHold(call_id=step.step_id, session_id=state.session_id, request_id=request.request_id,
                                  reason="tool_outcome_unknown", resource_clean=observed.resource_clean)
                db.execute("INSERT INTO effects VALUES(?,?) ON CONFLICT(id) DO NOTHING", (hold.call_id, hold.model_dump_json()))
                c.emit("effect", request.request_id, hold.model_dump_json())
            if observed.state == "unknown" and not observed.resource_clean and not run.lease:
                set_metadata_value(db, "blocked", "execution_cleanup_pending")
            decide_request(db, c, request, Decision(status="cancelled" if request.cancel_requested else "unknown",
                                                 error="tool_outcome_unknown"))
        c.emit("tool", request.request_id, event_step_text(step))
    save_step(db, step)
