"""Private session requests operations; the caller owns the transaction."""
from __future__ import annotations

import json
import sqlite3
from typing import Literal

from amazme_backend.contracts.mcp import McpToolCall, mcp_alias
from amazme_backend.contracts.models import Message, ToolCall
from amazme_backend.contracts.plugins import PluginToolCall, plugin_alias
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.sessions import (
    Approval,
    Decision,
    DelegateTasks,
    Preview,
    Receipt,
    Submit,
)
from amazme_backend.features.management.rules import contains_secret
from amazme_backend.profiles.configuration import selected_provider
from amazme_backend.sessions.domain import normalized_call, resolve_model_call
from amazme_backend.sessions.persistence import clock
from amazme_backend.sessions.persistence.records import (
    Changes,
    append_message,
    expire_approvals,
    list_requests,
    load_message_payloads,
    load_messages,
    load_prompt_images,
    load_request,
    load_run,
    load_step_images,
    mark_workflow_cancelled,
    match_compaction,
    pending_request_ids,
    save_prompt_images,
    save_request,
    save_run,
    save_step,
)
from amazme_backend.sessions.persistence.state import SessionContext
from amazme_backend.sessions.policy.limits import (
    PENDING_LIMIT,
    TERMINAL,
)
from amazme_backend.sessions.policy.projection import (
    digest,
)
from amazme_backend.sessions.types import (
    Completion,
    Run,
    Step,
)
from amazme_backend.shared.errors import BackendError


def create_request(state: SessionContext, db: sqlite3.Connection, c: Changes, value: Submit, *, parent_id: str = "",
                 depth: int = 0, inherited: ProviderConfig | None = None, accepted_config: ProviderConfig | None = None,
                 input_origin: Literal["user", "job"] | None = None, background_anchor: str = "") -> Receipt:
    parent_run = load_run(db, parent_id) if parent_id else None
    origin = input_origin or (parent_run.input_origin if parent_run else "user")
    anchor = background_anchor or (parent_run.background_anchor if parent_run else value.request_id)
    receipt = Receipt(request_id=value.request_id, run_id=value.request_id, text=value.text,
                      status="waiting_time" if value.not_before_ms > clock.now_ms() else "queued",
                      parent_id=parent_id, kind="child" if parent_id else "root",
                      accepted_revision=str(c.seq), revision=str(c.seq), not_before_ms=value.not_before_ms,
                      image_count=len(value.images), input_origin=origin)
    db.execute("INSERT INTO requests(id,digest,payload) VALUES(?,?,?)",
               (value.request_id, digest(value.model_dump_json()), receipt.model_dump_json()))
    save_prompt_images(db, value.request_id, value.images)
    # Store public provider configuration only. Credentials remain in Profile.
    config = selected_provider(inherited or accepted_config or state.config, value.model_selection, catalog=state.catalog)
    if inherited is None or value.time_zone:
        config.time_zone = value.time_zone
    if value.approval_policy is not None:
        config.approval_policy = value.approval_policy
    if value.thinking is not None:
        config.thinking = value.thinking
    if value.system_prompt is not None:
        config.system_prompt = value.system_prompt
    if value.append_system_prompt:
        config.append_system_prompt = "\n\n".join(filter(None, [config.append_system_prompt, value.append_system_prompt]))
    if len(config.append_system_prompt) > 32000:
        raise BackendError("system_prompt_limit")
    if value.allowed_tools is not None:
        config.allowed_tools = value.allowed_tools
    config.excluded_tools = list(dict.fromkeys([*config.excluded_tools, *value.excluded_tools]))
    expanded_text: str | None = None
    if inherited is None and state.expand_resources is not None and value.tool_call is None:
        config.resource_options = value.resource_options
        expanded_text, system_context = state.expand_resources(value.text, value.resource_options)
        if len(expanded_text) > 64000:
            raise BackendError("resource_input_limit")
        config.append_system_prompt = "\n\n".join(filter(None, [config.append_system_prompt, system_context]))
        if len(config.append_system_prompt) > 32000:
            raise BackendError("system_prompt_limit")
        known_secrets = tuple(state.secrets())
        if contains_secret(config.append_system_prompt + "\n" + expanded_text, known_secrets):
            raise BackendError("resource_secret")
    direct = normalized_call(value.tool_call) if value.tool_call is not None else None
    if direct is not None:
        selected = direct.name
        step_id = digest(f"direct:{state.session_id}:{value.request_id}")
        if direct.name == "plugin_tool":
            args = PluginToolCall.model_validate_json(direct.arguments).model_copy(update={"call_id":step_id[:32]})
            selected = plugin_alias(args.plugin_id,args.name)
            direct = direct.model_copy(update={"arguments":args.model_dump_json()})
        elif direct.name == "mcp_tool":
            args_mcp = McpToolCall.model_validate_json(direct.arguments).model_copy(update={"call_id":step_id[:32]})
            selected = mcp_alias(args_mcp.server_id,args_mcp.tool)
            direct = direct.model_copy(update={"arguments":args_mcp.model_dump_json()})
        if not config.tool_allowed(selected):
            raise BackendError("tool_not_allowed")
    save_run(db, Run(request_id=value.request_id, config=config, depth=depth, direct_call=direct, input_text=expanded_text,
                     input_origin=origin, background_anchor=anchor))
    c.emit("accepted", receipt.request_id, receipt.text, receipt=receipt.model_copy(deep=True))
    c.hit("accepted", receipt.request_id)
    return receipt


