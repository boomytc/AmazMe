import type { JsonRepresentation, JsonValue } from "@amazme/chord";
import type { ToolCall } from "@amazme/ai";
import type { CompactionReason, ToolDiagnostic, ToolExecutionResult } from "./harness/types.ts";
import type { ConversationId, Entry, EntryId, EntryRecord, TypedEntry } from "./types.ts";

/** Define a typed entry kind whose `is()` guard narrows by `EntryRecord.kind`. */
export function defineEntry<D extends JsonValue = never>(kind: string): Entry<D> {
	if (typeof kind !== "string" || kind.length === 0) throw new TypeError("Entry kind must be a non-empty string");
	return {
		kind,
		is: (entry: EntryRecord | undefined): entry is TypedEntry<D> => entry !== undefined && entry.kind === kind,
	};
}

/** User input: `model` is `[UserMessage]`. Written by submissions. */
export const UserEntry = defineEntry("amazme.user");
/** Provider result with any stop reason: `model` is `[AssistantMessage]`. Written by generation. */
export const AssistantEntry = defineEntry("amazme.assistant");
/** Positional prompt and tool change: `model` is `[SystemMessage]` with empty `content`. */
export const SystemEntry = defineEntry("amazme.system");
/**
 * Tool result: `model` is `[ToolResultMessage]`, whose content ends with the rendered diagnostics block; `data` holds
 * the structured diagnostics, possibly none. Written by tool tasks, and by generation for calls it did not offer.
 */
export type ToolResultData = { diagnostics: ToolDiagnostic[]; structuredContent?: JsonValue };
export const ToolResultEntry = defineEntry<ToolResultData>("amazme.tool-result");
/** Nested results are durable evidence for their parent, without a synthetic provider tool message. */
export type NestedToolResultData = {
	parentCallId: string;
	call: JsonRepresentation<ToolCall>;
	result: JsonRepresentation<ToolExecutionResult>;
	durationMs?: number;
};
export const NestedToolResultEntry = defineEntry<NestedToolResultData>("amazme.nested-tool-result");
/**
 * Start of a new context: always `head: "self"`, with `model` absent for a plain reset or `[UserMessage]` carrying the
 * handoff text. Written by `Conversation.reset()` and the `handoff` tool control.
 */
export const ResetEntry = defineEntry("amazme.reset");
/**
 * Compaction summary: `model` is `[UserMessage]` with the wrapped summary, `head` the first kept entry. Written by
 * compaction tasks, directly or through a write submission.
 */
export const CompactionEntry = defineEntry<{ reason: CompactionReason }>("amazme.compaction");

/**
 * Wrapped model text for an `amazme.branch-summary` user message. Same channel as a compaction summary: the body is
 * the entry's `model` user message, so context and view already project it. The prefix matches Pi's branch summary
 * so a later host can recognize the message without a second context protocol.
 */
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

/** Closing tag of {@link BRANCH_SUMMARY_PREFIX}. No leading newline, matching Pi's branch summary message. */
export const BRANCH_SUMMARY_SUFFIX = "</summary>";

/** Model text for `summary`. The raw body stays on `data.summary`; this wrapper is what the model reads. */
export function branchSummaryModelText(summary: string): string {
	return `${BRANCH_SUMMARY_PREFIX}${summary}${BRANCH_SUMMARY_SUFFIX}`;
}

/**
 * The path being left. `conversationId` is the conversation `branchSummary()` was called on; `entryId` is its newest
 * visible entry at that commit (Pi's old leaf / `fromId`). The entry may itself live on an ancestor. The conversation
 * record's parent chain is the rest of the fork.
 */
export type AbandonedBranchSource = {
	readonly conversationId: ConversationId;
	readonly entryId: EntryId;
};

/**
 * Provider usage stored on a branch summary. Optional Pi fields are `null` when the provider omitted them, so the
 * object stays strict JSON. The usage object itself is omitted from {@link BranchSummaryData} when the caller did
 * not pass one.
 */
export type BranchSummaryUsage = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
	readonly cacheWrite1h: number | null;
	readonly reasoning: number | null;
};

type BranchSummaryBody = {
	readonly summary: string;
	readonly from: AbandonedBranchSource;
};

/**
 * `amazme.branch-summary` payload. `summary` is the body; `from` identifies the abandoned fork. `usage` and `details`
 * are present only when the caller passed them. Neither is copied into `model` — `model` is the wrapped body alone,
 * which is how a compaction summary enters context.
 */
export type BranchSummaryData =
	| BranchSummaryBody
	| (BranchSummaryBody & { readonly usage: BranchSummaryUsage })
	| (BranchSummaryBody & { readonly details: JsonValue })
	| (BranchSummaryBody & { readonly usage: BranchSummaryUsage; readonly details: JsonValue });

/**
 * Summary of a path the host is leaving. Not a head marker: `fork(at)` already hides entries after `at`, and a head
 * marker would replace the newest compaction or reset. `model` is one user message, so `context()` and `viewState()`
 * pick it up the same way they pick up a compaction summary's text.
 */
export const BranchSummaryEntry = defineEntry<BranchSummaryData>("amazme.branch-summary");
