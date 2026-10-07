import { type Context, defineFacet, type Facet, type MutableReplicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT, TODO_CONTEXT } from "@amazme/chord/context";
import {
	type Conversation,
	type ConversationId,
	type Cursor,
	type EntryRecord,
	type Harness,
	type TaskGraph,
	type TaskId,
} from "@amazme/durable";
import { createAgentController } from "./agent-controller-provider.ts";
import type { AgentOperationResponse, AgentPromptRequest, AgentQueueResponse } from "./agent-controller.ts";
import {
	Conversations,
	type ConversationSummary,
	type ConversationsState,
	type HistoryPage,
	type TaskSummary,
} from "./conversations.ts";

/** How many conversations one scan page holds; the scan loops until it is exhausted. */
const SCAN_PAGE = 256;
/** The gap between two publications while a focused conversation streams. */
const FOCUS_PUBLISH_MS = 250;

export interface ConversationsServiceOptions {
	readonly harness: Harness;
	/** The Session's root conversation: the one a presentation shows without focusing another. */
	readonly root: Conversation;
}

/** The text of a user entry as a one-line label. */
function labelOf(entry: EntryRecord | undefined): string | undefined {
	const message = entry?.model?.[0];
	if (message?.role !== "user") return undefined;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The Session's conversation list, live task graph, stored history, and per-conversation control.
 * The graph is the harness's own replicated state, projected into a plain list so a presentation
 * reads one shape; the list is kept current from the harness's commit stream, which only records.
 */
export function createConversationsService(
	options: ConversationsServiceOptions,
	createState: (initial: ConversationsState) => MutableReplicatedState<ConversationsState>,
) {
	const rootId = String(options.root.id);
	const state = createState({
		revision: 0,
		selected: rootId,
		conversations: [],
		tasks: [],
		view: null,
	});
	const controllers = new Map<string, ReturnType<typeof createAgentController>>();
	let focus: { readonly id: string; readonly state: Awaited<ReturnType<Conversation["viewState"]>> } | undefined;
	let focusTimer: NodeJS.Timeout | undefined;
	let focusContext: Context = BACKGROUND_CONTEXT;
	let commitUnsubscribe: (() => void) | undefined;
	let graph: Awaited<ReturnType<Harness["taskGraph"]>> | undefined;
	let graphUnsubscribe: (() => void) | undefined;
	let listTimer: NodeJS.Timeout | undefined;

	const conversationOf = (id: string): Promise<Conversation | undefined> =>
		options.harness.conversation(Number(id) as ConversationId, TODO_CONTEXT);

	/** The controller of one conversation, created on first use. */
	const controllerOf = async (id: string): Promise<ReturnType<typeof createAgentController> | undefined> => {
		const existing = controllers.get(id);
		if (existing !== undefined) return existing;
		const conversation = await conversationOf(id);
		if (conversation === undefined) return undefined;
		const created = createAgentController(options.harness, conversation);
		controllers.set(id, created);
		return created;
	};

	/** Read every conversation of the Session with its label and its ownership edges. */
	const readList = async (): Promise<ConversationSummary[]> => {
		const records: {
			readonly id: ConversationId;
			readonly owner?: { readonly conversationId: ConversationId; readonly taskId: TaskId };
		}[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await options.harness.commit((tx) => tx.scanConversations({}, SCAN_PAGE, cursor), TODO_CONTEXT);
			for (const record of page.items) {
				records.push({ id: record.id, ...(record.owner === undefined ? {} : { owner: record.owner }) });
			}
			cursor = page.next;
		} while (cursor !== undefined);
		const children = new Map<string, number>();
		for (const record of records) {
			if (record.owner === undefined) continue;
			const owner = String(record.owner.conversationId);
			children.set(owner, (children.get(owner) ?? 0) + 1);
		}
		const summaries: ConversationSummary[] = [];
		for (const record of records) {
			const id = String(record.id);
			summaries.push({
				id,
				label: id === rootId ? "main" : await labelFor(id),
				root: id === rootId,
				...(record.owner === undefined
					? {}
					: { ownerConversationId: String(record.owner.conversationId), ownerTaskId: String(record.owner.taskId) }),
				children: children.get(id) ?? 0,
			});
		}
		summaries.sort((left, right) => Number(left.id) - Number(right.id));
		return summaries;
	};

	/** A conversation's label: its earliest user input, else its id. */
	const labelFor = async (id: string): Promise<string> => {
		const conversation = await conversationOf(id);
		if (conversation === undefined) return id;
		let first: EntryRecord | undefined;
		let cursor: Cursor | undefined;
		do {
			const page = await conversation.entries({}, SCAN_PAGE, cursor, TODO_CONTEXT);
			first = page.items.findLast((entry) => entry.kind === "amazme.user") ?? first;
			cursor = page.next;
		} while (cursor !== undefined);
		return labelOf(first) ?? id;
	};

	/** The task graph as a plain list: every live task with what it waits on and owns. */
	const readTasks = (value: TaskGraph): TaskSummary[] =>
		Object.values(value.tasks)
			.map((node) => ({
				id: String(node.id),
				kind: node.kind,
				conversationId: String(node.conversationId),
				...(node.owner === undefined ? {} : { ownerTaskId: String(node.owner) }),
				background: node.background,
				status: node.state.status,
				phase: node.state.status === "completing" ? node.state.outcome : node.state.phase,
				waitsOn: node.state.status === "waiting" ? node.state.on.map(String) : [],
				conversations: node.conversations.map(String),
			}))
			.sort((left, right) => Number(left.id) - Number(right.id));

	const publish = (update: (draft: ConversationsState) => void): void => {
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.revision += 1;
			update(draft);
		});
	};

	/** Publish the focused view at most once per window, so a streaming child does not flood. */
	const publishFocus = (): void => {
		if (focus === undefined) return;
		if (focusTimer !== undefined) return;
		focusTimer = setTimeout(() => {
			focusTimer = undefined;
			if (focus === undefined) return;
			const value = focus.state.value;
			publish((draft) => {
				draft.view = value;
			});
		}, FOCUS_PUBLISH_MS);
		focusTimer.unref?.();
	};

	const closeFocus = (): void => {
		if (focusTimer !== undefined) {
			clearTimeout(focusTimer);
			focusTimer = undefined;
		}
		focus?.state.dispose();
		focus = undefined;
	};

	/** Refresh the conversation list, coalescing bursts of commits. */
	const scheduleListRefresh = (): void => {
		if (listTimer !== undefined) return;
		listTimer = setTimeout(() => {
			listTimer = undefined;
			void readList().then(
				(conversations) => publish((draft) => {
					draft.conversations = conversations;
				}),
				() => {},
			);
		}, 200);
		listTimer.unref?.();
	};

	const select = async (conversationId: string, context: Context): Promise<void> => {
		const conversation = await conversationOf(conversationId);
		if (conversation === undefined) return;
		closeFocus();
		publish((draft) => {
			draft.selected = conversationId;
			draft.view = null;
		});
		// The root's view is the Transcript service's; only another conversation needs one here.
		if (conversationId === rootId) return;
		focusContext = context;
		const attached = await conversation.viewState(context);
		focus = { id: conversationId, state: attached };
		focus.state.subscribe(() => publishFocus());
		publish((draft) => {
			draft.view = attached.value;
		});
	};

	const refresh = async (context: Context): Promise<void> => {
		const conversations = await readList();
		publish((draft) => {
			draft.conversations = conversations;
		});
		if (focus !== undefined && focus.id !== rootId) {
			const attached = await (await conversationOf(focus.id))?.viewState(context);
			if (attached !== undefined) {
				publish((draft) => {
					draft.view = attached.value;
				});
				// A fresh read is the point of a refresh, so the old attachment is replaced.
				focus.state.dispose();
				focus = { id: focus.id, state: attached };
				focus.state.subscribe(() => publishFocus());
			}
		}
	};

	const older = async (
		conversationId: string,
		cursor: string | null,
		limit: number,
		context: Context,
	): Promise<HistoryPage> => {
		const conversation = await conversationOf(conversationId);
		if (conversation === undefined) return { entries: [] };
		const parsed: Cursor | undefined = cursor === null ? undefined : (JSON.parse(cursor) as Cursor);
		const page = await conversation.entries({}, Math.max(1, limit), parsed, context);
		// The scan is newest first; a presentation appends a page above what it shows, so reverse it.
		return {
			entries: [...page.items].reverse(),
			...(page.next === undefined ? {} : { cursor: JSON.stringify(page.next) }),
		};
	};

	/** Wire the harness's commit stream and task graph into this state. */
	const activate = async (context: Context): Promise<void> => {
		publish((draft) => {
			draft.selected = rootId;
		});
		publish((draft) => {
			draft.conversations = [];
		});
		scheduleListRefresh();
		commitUnsubscribe = options.harness.subscribeCommits((publication) => {
			// A commit only schedules a re-read; no Session API is called from the listener.
			for (const change of publication.changes) {
				if (change.type === "conversation" || change.type === "entry") {
					scheduleListRefresh();
					return;
				}
			}
		});
		graph = await options.harness.taskGraph(context);
		const publishGraph = (value: TaskGraph): void => {
			const tasks = readTasks(value);
			publish((draft) => {
				draft.tasks = tasks;
			});
			// A task that owns a conversation nobody has seen yet means the list is behind.
			const known = new Set(state.value.conversations.map((summary) => summary.id));
			if (tasks.some((task) => task.conversations.some((id) => !known.has(id)))) scheduleListRefresh();
		};
		publishGraph(graph.value);
		graphUnsubscribe = graph.subscribe((value) => publishGraph(value));
		void focusContext;
	};

	return {
		service: {
			state,
			select,
			refresh,
			older,
			async prompt(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentOperationResponse> {
				const controller = await controllerOf(conversationId);
				if (controller === undefined) {
					return { accepted: false, operationId: null, error: { code: "unknown", message: `Unknown conversation: ${conversationId}` } };
				}
				return controller.prompt(request, context);
			},
			async steer(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse> {
				const controller = await controllerOf(conversationId);
				if (controller === undefined) {
					return { accepted: false, entryId: null, error: { code: "unknown", message: `Unknown conversation: ${conversationId}` } };
				}
				return controller.steer(request, context);
			},
			async followUp(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse> {
				const controller = await controllerOf(conversationId);
				if (controller === undefined) {
					return { accepted: false, entryId: null, error: { code: "unknown", message: `Unknown conversation: ${conversationId}` } };
				}
				return controller.followUp(request, context);
			},
			async abort(conversationId: string, context: Context): Promise<void> {
				await (await controllerOf(conversationId))?.abort(context);
			},
		} satisfies Conversations,
		activate,
		dispose(): void {
			commitUnsubscribe?.();
			commitUnsubscribe = undefined;
			graphUnsubscribe?.();
			graphUnsubscribe = undefined;
			graph?.dispose();
			graph = undefined;
			if (listTimer !== undefined) clearTimeout(listTimer);
			listTimer = undefined;
			closeFocus();
		},
	};
}

/** The conversations service as a facet: it owns the harness subscriptions it opens. */
export function createConversationsFacet(options: ConversationsServiceOptions): Facet {
	return defineFacet({
		id: "@pi/conversations",
		setup(env) {
			const runtime = createConversationsService(options, (initial) => env.replicatedState(initial));
			env.provide(Conversations, runtime.service);
			env.own(() => runtime.dispose());
			env.onActivate(() => runtime.activate(BACKGROUND_CONTEXT));
		},
	});
}