def cancel_request_tree(db: sqlite3.Connection, c: Changes, request_id: str) -> None:
    descendants = {request_id}
    all_requests = list_requests(db)
    for _ in range(6):
        descendants.update(r.request_id for r in all_requests if r.parent_id in descendants)
    for r in all_requests:
        if r.request_id not in descendants or r.status in TERMINAL or r.decision or r.cancel_requested:
            continue
        r.cancel_requested = True
        expire_approvals(db, c, r.request_id)
        if r.status in {"queued", "waiting_time"} or r.kind == "steer":
            decide_request(db, c, r, Decision(status="cancelled"))
            settle_request(db, c, r)
        else:
            r.status = "cancelling"
            save_request(db, c, r)
    mark_workflow_cancelled(db, request_id)


def approval_binding(state: SessionContext, db: sqlite3.Connection, request_id: str, call: ToolCall) -> str:
    pending_steer = [r.model_dump_json() for r in list_requests(db)
                     if r.kind == "steer" and r.parent_id == request_id and r.status not in TERMINAL]
    context = [m.model_dump_json() for m in load_messages(db, request_id)]
    arguments: object = json.loads(normalized_call(call).arguments)
    return digest(json.dumps({"call": call.name, "arguments": arguments, "context": context,
                              "steer": pending_steer, "policy": load_run(db, request_id).config.approval_policy or state.approval_policy, "build": state.build,
                              "run": request_id}, sort_keys=True, ensure_ascii=False))


def decide_request(db: sqlite3.Connection, c: Changes, request: Receipt, decision: Decision) -> None:
    if request.decision:
        return
    request.decision, request.status = decision, "cleaning"
    request.answer, request.error = decision.answer, decision.error
    expire_approvals(db, c, request.request_id)
    db.execute("DELETE FROM previews WHERE request_id=?", (request.request_id,))
    save_request(db, c, request)
    c.hit("decision", request.request_id)
    if decision.status != "succeeded":
        for child in list_requests(db):
            if child.parent_id == request.request_id and child.kind == "child" and child.status not in TERMINAL:
                cancel_request_tree(db, c, child.request_id)
    for r in list_requests(db):
        if r.parent_id == request.request_id and r.kind == "steer" and r.status not in TERMINAL:
            decide_request(db, c, r, Decision(status="interrupted", error="target_settled"))
            settle_request(db, c, r)


def settle_request(db: sqlite3.Connection, c: Changes, request: Receipt) -> None:
    assert request.decision is not None
    if request.kind != "steer":
        run = load_run(db, request.request_id)
        if run.lease or run.opening or any(
            r.parent_id == request.request_id and r.kind == "child" and r.status not in TERMINAL
            for r in list_requests(db)
        ):
            raise BackendError("settlement_pending")
    request.status = request.decision.status
    save_request(db, c, request)


