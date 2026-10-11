import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@amazme/chord";
import { CompactionTask, defineExtension, GenerationTask, hook, LiveDoc, ToolTask, UsageDoc } from "@amazme/durable";
import type { ConversationId, Harness, HookApi } from "@amazme/durable";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { RunStateDoc } from "./state.ts";

function canonical(value: unknown): string {
	const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted)
		: item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sorted(child)])) : item;
	return JSON.stringify(sorted(value));
}
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

/** Limits pause at a safe admission boundary; an executed command is never replayed by resume. */
export function createRunPolicy(settings: SettingsManager) {
	const currentCost = async (api: HookApi, context: Context): Promise<number> => {
		const usage = await api.snapshot(UsageDoc, api.conversationId, context);
		return [usage?.models, usage?.tools].flatMap(bucket => Object.values(bucket ?? {})).reduce((total, item) => total + item.cost.total, 0);
	};
	const check = async (api: HookApi, context: Context, tool = false, reserved = false): Promise<void> => {
		await settings.reload();
		const run = String((await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs[0] ?? "");
		if (!run) return;
		const cost = await currentCost(api, context);
		await api.commit(async tx => {
			const state = await tx.doc(RunStateDoc, api.conversationId);
			if (state.run !== run) Object.assign(state, RunStateDoc.definition.initial(), { run, startedAt: Date.now(), baseCost: cost });
		}, context);
		for (;;) {
			context.abortSignal?.throwIfAborted();
			await settings.reload();
			const limits = settings.getSettings().runLimits;
			const cost = await currentCost(api, context);
			let paused = false;
			await api.commit(async tx => {
				const state = await tx.doc(RunStateDoc, api.conversationId);
				if (state.run !== run) return;
				const counted = tool && state.counted.includes(String(api.taskId));
				const timedOut = !!limits?.seconds && Date.now() - state.startedAt >= limits.seconds * 1000;
				const overCost = !!limits?.cost && cost - state.baseCost >= limits.cost;
				// A sibling's exhausted call quota cannot revoke this attempt's reservation. Recovery must still
				// honor persisted pauses, and time/cost limits always apply at the execution boundary.
				if (reserved && counted && state.paused === "calls" && !timedOut && !overCost) return;
				state.paused ??= limits?.calls && !counted && state.calls >= limits.calls ? "calls"
					: timedOut ? "seconds" : overCost ? "cost" : null;
				if (state.paused !== null) { paused = true; return; }
				if (tool && !counted) { state.counted.push(String(api.taskId)); state.calls += 1; }
			}, context);
			if (!paused) return;
			await new Promise<void>((resolve, reject) => {
				const abort = (): void => { clearTimeout(timer); reject(context.abortSignal?.reason); };
				const timer = setTimeout(() => { context.abortSignal?.removeEventListener("abort", abort); resolve(); }, 500);
				context.abortSignal?.addEventListener("abort", abort, { once: true });
			});
		}
	};
	return defineExtension({ name: "run-policy", hooks: [
		hook(GenerationTask, { beforeRequest: async (_request, api, context) => { await check(api, context); } }),
		hook(CompactionTask, { beforeModel: async (api, context) => { await check(api, context); } }),
		hook(ToolTask, {
			beforeTool: async (_call, api, context) => { await check(api, context, true); },
			beforeExecute: async (_call, api, context, attempt) => { await check(api, context, true, !attempt.recovery); },
			async afterTool(call, result, api, context) {
				if (settings.getSettings().repeatToolReminder === false || /(^|_)(wait|poll|status)(_|$)/i.test(call.name)) return;
				const key = digest({ name: call.name, arguments: call.arguments });
				const output = digest({ output: result.output ?? null, isError: result.isError ?? false });
				let repeats = 0;
				await api.commit(async tx => {
					const state = await tx.doc(RunStateDoc, api.conversationId);
					repeats = state.lastCall === key && state.lastResult === output ? state.repeats + 1 : 1;
					state.lastCall = key; state.lastResult = output; state.repeats = repeats;
				}, context);
				if (![3, 5, 8].includes(repeats)) return;
				const text = `重复调用提醒：${call.name} 已连续 ${repeats} 次使用相同参数并得到相同结果。请检查已有结果，尝试其他方法；合理轮询可继续。`;
				return { ...result, output: [...(typeof result.output === "string" ? [{ type: "text" as const, text: result.output }] : result.output ?? []), { type: "text" as const, text }], details: { ...((result.details !== null && typeof result.details === "object" && !Array.isArray(result.details) ? result.details : {}) as Record<string, JsonValue>), repeatReminder: repeats } };
			},
		}),
	] });
}

/** Grant another budget tranche to this active run without replaying completed tools. */
export async function resumeRun(harness: Harness, conversationId: ConversationId, context: Context): Promise<void> {
	const usage = await harness.snapshot(UsageDoc, conversationId, context);
	const cost = [usage?.models, usage?.tools].flatMap(bucket => Object.values(bucket ?? {})).reduce((total, item) => total + item.cost.total, 0);
	const run = String((await harness.snapshot(LiveDoc, conversationId, context))?.run?.inputs[0] ?? "");
	await harness.commit(async tx => {
		const state = await tx.doc(RunStateDoc, conversationId);
		if (state.run !== run || state.paused === null) return;
		state.paused = null; state.calls = 0; state.startedAt = Date.now(); state.baseCost = cost;
	}, context);
}
