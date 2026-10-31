"""Whole-session accounting from durable calls, independent of the client's event window."""
from collections.abc import Mapping

from pydantic import ValidationError

from amazme_backend.ai.usage import call_usage
from amazme_backend.contracts.execution import ToolResult
from amazme_backend.contracts.models import ModelCallUsage
from amazme_backend.contracts.sessions import (
    Compaction,
    ModelUsage,
    Receipt,
    RequestUsage,
    UsageReport,
    UsageTotals,
)
from amazme_backend.sessions.types import Completion, Run, Step


def _elapsed(start: int | None, end: int | None) -> int | None:
    return end - start if start is not None and end is not None and end >= start else None


def _add_call(total: UsageTotals, value: ModelCallUsage) -> None:
    total.model_calls += 1
    total.input_tokens += value.input_tokens
    total.output_tokens += value.output_tokens
    total.cache_read_tokens += value.cache_read_tokens
    total.cache_write_tokens += value.cache_write_tokens
    if value.cost_micro_usd is None:
        total.unpriced_calls += 1
        total.cost_micro_usd = None
    else:
        total.priced_calls += 1
        if not total.unpriced_calls:
            total.cost_micro_usd = (total.cost_micro_usd or 0) + value.cost_micro_usd
    total.priced = total.unpriced_calls == 0
    elapsed = _elapsed(value.started_at_ms, value.finished_at_ms)
    if elapsed is not None:
        total.model_ms += elapsed
        total.timed_model_calls += 1
    first_text = _elapsed(value.started_at_ms, value.first_text_at_ms)
    if first_text is not None and elapsed is not None and first_text <= elapsed:
        total.first_text_ms += first_text
        total.first_text_calls += 1


def summarize_usage(session: str, requests: list[Receipt], runs: Mapping[str, Run], steps: list[Step],
                    compactions: list[Compaction]) -> UsageReport:
    report = UsageReport(session_id=session, priced=True, cost_micro_usd=0)
    roots: dict[str, str] = {}
    turns: dict[str, RequestUsage] = {}
    models: dict[tuple[str, str], ModelUsage] = {}
    for request in requests:
        roots[request.request_id] = roots.get(request.parent_id, request.request_id)
        if request.kind == "root":
            turns[request.request_id] = RequestUsage(request_id=request.request_id, text=request.text[:180],
                                                    status=request.status, priced=True, cost_micro_usd=0)
            report.request_count += 1
            report.failed_requests += request.status in {"failed", "interrupted", "unknown"}
            report.cancelled_requests += request.status == "cancelled"
    root_order = {key: index for index, key in enumerate(turns)}
    latest = (-1, -1)

    def targets(request: str, provider: str, model: str) -> list[UsageTotals]:
        key = (provider, model)
        if key not in models:
            models[key] = ModelUsage(provider=provider, model=model, priced=True, cost_micro_usd=0)
        turn = turns.get(roots.get(request, request))
        return [report, models[key], *([turn] if turn is not None else [])]

    for step in steps:
        run = runs[step.request_id]
        totals = targets(step.request_id, run.config.provider, run.config.model)
        for total in totals:
            total.steps += 1
            total.unknown_steps += step.phase == "unknown"
            total.attempted_model_calls += step.kind == "model"
        if step.kind == "model":
            if step.phase not in {"result", "applied"} or not step.result:
                continue
            completion = Completion.model_validate_json(step.result)
            usage = call_usage(step.step_id, run.config.provider, run.config.model, completion,
                               started_at_ms=step.started_at_ms, first_text_at_ms=step.first_text_at_ms,
                               finished_at_ms=step.finished_at_ms)
            for total in totals:
                _add_call(total, usage)
                total.reasoning_signatures += bool(completion.message.reasoning_signature)
            # Delegates have their own contexts. They never replace the main conversation's latest input.
            if step.request_id in turns:
                order = (root_order[step.request_id], step.ordinal)
                if order > latest:
                    latest = order
                    report.latest_context_tokens = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens
        else:
            elapsed = _elapsed(step.started_at_ms, step.finished_at_ms)
            failed = False
            if step.result:
                try:
                    failed = ToolResult.model_validate_json(step.result).exit_code != 0
                except ValidationError:
                    pass  # MCP, plugins and delegates can return their own non-native payloads.
            for total in totals:
                total.failed_tool_calls += failed
                if elapsed is not None:
                    total.tool_ms += elapsed
                    total.timed_tool_calls += 1

    seen: set[str | tuple[str, str]] = set()
    unmeasured_turns: set[str] = set()
    for compaction in compactions:
        key = compaction.usage.call_id if compaction.usage else (compaction.basis, compaction.instructions)
        if key in seen:
            continue
        seen.add(key)
        if compaction.usage is None:
            report.unmeasured_compactions += 1
            unmeasured_turns.add(roots.get(compaction.through_request_id, compaction.through_request_id))
            continue
        report.compaction_calls += 1
        usage = compaction.usage
        for total in targets(compaction.through_request_id, usage.provider, usage.model):
            total.steps += 1
            total.attempted_model_calls += 1
            _add_call(total, usage)
    if report.unmeasured_compactions:
        report.priced, report.cost_micro_usd = False, None
    for key in unmeasured_turns:
        if key in turns:
            turns[key].priced, turns[key].cost_micro_usd = False, None
    report.models = sorted(models.values(), key=lambda item: (item.provider, item.model))
    report.recent = list(reversed(list(turns.values())))[:100]
    return report
