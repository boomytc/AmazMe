import { defineTask, NestedResultDoc, ToolTask } from "@amazme/durable";
import type { JsonObject, TaskId, ToolTaskResult } from "@amazme/durable";

type Input = { callId: string; name: string; args: JsonObject };
type State = { phase: "call" } | { phase: "wait"; child: TaskId<ToolTaskResult> };
type Result = { isError: boolean; error: string };

/** The host owns this command; its actual tool call still uses the ordinary ToolTask pipeline. */
export const Command = defineTask<Input, State, Result, object>({
	name: "amazme.workflow.command",
	version: 1,
	initial: () => ({ phase: "call" }),
	phases: {
		async call(task, runtime, context) {
			await runtime.commit(async (tx) => {
				const child = await tx.createTask(
					ToolTask,
					{
						kind: "nested",
						parent: runtime.taskId,
						parentCallId: task.input.callId,
						key: "command",
						call: {
							type: "toolCall",
							id: `${task.input.callId}/command`,
							name: task.input.name,
							arguments: task.input.args,
						},
					},
					{ ownership: { kind: "task", taskId: runtime.taskId } },
				);
				return { status: "running", checkpoint: { phase: "wait", child } };
			}, context);
		},
		async wait(task, runtime, context) {
			const settled = await runtime.waitForTask(task.state.checkpoint.child, context);
			const result = (
				await runtime.snapshot(NestedResultDoc, runtime.taskId, String(task.state.checkpoint.child), context)
			)?.result;
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: {
						status: "completed",
						result: {
							isError: result?.isError ?? true,
							error: (
								result?.diagnostics.map((item) => item.message).join("\n") ??
								settled.state.outcome.error?.message ??
								"Workflow command result is unavailable"
							).slice(0, 2000),
						},
					},
				}),
				context,
			);
		},
	},
	async abort(_task, runtime, context) {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});
