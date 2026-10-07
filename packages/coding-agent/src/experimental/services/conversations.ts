import { type Context, defineService, type ReplicatedState } from "@amazme/chord";
import type { ConversationView, EntryRecord } from "@amazme/durable";
import type { AgentOperationResponse, AgentPromptRequest, AgentQueueResponse } from "./agent-controller.ts";

/** One conversation of the Session, as a list shows it. */
export interface ConversationSummary {
	id: string;
	/** `main` for the root, otherwise the conversation's first input or its id. */
	label: string;
	root: boolean;
	/** The conversation that owns this one's task: how a subagent's child is attributed. */
	ownerConversationId?: string;
	ownerTaskId?: string;
	/** How many conversations this one owns. */
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
	/** The conversation the presentation is focused on. */
	selected: string;
	conversations: ConversationSummary[];
	/** The live tasks, in id order. */
	tasks: TaskSummary[];
	/**
	 * The focused conversation's view, for a presentation that shows one that is not the root. The
	 * root's view is the Transcript service's; this stays null while the root is selected.
	 */
	view: ConversationView | null;
}

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
	/** Re-read the conversation list, the task graph, and the focused view. */
	refresh(context: Context): Promise<void>;
	/** A page of stored history older than the cursor (the newest page when it is null). */
	older(conversationId: string, cursor: string | null, limit: number, context: Context): Promise<HistoryPage>;
	/** Send input to any conversation: a run of its own, the way the root's controller does. */
	prompt(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentOperationResponse>;
	steer(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>;
	followUp(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>;
	abort(conversationId: string, context: Context): Promise<void>;
}

export const Conversations = defineService<Conversations>("amazme.conversations");
