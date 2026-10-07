import type { Context } from "@amazme/chord";
import { TODO_CONTEXT } from "@amazme/chord/context";
import {
	type AgentState,
	type Conversation,
	type ConversationId,
	type ConversationRecord,
	type ConversationView,
	type Cursor,
	defineDoc,
	type EntryId,
	type EntryRecord,
	type Harness,
	type LiveState,
} from "@amazme/durable";
import type { ConversationRole, ConversationSummary, HistoryPage, LaneStatus } from "./services/conversations.ts";

/** How many conversations or entries one scan page holds. Callers loop until the scan is exhausted. */
const SCAN_PAGE = 256;

/**
 * The conversation the session is showing. A session document, so a reload of the same sqlite file
 * restores the fork or subagent the reader had open. This is the durable document API, not a second store.
 */
export const FocusDoc = defineDoc<{ conversationId: string }>({
	kind: "amazme.session.focus",
	version: 1,
	scope: "session",
	initial: () => ({ conversationId: "" }),
});

/** The text of a user entry as a one-line label. */
export function labelOf(entry: EntryRecord | undefined): string | undefined {
	const message = entry?.model?.[0];
	if (message?.role !== "user") return undefined;
	const text =
		typeof message.content === "string" ? message.content : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function roleOf(id: string, rootId: string, record: { parent?: unknown; owner?: unknown }): ConversationRole {
	if (id === rootId) return "main";
	if (record.owner !== undefined) return "subagent";
	return "fork";
}

/** Every conversation of the session, with fork and subagent edges and a tree depth. */
export async function readSummaries(harness: Harness, rootId: string): Promise<ConversationSummary[]> {
	const records: ConversationRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit((tx) => tx.scanConversations({}, SCAN_PAGE, cursor), TODO_CONTEXT);
		records.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);

	const children = new Map<string, number>();
	const byId = new Map<string, ConversationRecord>();
	for (const record of records) {
		const id = String(record.id);
		byId.set(id, record);
		const parent = record.parent === undefined ? undefined : String(record.parent.conversationId);
		const owner = record.owner === undefined ? undefined : String(record.owner.conversationId);
		const from = parent ?? owner;
		if (from === undefined) continue;
		children.set(from, (children.get(from) ?? 0) + 1);
	}

	const depthOf = (id: string, seen: ReadonlySet<string> = new Set()): number => {
		if (seen.has(id)) return 0;
		const record = byId.get(id);
		const parent =
			record?.parent === undefined ? (record?.owner === undefined ? undefined : String(record.owner.conversationId)) : String(record.parent.conversationId);
		if (parent === undefined || parent === id) return 0;
		return depthOf(parent, new Set([...seen, id])) + 1;
	};

	const summaries: ConversationSummary[] = [];
	for (const record of records) {
		const id = String(record.id);
		const role = roleOf(id, rootId, record);
		summaries.push({
			id,
			label: id === rootId ? "main" : await labelFor(harness, id),
			root: id === rootId,
			role,
			depth: depthOf(id),
			...(record.parent === undefined
				? {}
				: {
						parentConversationId: String(record.parent.conversationId),
						parentEntryId: String(record.parent.at),
					}),
			...(record.owner === undefined
				? {}
				: {
						ownerConversationId: String(record.owner.conversationId),
						ownerTaskId: String(record.owner.taskId),
					}),
			children: children.get(id) ?? 0,
		});
	}
	summaries.sort((left, right) => left.depth - right.depth || Number(left.id) - Number(right.id));
	return summaries;
}

/** A conversation's label: its earliest user input, else its id. */
async function labelFor(harness: Harness, id: string): Promise<string> {
	const conversation = await harness.conversation(Number(id) as ConversationId, TODO_CONTEXT);
	if (conversation === undefined) return id;
	let first: EntryRecord | undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({}, SCAN_PAGE, cursor, TODO_CONTEXT);
		first = page.items.findLast((entry) => entry.kind === "amazme.user") ?? first;
		cursor = page.next;
	} while (cursor !== undefined);
	return labelOf(first) ?? id;
}

