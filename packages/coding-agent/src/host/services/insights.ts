import { type Context, defineService, type ReplicatedState } from "@amazme/chord";

export interface SessionInsightsState {
	revision: number;
	reviewRevision: number;
	conversationId: string;
	paused: "calls" | "seconds" | "cost" | null;
	calls: number;
	cleanup: { tools: number; images: number };
	files: { root: string; path: string; kind: "added" | "removed" | "modified"; added: number; removed: number; binary: boolean }[];
	notes: string[];
	skipped: number;
	at: number;
	verification: { command: string; exitCode: number | null; at: number }[];
}

/** Read-only review and a deliberate continuation of the currently paused conversation. */
export interface SessionInsights {
	readonly state: ReplicatedState<SessionInsightsState>;
	refresh(context: Context): Promise<void>;
	diff(conversationId: string, root: string, path: string, context: Context): Promise<string>;
	resume(conversationId: string, context: Context): Promise<void>;
}

export const SessionInsights = defineService<SessionInsights>("amazme.session-insights");