def claim_request(state: SessionContext, db: sqlite3.Connection, c: Changes, request: Receipt) -> None:
    if request.kind == "root":
        previous = db.execute("SELECT id FROM requests WHERE kind='root' AND status='succeeded' ORDER BY ordinal DESC LIMIT 1").fetchone()
        if previous:
            payloads = load_message_payloads(db, str(previous[0]))
            matched = match_compaction(db, payloads)
            if matched is None:
                history = payloads
            else:
                append_message(db, c, request.request_id, "compaction",
                              Message(role="user", content=matched.summary))
                history = payloads[matched.message_count:]
            for index, payload in enumerate(history):
                append_message(db, c, request.request_id, f"history:{index}", Message.model_validate_json(payload))
    run = load_run(db, request.request_id)
    append_message(db, c, request.request_id, "input", Message(
        role="user", content=run.input_text if run.input_text is not None else request.text, images=load_prompt_images(db, request.request_id)))
    request.status = "running"
    request.generation += 1
    save_request(db, c, request)
    run = load_run(db, request.request_id)
    if run.direct_call is not None:
        call = run.direct_call
        step_id = digest(f"direct:{state.session_id}:{request.request_id}")
        append_message(db, c, request.request_id, "direct-call", Message(role="assistant", content="", tool_calls=[call]))
        save_step(db, Step(step_id=step_id, request_id=request.request_id, ordinal=1,
            kind="tool",phase="proposed",generation=request.generation,call=call))
    c.hit("claimed", request.request_id)


def grant_step(state: SessionContext, db: sqlite3.Connection, c: Changes, request: Receipt, step: Step) -> bool:
    assert step.call is not None
    binding = approval_binding(state, db, request.request_id, step.call)
    policy = load_run(db, request.request_id).config.approval_policy or state.approval_policy
    required = policy == "all" or (
        policy == "mutations" and step.call.name in {"shell", "write_file", "edit_file", "job_kill", "mcp_tool", "plugin_tool"})
    if not required:
        return True
    approval: Approval | None = None
    if step.approval_id:
        row = db.execute("SELECT payload FROM approvals WHERE id=?", (step.approval_id,)).fetchone()
        approval = Approval.model_validate_json(row[0]) if row else None
    if approval and (approval.proposal_digest != binding or approval.build_id != state.build):
        expire_approvals(db, c, request.request_id)
        approval = None
    if approval and approval.state == "denied":
        decide_request(db, c, request, Decision(status="failed", error="approval_denied"))
        return False
    if approval and approval.state in {"approved", "consumed"}:
        # Consume in the same transaction that creates an execution/delegation intent.
        return True
    if approval is None or approval.state == "expired":
        approval = Approval(approval_id=digest(step.step_id + binding + str(c.seq)), request_id=request.request_id,
                            run_id=request.run_id, call_id=step.step_id, call=step.call, build_id=state.build,
                            proposal_digest=binding, revision=str(c.seq), state="pending")
        step.approval_id, step.proposal_digest = approval.approval_id, binding
        save_step(db, step)
        db.execute("INSERT INTO approvals VALUES(?,?,?)", (approval.approval_id, request.request_id, approval.model_dump_json()))
        c.emit("approval", request.request_id, "pending", approval=approval)
        c.hit("approval", request.request_id, step.step_id)
    if request.status != "waiting_approval":
        request.status = "waiting_approval"
        save_request(db, c, request)
    return False


def consume_approval(db: sqlite3.Connection, c: Changes, step: Step) -> None:
    if step.approval_id:
        approval = Approval.model_validate_json(db.execute("SELECT payload FROM approvals WHERE id=?", (step.approval_id,)).fetchone()[0])
        approval.state = "consumed"
        db.execute("UPDATE approvals SET payload=? WHERE id=?", (approval.model_dump_json(), approval.approval_id))
        c.emit("approval", step.request_id, "consumed", approval=approval)


