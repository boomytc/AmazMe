import { defineDoc } from "@amazme/durable";

export type RunState = {
	run: string | null; startedAt: number; calls: number; baseCost: number;
	counted: string[]; paused: "calls" | "seconds" | "cost" | null;
	lastCall: string | null; lastResult: string | null; repeats: number;
};
export const RunStateDoc = defineDoc<RunState>({
	kind: "amazme.run-policy", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ run: null, startedAt: 0, calls: 0, baseCost: 0, counted: [], paused: null, lastCall: null, lastResult: null, repeats: 0 }), checkpointWhen: () => true,
});

export type FileImage = { root: string; path: string; hash: string; text: string | null; size: number };
export type FileChange = { root: string; path: string; kind: "added" | "removed" | "modified"; added: number; removed: number; binary: boolean; diff: string };
export type VerificationRecord = { command: string; exitCode: number | null; at: number };
export type ReviewState = { revision: number; run: string | null; at: number; roots: string[]; baseline: string | null; result: string | null; skipped: number; notes: string[]; verification: VerificationRecord[] };
export const ReviewDoc = defineDoc<ReviewState>({
	kind: "amazme.workspace-review", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ revision: 0, run: null, at: 0, roots: [], baseline: null, result: null, skipped: 0, notes: [], verification: [] }), checkpointWhen: () => true,
});

export type CleanupDecision = { key: string; kind: "tool" | "image"; reference: string; head: number; tail: number };
export const ContextCleanupDoc = defineDoc<{ decisions: CleanupDecision[] }>({
	kind: "amazme.context-cleanup", version: 2, scope: "conversation", history: "rewindable", fork: "asOf",
	// Version 1 matched content rather than occurrences; its ambiguous decisions must be recomputed from raw entries.
	migrate: () => ({ decisions: [] }),
	initial: () => ({ decisions: [] }), checkpointWhen: () => true,
});
