import { type Context, defineService, type ReplicatedState } from "@amazme/chord";
import type {
	AgentCompactionRequest,
	AgentOperationResponse,
	AgentPromptRequest,
	AgentQueueResponse,
} from "./agent-controller.ts";

import type {
	ConversationsState,
	ForkResult,
	ReturnPoint,
	LeaveResult,
	HistoryPage,
} from "../../durable/conversation-view.ts";

/** The Session's conversations, its live task graph, stored history, and how to talk to any of them. */
export interface Conversations {
	readonly state: ReplicatedState<ConversationsState>;
	/** Focus one conversation: publish its view (or clear it for the root) and make it the target. */
	select(conversationId: string, context: Context): Promise<void>;
	/**
	 * Fork `conversationId` at `at` (or at its newest entry when `at` is null) into an ownerless
	 * conversation, then focus it. The fork and the focus are both in `session.sqlite`.
	 */
	fork(conversationId: string, at: string | null, context: Context): Promise<ForkResult>;
	/** User entries before the tip of `conversationId`. Selecting one leaves that branch. */
	returnPoints(conversationId: string, context: Context): Promise<readonly ReturnPoint[]>;
	/**
	 * Leave `conversationId` back to ancestor entry `at`, then focus the continuation.
	 * A summary forks via `Conversation.branchSummary` and writes the entry on that continuation.
	 * No summary forks at `at` without a branch-summary entry. `branchSummary.skipPrompt` forces no summary.
	 * Focusing a conversation that already exists is `select`, not this.
	 */
	leave(
		conversationId: string,
		at: string,
		choice: {
			readonly summarize: boolean;
			readonly customInstructions?: string | null;
		},
		context: Context,
	): Promise<LeaveResult>;
	/** Re-read the conversation list, the task graph, and the focused view. */
	refresh(context: Context): Promise<void>;
	/**
	 * One page of stored history. The first page (`cursor` null) starts below `before`, the oldest
	 * entry the presentation already shows, so a page never repeats what the transcript carries.
	 */
	older(
		conversationId: string,
		before: string | null,
		cursor: string | null,
		limit: number,
		context: Context,
	): Promise<HistoryPage>;
	/** Send input to any conversation: a run of its own, the way the root's controller does. */
	prompt(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentOperationResponse>;
	steer(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>;
	followUp(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>;
	abort(conversationId: string, context: Context): Promise<void>;
	/** Withdraw one queued input of that conversation. */
	cancelQueued(
		conversationId: string,
		entryId: string,
		context: Context,
	): Promise<{ outcome: "cancelled" | "already_consumed" | "not_found" }>;
	/** Compact that conversation. The durable compaction, not a second summarizer. */
	compact(conversationId: string, request: AgentCompactionRequest, context: Context): Promise<AgentOperationResponse>;
}

export const Conversations = defineService<Conversations>("amazme.conversations");