def apply_step_result(state: SessionContext, db: sqlite3.Connection, c: Changes, request: Receipt, step: Step) -> None:
    if step.kind == "model":
        completion = Completion.model_validate_json(step.result)
        message = completion.message
        message.provider_response_id = completion.response_id
        options = load_run(db, request.request_id).config
        if any(not options.tool_allowed(call.name) for call in message.tool_calls):
            raise BackendError("tool_not_allowed")
        append_message(db, c, request.request_id, step.step_id, message)
        previous = db.execute("SELECT payload FROM previews WHERE request_id=?", (request.request_id,)).fetchone()
        if previous:
            c.events[-1].preview = Preview.model_validate_json(previous[0])
            db.execute("DELETE FROM previews WHERE request_id=?", (request.request_id,))
        if not message.tool_calls:
            if not any(r.kind == "steer" and r.parent_id == request.request_id and r.status not in TERMINAL
                       for r in list_requests(db)):
                decide_request(db, c, request, Decision(status="succeeded", answer=message.content))
        else:
            for i, call in enumerate(message.tool_calls):
                tool_id = digest(f"{state.session_id}:{step.step_id}:{i}:{call.id}")
                # The call id is the step id's prefix and is stored before approval or any send.
                call = resolve_model_call(step.mcp_catalog, call, tool_id[:32], step.plugin_catalog)
                save_step(db, Step(step_id=tool_id, request_id=request.request_id,
                                        ordinal=step.ordinal + i + 1, kind="tool", phase="proposed",
                                        generation=request.generation, call=call,
                                        search_catalog=step.search_catalog if call.name == "tool_search" else ""))
    else:
        assert step.call is not None
        append_message(db, c, request.request_id, step.step_id,
                      Message(role="tool", content=step.result, tool_call_id=step.call.id,
                              images=load_step_images(db, step.step_id)
                              if step.call.name in {"plugin_tool", "codemode", "mcp_tool"} else []))
        if load_run(db, request.request_id).direct_call is not None:
            decide_request(db, c, request, Decision(status="succeeded", answer=step.result))
    step.phase = "applied"
    save_step(db, step)


def delegate_children(state: SessionContext, db: sqlite3.Connection, c: Changes, request: Receipt, step: Step) -> None:
    assert step.call is not None
    tasks = DelegateTasks.model_validate_json(step.call.arguments)
    run = load_run(db, request.request_id)
    current = [r for r in list_requests(db) if r.parent_id == request.request_id and r.kind == "child"]
    if (run.depth >= 4 or len(current) + len(tasks.tasks) > 8
            or len(pending_request_ids(db)) + len(tasks.tasks) > PENDING_LIMIT):
        raise BackendError("child_capacity")
    for i, text in enumerate(tasks.tasks):
        child_id = digest(f"{step.step_id}:child:{i}")
        child = create_request(state, db, c, Submit(request_id=child_id, text=text),
                                  parent_id=request.request_id, depth=run.depth + 1, inherited=run.config)
        step.children.append(child.request_id)
        request.children.append(child.request_id)
    consume_approval(db, c, step)
    step.phase = "children"
    save_step(db, step)
    request.status = "waiting_children"
    save_request(db, c, request, "children")


def join_children(db: sqlite3.Connection, c: Changes, request: Receipt, step: Step) -> bool:
    children = [load_request(db, key) for key in step.children]
    failures = [r for r in children if r.status in TERMINAL and r.status != "succeeded"]
    if failures:
        for child in children:
            if child.status not in TERMINAL:
                cancel_request_tree(db, c, child.request_id)
    if any(r.status not in TERMINAL for r in children):
        return False
    step.result = json.dumps([{"request_id": r.request_id, "status": r.status,
                               "answer": r.answer[:8000], "error": r.error} for r in children], ensure_ascii=False)
    step.phase = "result"
    save_step(db, step)
    c.emit("children", request.request_id, step.result)
    c.hit("child_join", request.request_id, step.step_id)
    request.status = "running"
    save_request(db, c, request)
    if failures:
        decide_request(db, c, request, Decision(status="unknown" if any(r.status == "unknown" for r in failures) else "failed",
                                             error="required_child_failed"))
    return True
