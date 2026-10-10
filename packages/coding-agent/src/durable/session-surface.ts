import type { AgentMessage, StreamFn } from "@amazme/agent";
import { contentText, type Message, type RetryPolicy } from "@amazme/ai";
import type { Context, JsonValue } from "@amazme/chord";
import { TODO_CONTEXT } from "@amazme/chord/context";
import {
	type AgentState,
	BranchSummaryEntry,
	type BranchSummaryInput,
	CompactionEntry,
	UserEntry,
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
import { generateBranchSummary, type GenerateBranchSummaryOptions } from "../core/compaction/branch-summarization.ts";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "../core/messages.ts";
import type { SessionEntry } from "../core/session-manager.ts";
import type { ConversationRole, ConversationSummary, HistoryPage, LaneStatus, ReturnPoint } from "./conversation-view.ts";

/** How many conversations or entries one scan page holds. Callers loop until the scan is exhausted. */
const SCAN_PAGE = 256;

/**
 * The session's display name and focused conversation. Opening the same storage restores both;
 * changing focus preserves its name. Session metadata uses the same durable document API as agents.
 */
export const SessionViewDoc = defineDoc<{ conversationId: string; name?: string }>({
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
		const described = await describeConversation(harness, id, id === rootId);
		summaries.push({
			id,
			label: described.label,
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
			hasEntries: described.hasEntries,
		});
	}
	summaries.sort((left, right) => left.depth - right.depth || Number(left.id) - Number(right.id));
	return summaries;
}

/**
 * A conversation's label and whether it has anything to fork. The root is always `main`. Any other
 * conversation uses its earliest user input, or its id when it has none. `hasEntries` matches
 * `forkAt`: one stored entry is enough, and an empty conversation is not.
 */
async function describeConversation(harness: Harness, id: string, root: boolean): Promise<{ label: string; hasEntries: boolean }> {
	const conversation = await harness.conversation(Number(id) as ConversationId, TODO_CONTEXT);
	if (conversation === undefined) return { label: root ? "main" : id, hasEntries: false };
	if (root) {
		const newest = await conversation.entries({}, 1, undefined, TODO_CONTEXT);
		return { label: "main", hasEntries: newest.items.length > 0 };
	}
	let first: EntryRecord | undefined;
	let hasEntries = false;
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({}, SCAN_PAGE, cursor, TODO_CONTEXT);
		if (page.items.length > 0) hasEntries = true;
		first = page.items.findLast((entry) => entry.kind === "amazme.user") ?? first;
		cursor = page.next;
	} while (cursor !== undefined);
	return { label: labelOf(first) ?? id, hasEntries };
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
	const stored = await harness.snapshot(SessionViewDoc, context);
	return stored?.conversationId ?? "";
}

