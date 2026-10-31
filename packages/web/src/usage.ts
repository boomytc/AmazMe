import type { RequestUsage, UsageReport } from "./generated/contracts.ts";
import type { Locale } from "./locale.ts";
import type { PanelRow, PanelSpec } from "./panels.ts";
import { translate, type MessageKey } from "./strings.ts";

export const USAGE_ACTION = "stats:open";
export const USAGE_REFRESH_ACTION = "stats:refresh";

type UsageTotals = Pick<UsageReport, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "model_calls" | "attempted_model_calls" | "priced" | "cost_micro_usd">;

const REQUEST_LABELS: Readonly<Record<RequestUsage["status"], MessageKey>> = {
	queued: "task.status.pending", running: "task.status.running", waiting_approval: "stats.waitingApproval",
	waiting_input: "stats.waitingInput", waiting_children: "task.status.waiting", waiting_time: "task.status.sleeping",
	waiting_host: "stats.waitingHost", cancelling: "task.status.completing", cleaning: "task.status.completing",
	blocked: "stats.blocked", succeeded: "task.status.completed", cancelled: "stats.cancelled",
	interrupted: "stats.interrupted", failed: "task.status.failed", unknown: "stats.unknown",
};

/** The host owns totals over the full durable session; recent rows are a bounded presentation. */
export function usagePanel(locale: Locale, report: UsageReport | undefined): PanelSpec {
	const copy = (key: Parameters<typeof translate>[1], values?: Record<string, string>) => translate(locale, key, values);
	const number = (value: number) => new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en").format(value);
	const prompt = (value: UsageTotals) => (value.input_tokens ?? 0) + (value.cache_read_tokens ?? 0) + (value.cache_write_tokens ?? 0);
	const cost = (value: UsageTotals) => value.priced && value.cost_micro_usd !== null && value.cost_micro_usd !== undefined ? `$${(value.cost_micro_usd / 1_000_000).toFixed(6)}` : "—";
	const duration = (value: number, measured: number) => measured ? `${(value / 1000).toFixed(2)} s` : "—";
	const cache = (value: UsageTotals) => prompt(value) > 0 ? `${((value.cache_read_tokens ?? 0) / prompt(value) * 100).toFixed(1)}%` : "—";
	const calls = (value: UsageTotals) => copy("stats.calls", { completed: number(value.model_calls ?? 0), attempted: number(value.attempted_model_calls ?? 0) });
	const tokens = (value: UsageTotals) => copy("stats.tokens", { input: number(prompt(value)), output: number(value.output_tokens ?? 0), cache: cache(value) });
	const title = copy("stats.title");
	if (!report) return { id: "statistics", title, notices: [], groups: [], description: copy("stats.loading") };
	const row = (id: string, title: string, value: string, description?: string): PanelRow => ({ id, title, value, description });
	return { id: "statistics", title, description: copy("stats.scope"),
		actions: [{ id: USAGE_REFRESH_ACTION, label: copy("dock.reload"), weight: "line" }],
		notices: [...((report.unmeasured_compactions ?? 0) > 0 ? [{ tone: "info" as const, text: copy("stats.unmeasuredCompactions", { count: number(report.unmeasured_compactions ?? 0) }) }] : [])],
		groups: [{ id: "stats:totals", title: copy("stats.totals"), rows: [
			row("stats:requests", copy("stats.turns"), number(report.request_count ?? 0), copy("stats.requestOutcomes", { failed: number(report.failed_requests ?? 0), cancelled: number(report.cancelled_requests ?? 0) })),
			row("stats:calls", copy("stats.modelCalls"), calls(report), copy("stats.steps", { steps: number(report.steps ?? 0), unknown: number(report.unknown_steps ?? 0), failed: number(report.failed_tool_calls ?? 0) })),
			row("stats:input", copy("stats.input"), number(prompt(report)), copy("stats.inputBreakdown", { fresh: number(report.input_tokens ?? 0), read: number(report.cache_read_tokens ?? 0), write: number(report.cache_write_tokens ?? 0) })),
			row("stats:output", copy("stats.output"), number(report.output_tokens ?? 0)),
			row("stats:cache", copy("stats.cache"), cache(report)),
			row("stats:cost", copy("stats.cost"), cost(report)),
			row("stats:context", copy("stats.context"), report.latest_context_tokens === null || report.latest_context_tokens === undefined ? "—" : number(report.latest_context_tokens)),
			row("stats:model-time", copy("stats.modelTime"), duration(report.model_ms ?? 0, report.timed_model_calls ?? 0), copy("stats.measured", { count: number(report.timed_model_calls ?? 0) })),
			row("stats:tool-time", copy("stats.toolTime"), duration(report.tool_ms ?? 0, report.timed_tool_calls ?? 0), copy("stats.measured", { count: number(report.timed_tool_calls ?? 0) })),
			row("stats:first-text", copy("stats.firstText"), duration((report.first_text_ms ?? 0) / Math.max(1, report.first_text_calls ?? 0), report.first_text_calls ?? 0), copy("stats.measured", { count: number(report.first_text_calls ?? 0) })),
			row("stats:compactions", copy("stats.compactions"), number(report.compaction_calls ?? 0)),
		] }, { id: "stats:models", title: copy("stats.models"), rows: (report.models ?? []).map(model => row(`stats:model:${model.provider}:${model.model}`, `${model.provider} · ${model.model}`, cost(model), `${calls(model)} · ${tokens(model)}`)) },
		{ id: "stats:recent", title: copy("stats.recent"), description: copy("stats.recentScope", { shown: number(report.recent?.length ?? 0), total: number(report.request_count ?? 0) }),
			rows: (report.recent ?? []).map(item => row(`stats:request:${item.request_id}`, item.text || item.request_id, `${cost(item)} · ${duration(item.model_ms ?? 0, item.timed_model_calls ?? 0)}`,
				`${copy(REQUEST_LABELS[item.status])} · ${calls(item)} · ${tokens(item)} · ${item.request_id}`)) }],
	};
}
