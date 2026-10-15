import type { Context } from "@amazme/chord";
import { AssistantEntry, defineTask } from "@amazme/durable";
import type { ConversationId, SubmissionId, TaskId, TaskRuntime } from "@amazme/durable";

/** Persistent attribution, independent of the lifetime of any one delegation call. */
export const SubagentOwner = defineTask<{ creator: TaskId }, { phase: "done" }, null>({
	name: "amazme.subagent.owner",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

type Input = { conversationId: ConversationId; requestId: string; task: string };
type State = { phase: "deliver" };
export type SubagentResult = { conversationId: ConversationId; text: string };
type Runtime = TaskRuntime<Input, State, SubagentResult, object>;

/** Lookup only: cancellation must never submit work that was not already admitted. */
async function cancelInput(input: Input, runtime: Runtime, context: Context): Promise<void> {
	let submissionId: SubmissionId | undefined;
	await runtime.commit(async tx => {
		submissionId = (await tx.submissionByRequest(input.conversationId, input.requestId))?.id;
		return undefined;
	}, context);
	if (submissionId === undefined) return;
	const child = await runtime.conversation(input.conversationId, context);
	if (child === undefined) throw new Error(`Subagent ${input.conversationId} is unavailable during cancellation`);
	await child.cancelPrompt(submissionId, context);
}

/** One foreground call supervises exactly one durable input, including when it resumes an existing child. */
export const SubagentRun = defineTask<Input, State, SubagentResult>({
	name: "amazme.subagent.run",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, context) => {
			const input = task.input;
			try {
				const child = await runtime.conversation(input.conversationId, context);
				if (child === undefined) throw new Error(`Subagent ${input.conversationId} is unavailable`);
				const submission = await child.submit({
					type: "input", content: input.task, requestId: input.requestId, whenBusy: "reject",
				}, context);
				const settled = await submission.wait(context);
				if (settled.status !== "done" || settled.type !== "input")
					throw new Error(`Subagent ${input.conversationId} ended without an answer: ${settled.status}`);
				await runtime.commit(async tx => {
					const entry = await tx.entry(AssistantEntry, settled.answer);
					const message = entry?.model?.[0];
					if (message?.role !== "assistant") throw new Error(`Subagent ${input.conversationId} answer is unavailable`);
					if (message.stopReason !== "stop" && (message.stopReason !== "toolUse" || message.content.some(part => part.type === "toolCall")))
						throw new Error(`Subagent ${input.conversationId} failed: ${message.errorMessage ?? message.stopReason}`);
					const text = message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
					return { status: "terminal", outcome: { status: "completed", result: { conversationId: input.conversationId, text } } };
				}, context);
			} catch (error) {
				// A fresh abort invocation performs cleanup; host shutdown instead leaves the durable task resumable.
				if (runtime.signal.aborted) throw error;
				await cancelInput(input, runtime, context);
				await runtime.commit(() => ({
					status: "terminal", outcome: { status: "failed", error: { message: error instanceof Error ? error.message : String(error) } },
				}), context);
			}
		},
	},
	abort: async (task, runtime, context) => {
		await cancelInput(task.input, runtime, context);
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});