export async function writeFocus(harness: Harness, conversationId: string, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const focus = await tx.doc(SessionViewDoc);
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

/** Where tree navigation goes. Focus stays on a conversation that already exists. Leave abandons the tail after `at`. */
export type TreeNavigation =
	| { readonly kind: "focus"; readonly conversationId: string }
	| {
			readonly kind: "leave";
			readonly conversationId: string;
			/** Ancestor entry to continue from. History through this entry is kept; later entries stay behind. */
			readonly at: string;
			/**
			 * The reader asked to summarize the abandoned tail. Ignored when `skipPrompt` is set:
			 * Pi then skips the question and leaves with no summary.
			 */
			readonly summarize: boolean;
			readonly customInstructions?: string;
	  };

/** What `generateBranchSummary` needs, plus the Pi `branchSummary` settings that gate it. */
export interface TreeNavigationDeps {
	readonly skipPrompt: boolean;
	readonly reserveTokens: number;
	readonly signal: AbortSignal;
	readonly model?: GenerateBranchSummaryOptions["model"];
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
	readonly env?: Record<string, string>;
	readonly streamFn?: StreamFn;
	readonly retry?: RetryPolicy;
}

export interface TreeNavigationResult {
	/** The conversation now in focus. A leave that wrote a summary returns the continuation `branchSummary` created. */
	readonly conversation: Conversation;
	/** Focus-only is false. Leave creates the continuation. */
	readonly created: boolean;
	/** An `amazme.branch-summary` entry was written on the continuation. */
	readonly summarized: boolean;
	readonly cancelled: boolean;
	readonly aborted?: boolean;
}

/**
 * Focus a conversation that already exists. Writes `amazme.session.focus` and does not fork or summarize.
 * Unknown ids resolve to `undefined` so a picker can ignore a stale row.
 */
export async function focusConversation(harness: Harness, conversationId: string, context: Context): Promise<Conversation | undefined> {
	const conversation = await harness.conversation(Number(conversationId) as ConversationId, context);
	if (conversation === undefined) return undefined;
	await writeFocus(harness, conversationId, context);
	return conversation;
}

/** User entries before the tip: the points a tree can leave back to. */
export async function readReturnPoints(conversation: Conversation, context: Context): Promise<ReturnPoint[]> {
	const entries = await visibleEntries(conversation, context);
	const newest = entries[entries.length - 1];
	if (newest === undefined) return [];
	const points: ReturnPoint[] = [];
	for (const entry of entries) {
		if (entry.id === newest.id || !UserEntry.is(entry)) continue;
		const label = labelOf(entry);
		if (label === undefined) continue;
		points.push({ id: String(entry.id), label });
	}
	return points;
}

/**
 * Pi `navigateTree` on a durable session.
 *
 * Focus switches to a conversation that is already there: no summary entry, no new conversation.
 * Leave goes back to ancestor `at`. When a summary is wanted, `Conversation.branchSummary` forks and
 * writes `amazme.branch-summary` in one commit, and the returned continuation becomes the focus.
 * The summary is not written into some other sibling. `branchSummary.skipPrompt` skips the summary,
 * and the continuation is then an ordinary fork at `at` — the same move Pi makes by shifting the leaf
 * without a summary entry. Durable has no leaf pointer, so that move is a fork.
 */
export async function navigateTree(
	harness: Harness,
	navigation: TreeNavigation,
	context: Context,
	deps?: TreeNavigationDeps,
): Promise<TreeNavigationResult> {
	if (navigation.kind === "focus") {
		const conversation = await focusConversation(harness, navigation.conversationId, context);
		if (conversation === undefined) throw new Error(`Unknown conversation: ${navigation.conversationId}`);
		return { conversation, created: false, summarized: false, cancelled: false };
	}

	if (deps === undefined) throw new Error("Leaving a branch needs branch-summary settings");
	const conversation = await harness.conversation(Number(navigation.conversationId) as ConversationId, context);
	if (conversation === undefined) throw new Error(`Unknown conversation: ${navigation.conversationId}`);
	if (deps.signal.aborted) {
		return { conversation, created: false, summarized: false, cancelled: true, aborted: true };
	}

	const at = Number(navigation.at) as EntryId;
	const summarize = navigation.summarize && !deps.skipPrompt;
	if (!summarize) {
		const created = await conversation.fork(at, { ownership: { kind: "ownerless" } }, context);
		await writeFocus(harness, String(created.id), context);
		return { conversation: created, created: true, summarized: false, cancelled: false };
	}

	const abandoned = (await visibleEntries(conversation, context)).filter((entry) => entry.id > at);
	if (abandoned.length === 0) {
		const created = await conversation.fork(at, { ownership: { kind: "ownerless" } }, context);
		await writeFocus(harness, String(created.id), context);
		return { conversation: created, created: true, summarized: false, cancelled: false };
	}
	if (deps.model === undefined) throw new Error("No model available for summarization");

	const customInstructions = navigation.customInstructions?.trim();
	const result = await generateBranchSummary(sessionEntriesFor(abandoned), {
		model: deps.model,
		signal: deps.signal,
		reserveTokens: deps.reserveTokens,
		...(deps.apiKey === undefined ? {} : { apiKey: deps.apiKey }),
		...(deps.headers === undefined ? {} : { headers: deps.headers }),
		...(deps.env === undefined ? {} : { env: deps.env }),
		...(deps.streamFn === undefined ? {} : { streamFn: deps.streamFn }),
		...(deps.retry === undefined ? {} : { retry: deps.retry }),
		...(customInstructions === undefined || customInstructions.length === 0 ? {} : { customInstructions }),
	});
	if (result.aborted || deps.signal.aborted) {
		return { conversation, created: false, summarized: false, cancelled: true, aborted: true };
	}
	if (result.error) throw new Error(result.error);
	const summary = result.summary?.trim() ?? "";
	if (summary.length === 0) throw new Error("Branch summarization returned an empty summary");

	const input: BranchSummaryInput = {
		summary,
		...(result.usage === undefined ? {} : { usage: result.usage }),
		details: {
			readFiles: result.readFiles ?? [],
			modifiedFiles: result.modifiedFiles ?? [],
		} satisfies JsonValue,
	};
	const continued = await conversation.branchSummary(at, input, { ownership: { kind: "ownerless" } }, context);
	await writeFocus(harness, String(continued.id), context);
	return { conversation: continued, created: true, summarized: true, cancelled: false };
}

async function visibleEntries(conversation: Conversation, context: Context): Promise<EntryRecord[]> {
	const collected: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({}, SCAN_PAGE, cursor, context);
		collected.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	collected.sort((left, right) => left.id - right.id);
	return collected;
}

/** Durable entries in the shape `generateBranchSummary` already walks. No second summarizer. */
function sessionEntriesFor(entries: readonly EntryRecord[]): SessionEntry[] {
	const sessionEntries: SessionEntry[] = [];
	let parentId: string | null = null;
	for (const entry of entries) {
		const id = String(entry.id);
		const sessionEntry = sessionEntryFor(entry, id, parentId);
		parentId = id;
		if (sessionEntry !== undefined) sessionEntries.push(sessionEntry);
	}
	return sessionEntries;
}

function sessionEntryFor(entry: EntryRecord, id: string, parentId: string | null): SessionEntry | undefined {
	// Kinds first. A branch summary and a compaction both carry a user message, and that message is
	// the wrapped text. `generateBranchSummary` wants the raw body and, for a branch summary, the file lists.
	if (BranchSummaryEntry.is(entry)) {
		return {
			type: "branch_summary",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			fromId: String(entry.data.from.entryId),
			summary: entry.data.summary,
			...("details" in entry.data ? { details: entry.data.details } : {}),
		};
	}
	if (CompactionEntry.is(entry)) {
		return {
			type: "compaction",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			summary: compactionSummaryText(entry),
			firstKeptEntryId: entry.head === undefined ? id : String(entry.head),
			tokensBefore: 0,
		};
	}
	const message = entry.model?.[0];
	if (message !== undefined && isTranscriptMessage(message)) {
		return {
			type: "message",
			id,
			parentId,
			timestamp: new Date(message.timestamp).toISOString(),
			message,
		};
	}
	return undefined;
}

/** Raw compaction body. The model message is already wrapped; the summarizer wraps it again. */
function compactionSummaryText(entry: EntryRecord): string {
	const message = entry.model?.[0];
	if (message?.role !== "user") return "";
	const text = contentText(message.content);
	if (text.startsWith(COMPACTION_SUMMARY_PREFIX) && text.endsWith(COMPACTION_SUMMARY_SUFFIX)) {
		return text.slice(COMPACTION_SUMMARY_PREFIX.length, text.length - COMPACTION_SUMMARY_SUFFIX.length);
	}
	return text;
}

function isTranscriptMessage(message: Message): message is AgentMessage & { role: "user" | "assistant" | "toolResult"; timestamp: number } {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}
