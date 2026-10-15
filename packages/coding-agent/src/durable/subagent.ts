import type { Context, JsonValue } from "@amazme/chord";
import { StringEnum, Type } from "@amazme/ai";
import { AssistantEntry, configure, defineExtension, defineTool, InboxDoc, LiveDoc, ToolTask } from "@amazme/durable";
import type { ConversationId, Cursor, Extension, TaskId, ToolExecutionApi, ToolTaskInput, Tx } from "@amazme/durable";
import { parseConversationId } from "./fork-management.ts";
import { SubagentOwner, SubagentRun } from "./subagent-run.ts";
import type { SubagentResult } from "./subagent-run.ts";

const PAGE_SIZE = 50;

/** A child directory comes from immutable ownership facts, never a second registry. */
async function ownedChild(tx: Tx, parent: ConversationId, id: ConversationId): Promise<boolean> {
	const child = await tx.conversation(id);
	if (child?.owner?.conversationId !== parent) return false;
	return (await tx.task(child.owner.taskId))?.kind === SubagentOwner.definition.name;
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function childLabel(tx: Tx, ownerId: TaskId): Promise<string> {
	const owner = await tx.task(ownerId);
	const ownerInput = owner?.input;
	const creatorId = isObject(ownerInput) ? ownerInput.creator : undefined;
	const creator = typeof creatorId === "number" ? await tx.task(creatorId as TaskId) : undefined;
	if (creator?.kind !== ToolTask.definition.name) return "task unavailable";
	const input = creator.input as ToolTaskInput;
	const message = input.kind === "model" ? (await tx.entry(AssistantEntry, input.assistant))?.model?.[0] : undefined;
	const call = input.kind === "nested" ? input.call : message?.role === "assistant"
		? message.content.find(part => part.type === "toolCall" && part.id === input.callId) : undefined;
	const task = call?.type === "toolCall" ? call.arguments.task : undefined;
	return typeof task === "string" ? task.replace(/\s+/g, " ").trim().slice(0, 160) : "task unavailable";
}

async function listChildren(api: ToolExecutionApi, before: ConversationId | undefined, context: Context): Promise<string> {
	return api.commit(async tx => {
		const lines: string[] = [];
		let cursor: Cursor | undefined;
		let last: ConversationId | undefined;
		do {
			const page = await tx.scanConversations({ ownerConversationId: api.conversationId, order: "descending" }, PAGE_SIZE, cursor);
			for (const child of page.items) {
				if (before !== undefined && child.id >= before) continue;
				if (!await ownedChild(tx, api.conversationId, child.id)) continue;
				if (lines.length === PAGE_SIZE)
					return `${lines.join("\n")}\nMore subagents: list with beforeConversationId "${last}".`;
				const busy = (await tx.doc(LiveDoc, child.id)).run !== undefined;
				const queued = (await tx.doc(InboxDoc, child.id)).items.some(item => item.mode !== "write");
				lines.push(`${child.id}: ${busy || queued ? "busy" : "idle"} | ${await childLabel(tx, child.owner!.taskId)}`);
				last = child.id;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return lines.length === 0 ? "No subagents." : lines.join("\n");
	}, context);
}

/** Replays find the original supervisor before admitting a new child or input. */
async function startRun(api: ToolExecutionApi, task: string, selected: ConversationId | undefined, context: Context): Promise<TaskId<SubagentResult>> {
	return api.commit(async tx => {
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanTasks({ conversationId: api.conversationId, kind: SubagentRun.definition.name, order: "descending" }, 50, cursor);
			const existing = page.items.find(record => record.id > api.taskId && record.owner === api.taskId);
			if (existing !== undefined) return existing.id as TaskId<SubagentResult>;
			// Session IDs increase monotonically: this call's supervisor cannot predate the call itself.
			if (page.items.some(record => record.id <= api.taskId)) break;
			cursor = page.next;
		} while (cursor !== undefined);
		let child = selected;
		if (child !== undefined) {
			if (!await ownedChild(tx, api.conversationId, child)) throw new Error("Subagent does not belong to this conversation");
			if ((await tx.doc(LiveDoc, child)).run !== undefined || (await tx.doc(InboxDoc, child)).items.length > 0)
				throw new Error(`Subagent ${child} is busy; wait for its current input to finish`);
		} else {
			// Persistent attribution is independent of this call, so cancellation cannot withdraw a later human input.
			const owner = await tx.createTask(SubagentOwner, { creator: api.taskId }, { ownership: { kind: "conversation" } });
			child = (await tx.createConversation({ ownership: { kind: "task", taskId: owner } })).id;
			await configure(tx, child, { extensions: { remove: [Subagent] } });
		}
		return tx.createTask(SubagentRun, { conversationId: child, task, requestId: `subagent:${api.taskId}` },
			{ ownership: { kind: "task", taskId: api.taskId } });
	}, context);
}

/** Foreground delegation and sequential continuation over the same persisted child conversation. */
export const Subagent: Extension = defineExtension({
	name: "subagent",
	tasks: [SubagentOwner, SubagentRun],
	tools: [defineTool({
		name: "subagent",
		description: "Run a self-contained task in a subagent and wait for its answer, or list this conversation's subagents. " +
			"For action run, supply task; omit conversationId to start a fresh child, or reuse an idle child's ID to continue its history. " +
			"A fresh child has the same tools but no parent conversation history and cannot delegate. Cancelling this call stops the run carrying its input; later queued inputs remain. " +
			"Action list returns child IDs, busy/idle status and original task labels; beforeConversationId reads the next page.",
		// Provider tool schemas require an object root; action-specific rules are checked before any side effect.
		parameters: Type.Object({
			action: StringEnum(["run", "list"]),
			task: Type.Optional(Type.String({ minLength: 1, description: "Required for run; the complete task or follow-up. Not accepted by list." })),
			conversationId: Type.Optional(Type.String({ description: "For run only: an idle child ID returned by run or list" })),
			beforeConversationId: Type.Optional(Type.String({ description: "For list only: read IDs below this continuation cursor" })),
		}, { additionalProperties: false }),
		replay: "safe",
		execute: async (args, api, context) => {
			if (args.action === "list") {
				if (args.task !== undefined || args.conversationId !== undefined) throw new Error("list does not accept task or conversationId");
				return { output: [{ type: "text", text: await listChildren(api,
					args.beforeConversationId === undefined ? undefined : parseConversationId(args.beforeConversationId), context) }] };
			}
			if (args.task === undefined || args.task.trim().length === 0 || args.beforeConversationId !== undefined)
				throw new Error("run requires a non-empty task and does not accept beforeConversationId");
			const id = await startRun(api, args.task,
				args.conversationId === undefined ? undefined : parseConversationId(args.conversationId), context);
			const record = await api.getTask(id, context);
			const input = record?.input;
			if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input?.conversationId !== "number")
				throw new Error("Subagent supervisor is unavailable");
			await api.details({ conversationId: input.conversationId }, context);
			const outcome = (await api.waitForTask(id, context)).state.outcome;
			if (outcome.status !== "completed") throw new Error(outcome.error?.message ?? `Subagent ended ${outcome.status}`);
			const { conversationId, text } = outcome.result;
			return { output: [{ type: "text", text: `Subagent ${conversationId}\n${text}` }], details: { conversationId } };
		},
	})],
});