/** One page of stored history, oldest first. */
export async function pageOlder(
	conversation: Conversation,
	before: string | null,
	cursor: string | null,
	limit: number,
	context: Context,
): Promise<HistoryPage> {
	const parsed: Cursor | undefined = cursor === null ? undefined : (JSON.parse(cursor) as Cursor);
	const query = before === null || parsed !== undefined ? {} : { maxEntryId: (Number(before) - 1) as EntryId };
	const page = await conversation.entries(query, Math.max(1, limit), parsed, context);
	return {
		entries: [...page.items].reverse(),
		...(page.next === undefined ? {} : { cursor: JSON.stringify(page.next) }),
	};
}

/**
 * Fork `conversationId` at `at`, or at its newest entry. The new conversation is ownerless: it is a
 * branch the reader can switch to, not a subagent's child.
 */
export async function forkAt(harness: Harness, conversationId: string, at: string | null, context: Context): Promise<Conversation> {
	const conversation = await harness.conversation(Number(conversationId) as ConversationId, context);
	if (conversation === undefined) throw new Error(`Unknown conversation: ${conversationId}`);
	let entryId = at === null ? undefined : (Number(at) as EntryId);
	if (entryId === undefined) {
		const newest = await conversation.entries({}, 1, undefined, context);
		entryId = newest.items[0]?.id;
	}
	if (entryId === undefined) throw new Error("Nothing to fork yet");
	return conversation.fork(entryId, { ownership: { kind: "ownerless" } }, context);
}

export async function readFocus(harness: Harness, context: Context): Promise<string> {
	const stored = await harness.snapshot(FocusDoc, context);
	return stored?.conversationId ?? "";
}

export async function writeFocus(harness: Harness, conversationId: string, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const focus = await tx.doc(FocusDoc);
		focus.conversationId = conversationId;
	}, context);
}

/** Lane chrome from the conversation's own agent and live documents. */
export function laneFrom(view: ConversationView | undefined, summary: { readonly role: ConversationRole; readonly label: string } | undefined): LaneStatus {
	const live = (view?.docs["amazme.live"] ?? {}) as LiveState;
	const agent = (view?.docs["amazme.agent"] ?? {}) as AgentState;
	const generation = live.generation;
	const compaction = live.compactions?.[0];
	const runningTool = live.tools?.find((slot) => slot.status === "running");
	let run: LaneStatus["run"] = "idle";
	let detail = "";
	if (generation?.retry !== undefined) {
		run = "retrying";
		detail = generation.retry.error;
	} else if (generation?.deferred !== undefined) run = "deferred";
	else if (compaction !== undefined) {
		run = "compacting";
		detail = compaction.reason;
	} else if (runningTool !== undefined) {
		run = "tool";
		detail = runningTool.name;
	} else if (live.run !== undefined) run = "working";
	const model = agent.model === undefined ? "" : `${agent.model.provider}/${agent.model.modelId}`;
	return {
		role: summary?.role ?? "main",
		label: summary?.label ?? "main",
		model,
		thinking: agent.thinkingLevel ?? "off",
		run,
		detail,
	};
}

/** One English line. The web translates the same fields; the TUI prints this. */
export function formatLane(lane: LaneStatus): string {
	const role = lane.role === "main" ? "Main" : lane.role === "fork" ? "Fork" : "Subagent";
	const name = lane.role === "main" ? role : `${role} · ${lane.label}`;
	const model = lane.model.length === 0 ? "no model" : lane.model;
	const run =
		lane.run === "idle"
			? "idle"
			: lane.run === "tool"
				? `running ${lane.detail}`
				: lane.run === "retrying"
					? `retrying ${lane.detail}`
					: lane.run === "compacting"
						? `compacting (${lane.detail})`
						: lane.run === "deferred"
							? "waiting"
							: lane.run === "working"
								? "working"
								: lane.run;
	return `${name} · ${model} · thinking ${lane.thinking} · ${run}`;
}
