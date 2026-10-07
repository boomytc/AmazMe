import type { Usage } from "@amazme/ai";
import {
	type AbandonedBranchSource,
	type BranchSummaryData,
	BranchSummaryEntry,
	type BranchSummaryUsage,
	branchSummaryModelText,
} from "../entries.ts";
import type { ConversationId, EntryRecord, Tx } from "../types.ts";
import type { BranchSummaryInput } from "./types.ts";

/** Reject a body that would persist an empty model message. Writes nothing. */
export function assertBranchSummaryInput(input: BranchSummaryInput): void {
	if (typeof input.summary !== "string" || input.summary.length === 0) {
		throw new TypeError("Branch summary text must be a non-empty string");
	}
}

/**
 * Append `amazme.branch-summary` on `conversationId`. Caller has already forked; this only writes the entry.
 * `from` is the abandoned conversation and its leaf, not the fork point.
 */
export function placeBranchSummary(
	tx: Tx,
	conversationId: ConversationId,
	from: AbandonedBranchSource,
	input: BranchSummaryInput,
	now: number,
): Promise<EntryRecord> {
	assertBranchSummaryInput(input);
	return tx.appendEntry(BranchSummaryEntry, conversationId, {
		model: [
			{
				role: "user",
				content: [{ type: "text", text: branchSummaryModelText(input.summary) }],
				timestamp: now,
			},
		],
		data: branchSummaryData(input, from),
	});
}

function branchSummaryData(input: BranchSummaryInput, from: AbandonedBranchSource): BranchSummaryData {
	const body = { summary: input.summary, from };
	const usage = input.usage === undefined ? undefined : usageRecord(input.usage);
	const details = input.details;
	if (usage !== undefined && details !== undefined) return { ...body, usage, details };
	if (usage !== undefined) return { ...body, usage };
	if (details !== undefined) return { ...body, details };
	return body;
}

function usageRecord(usage: Usage): BranchSummaryUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
		cacheWrite1h: usage.cacheWrite1h ?? null,
		reasoning: usage.reasoning ?? null,
	};
}
