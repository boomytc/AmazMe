import { type Context, defineService, type ReplicatedState } from "@amazme/chord";
import type { ConversationView, EntryRecord } from "@amazme/durable";
import type { AgentCompactionRequest, AgentOperationResponse, AgentPromptRequest, AgentQueueResponse } from "./agent-controller.ts";

/** How a conversation sits in the session tree. */
export type ConversationRole = "main" | "fork" | "subagent";

/**
 * What the shown conversation is doing. Both the TUI and the web render this; neither invents its own
 * status vocabulary. `model` is `provider/id`, or empty when none is configured.
 */
export interface LaneStatus {
	role: ConversationRole;
	/** The conversation's label: `main`, a fork's first input, or a subagent's task. */
	label: string;
	model: string;
	thinking: string;
	run: "idle" | "working" | "retrying" | "deferred" | "compacting" | "tool";
	/** Tool name, retry error, or compaction reason. Empty when `run` needs none. */
	detail: string;
}

export const IDLE_LANE: LaneStatus = {
	role: "main",
	label: "main",
	model: "",
	thinking: "off",
	run: "idle",
	detail: "",
};

/** One conversation of the Session, as a list shows it. */
export interface ConversationSummary {
	id: string;
	/** `main` for the root, otherwise the conversation's first input or its id. */
	label: string;
	root: boolean;
	role: ConversationRole;
	/** Indent of this row in the fork/subagent tree. The root is 0. */
	depth: number;
	/** Fork source. Present when this conversation was forked from another. */
	parentConversationId?: string;
	parentEntryId?: string;
	/** The conversation that owns this one's task: how a subagent's child is attributed. */
	ownerConversationId?: string;
	ownerTaskId?: string;
	/** How many conversations fork from this one or are owned by it. */
	children: number;
}

/** One live task of the Session's task graph, as a list shows it. */
export interface TaskSummary {
	id: string;
	kind: string;
	conversationId: string;
	ownerTaskId?: string;
	background: boolean;
	/** `pending`, `running`, `waiting`, `completing`, or the reason it is not live any more. */
	status: string;
	/** The phase the task reports, such as the step it is in. */
	phase: string;
	/** The tasks a `waiting` task waits on. */
	waitsOn: readonly string[];
	/** The conversations this task owns. */
	conversations: readonly string[];
}

export interface ConversationsState {
	revision: number;
	/** The conversation the presentation is focused on. Restored from the session on attach. */
	selected: string;
	/** Lane, model, thinking, and run of the focused conversation. Always set. */
	lane: LaneStatus;
	conversations: ConversationSummary[];
	/** The live tasks, in id order. */
	tasks: TaskSummary[];
	/**
	 * The focused conversation's view, for a presentation that shows one that is not the root. The
	 * root's view is the Transcript service's; this stays null while the root is selected.
	 */
	view: ConversationView | null;
}

/** `conversationId` is the new fork. `error` is set when there is nothing to fork from. */
export type ForkResult = { conversationId: string; error: null } | { conversationId: null; error: { code: string; message: string } };

/** One page of a conversation's stored history, older than the entries the view carries. */
export interface HistoryPage {
	/** Oldest first, so a presentation can append them above what it already shows. */
	entries: EntryRecord[];
	/** Where the next, older page starts; absent when the history is exhausted. */
	cursor?: string;
}

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
	/** Re-read the conversation list, the task graph, and the focused view. */
	refresh(context: Context): Promise<void>;
	/**
	 * One page of stored history. The first page (`cursor` null) starts below `before`, the oldest
	 * entry the presentation already shows, so a page never repeats what the transcript carries.
	 */
	older(conversationId: string, before: string | null, cursor: string | null, limit: number, context: Context): Promise<HistoryPage>;
	/** Send input to any conversation: a run of its own, the way the root's controller does. */
	prompt(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentOperationResponse>;
	steer(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>;
	followUp(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>;
	abort(conversationId: string, context: Context): Promise<void>;
	/** Withdraw one queued input of that conversation. */
	cancelQueued(conversationId: string, entryId: string, context: Context): Promise<{ outcome: "cancelled" | "already_consumed" | "not_found" }>;
	/** Compact that conversation. The durable compaction, not a second summarizer. */
	compact(conversationId: string, request: AgentCompactionRequest, context: Context): Promise<AgentOperationResponse>;
}

export const Conversations = defineService<Conversations>("amazme.conversations");
