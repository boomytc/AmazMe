import type { Context } from "@amazme/chord";
import { copyJson } from "@amazme/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, withCancel } from "@amazme/chord/context";
import type { ToolCall } from "@amazme/ai";
import { NestedToolResultEntry } from "../entries.ts";
import type { JsonObject, Task, TaskId, TaskRuntime } from "../types.ts";
import { LiveDoc } from "./live.ts";
import type { ToolTaskCheckpoint, ToolTaskInput, ToolTaskResult } from "./tool.ts";
import type { Agent, ToolExecutionResult, ToolHooks } from "./types.ts";

export const MAX_NESTED_TOOL_CALLS = 256;
export const MAX_NESTED_TOOL_DEPTH = 8;

type Runtime = TaskRuntime<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>;
type ChildTask = Task<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>;

/** One parent invocation's queue; every call uses the ordinary ToolTask, never an inline executor. */
export function createNestedTools(options: {
	runtime: Runtime;
	task: ChildTask;
	parent: ToolCall;
	depth: number;
	agent: Agent;
	assertLive: () => void;
}) {
	const { runtime, task, parent, depth, agent, assertLive } = options;
	let sequence = 0;
	let barrier = Promise.resolve();
	const active = new Map<Promise<ToolExecutionResult>, () => void>();
	const additions = new Set<string>();

	const invoke = async (
		name: string,
		args: JsonObject,
		callId: string,
		context: Context,
	): Promise<ToolExecutionResult> => {
		assertLive();
		context.abortSignal?.throwIfAborted();
		let id: TaskId<ToolTaskResult> | undefined;
		await runtime.commit(async (tx) => {
			id = await tx.createTask(
				task,
				{
					nested: {
						parentCallId: parent.id,
						depth: depth + 1,
						call: { type: "toolCall", id: callId, name, arguments: args },
					},
				},
				{ ownership: { kind: "task", taskId: runtime.taskId } },
			);
			const live = await tx.doc(LiveDoc, runtime.conversationId);
			live.tools ??= [];
			live.tools.push({ taskId: id, parentCallId: parent.id, callId, name, status: "pending" });
			return undefined;
		}, context);
		const child = id!;
		let settled: Awaited<ReturnType<typeof runtime.waitForTask<ToolTaskResult>>>;
		try {
			settled = await runtime.waitForTask(child, context);
		} catch (error) {
			// Caller cancellation marks the actual owned task, then awaits its cleanup before this call settles.
			if (context.abortSignal?.aborted) {
				await runtime.abortTask(child, BACKGROUND_CONTEXT).catch(() => {});
				await runtime.waitForTask(child, BACKGROUND_CONTEXT).catch(() => {});
			}
			throw error;
		}
		const outcome = settled.state.outcome;
		if (!("result" in outcome) || outcome.result === undefined) throw new Error(`Nested tool ${name} has no result`);
		const entry = await runtime.entry(NestedToolResultEntry, outcome.result.entryId, context);
		if (entry?.data === undefined) throw new Error(`Nested tool ${name} result is unavailable`);
		for (const added of entry.data.result.control?.addTools ?? []) additions.add(added);
		return copyJson(entry.data.result) as ToolExecutionResult;
	};

	return {
		callTool(name: string, input: JsonObject, callerContext: Context): Promise<ToolExecutionResult> {
			assertLive();
			if (depth >= MAX_NESTED_TOOL_DEPTH)
				return Promise.reject(new Error(`Nested tool depth exceeds ${MAX_NESTED_TOOL_DEPTH}`));
			if (sequence >= MAX_NESTED_TOOL_CALLS)
				return Promise.reject(new Error(`Nested tool calls exceed ${MAX_NESTED_TOOL_CALLS}`));
			const args = copyJson(input);
			if (args === null || Array.isArray(args) || typeof args !== "object")
				return Promise.reject(new TypeError("Tool arguments must be a JSON object"));
			const callId = `${parent.id}/${++sequence}`;
			const lifetime = withCancel(withAbortSignal(runtime.signal, callerContext));
			const tool = agent.callableTools.find((candidate) => candidate.name === name);
			const sequential = runtime.settings.toolExecution === "sequential" || tool?.executionMode === "sequential";
			const prior = sequential ? Promise.allSettled([...active.keys()]).then(() => {}) : barrier;
			const operation = (async () => {
				await awaitWithContext(prior, lifetime.context);
				return invoke(name, args, callId, lifetime.context);
			})();
			active.set(operation, () => lifetime.cancel());
			// A cancelled queued call still preserves the work ahead of its barrier.
			if (sequential) barrier = Promise.allSettled([prior, operation]).then(() => {});
			void operation.then(
				() => active.delete(operation),
				() => active.delete(operation),
			);
			return operation;
		},
		addTools(): readonly string[] {
			return [...additions];
		},
		async finish(): Promise<void> {
			const pending = [...active];
			for (const [, cancel] of pending) cancel();
			await Promise.allSettled(pending.map(([operation]) => operation));
		},
	};
}
