import type { StreamFn } from "@amazme/agent";
import type { RetryPolicy } from "@amazme/ai";
import { type Context, defineFacet, type Facet, type MutableReplicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT, TODO_CONTEXT } from "@amazme/chord/context";
import type { AgentState, Conversation, ConversationId, Harness, TaskGraph } from "@amazme/durable";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { GenerateBranchSummaryOptions } from "../../core/compaction/branch-summarization.ts";
import {
	forkAt,
	focusConversation,
	laneFrom,
	navigateTree,
	pageOlder,
	readFocus,
	readReturnPoints,
	readSummaries,
	type TreeNavigationDeps,
} from "../../durable/session-surface.ts";
import type { AgentCompactionRequest, AgentOperationResponse, AgentPromptRequest, AgentQueueResponse } from "../../core/plugins/agent-controller.ts";
import { createAgentController } from "../../core/plugins/agent-controller-provider.ts";
import { Conversations } from "./conversations.ts";
import { type ConversationsState, type HistoryPage, IDLE_LANE, type LaneStatus, type LeaveResult, type ReturnPoint, type TaskSummary } from "../../durable/conversation-view.ts";

/** The gap between two publications while a focused conversation streams. */
const FOCUS_PUBLISH_MS = 250;

export interface BranchSummarySettingsSource {
	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean };
	getRetrySettings(): RetryPolicy;
}

function definedHeaders(headers: Readonly<Record<string, string | null>>): Record<string, string> | undefined {
	const entries = Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** The conversation's saved model, with the runtime's auth, for `generateBranchSummary`. */
export function summaryModelFromRuntime(harness: Harness, modelRuntime: ModelRuntime): NonNullable<ConversationsServiceOptions["summaryModel"]> {
	return async (conversationId, signal) => {
		const conversation = await harness.conversation(Number(conversationId) as ConversationId, TODO_CONTEXT);
		if (conversation === undefined) return undefined;
		const view = await conversation.viewState(TODO_CONTEXT);
		try {
			const agent = (view.value.docs["amazme.agent"] ?? {}) as AgentState;
			const ref = agent.model;
			if (ref === undefined) return undefined;
			const model = modelRuntime.getModel(ref.provider, ref.modelId);
			if (model === undefined) return undefined;
			const auth = await modelRuntime.getAuth(model, { signal });
			const headers = auth?.auth.headers === undefined ? undefined : definedHeaders(auth.auth.headers);
			return {
				model: auth?.auth.baseUrl === undefined ? model : { ...model, baseUrl: auth.auth.baseUrl },
				...(auth?.auth.apiKey === undefined ? {} : { apiKey: auth.auth.apiKey }),
				...(headers === undefined ? {} : { headers }),
				...(auth?.env === undefined ? {} : { env: auth.env }),
			};
		} finally {
			view.dispose();
		}
	};
}

/** Model and request auth for `generateBranchSummary`. Absent when the conversation has no model. */
export interface BranchSummaryModelRequest {
	readonly model: GenerateBranchSummaryOptions["model"];
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
	readonly env?: Record<string, string>;
	readonly streamFn?: StreamFn;
}

export interface ConversationsServiceOptions {
	readonly harness: Harness;
	/** The Session's root conversation: the one a presentation shows without focusing another. */
	readonly root: Conversation;
	/** Pi `branchSummary` settings. Absent means ask, and reserve 16384 tokens. */
	readonly settings?: BranchSummarySettingsSource;
	/** Resolves the model a leave-with-summary call summarizes with. */
	readonly summaryModel?: (conversationId: string, signal: AbortSignal) => Promise<BranchSummaryModelRequest | undefined>;
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
		lane: IDLE_LANE,
		conversations: [],
		tasks: [],
		branchSummarySkipPrompt: false,
		view: null,
	});
	const controllers = new Map<string, ReturnType<typeof createAgentController>>();
	let focus:
		| {
				readonly id: string;
				readonly state: Awaited<ReturnType<Conversation["viewState"]>>;
		  }
		| undefined;
	/** The root's view, kept so the lane stays current while the transcript service owns the root display. */
	let rootView: Awaited<ReturnType<Conversation["viewState"]>> | undefined;
	let focusTimer: NodeJS.Timeout | undefined;
	let focusContext: Context = BACKGROUND_CONTEXT;
	let commitUnsubscribe: (() => void) | undefined;
	let graph: Awaited<ReturnType<Harness["taskGraph"]>> | undefined;
	let graphUnsubscribe: (() => void) | undefined;
	let listTimer: NodeJS.Timeout | undefined;

	const conversationOf = (id: string): Promise<Conversation | undefined> => options.harness.conversation(Number(id) as ConversationId, TODO_CONTEXT);

	/** The controller of one conversation, created on first use. */
	const controllerOf = async (id: string): Promise<ReturnType<typeof createAgentController> | undefined> => {
		const existing = controllers.get(id);
		if (existing !== undefined) return existing;
		const conversation = await conversationOf(id);
		if (conversation === undefined) return undefined;
		const created = createAgentController(options.harness, () => conversation);
		controllers.set(id, created);
		return created;
	};

	const readList = (): Promise<ConversationsState["conversations"]> => readSummaries(options.harness, rootId);

	const summaryOf = (id: string): { role: LaneStatus["role"]; label: string } | undefined => state.value.conversations.find((summary) => summary.id === id);

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
				draft.lane = laneFrom(
					value,
					draft.conversations.find((summary) => summary.id === focus?.id),
				);
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
				(conversations) =>
					publish((draft) => {
						draft.conversations = conversations;
						const summary = conversations.find((item) => item.id === draft.selected);
						const view = draft.selected === rootId ? rootView?.value : (draft.view ?? undefined);
						draft.lane = laneFrom(view ?? undefined, summary);
					}),
				() => {},
			);
		}, 200);
		listTimer.unref?.();
	};

	const skipPrompt = (): boolean => options.settings?.getBranchSummarySettings().skipPrompt ?? false;

	const summaryDeps = async (conversationId: string, signal: AbortSignal): Promise<TreeNavigationDeps> => {
		const settings = options.settings?.getBranchSummarySettings();
		const request = await options.summaryModel?.(conversationId, signal);
		return {
			skipPrompt: settings?.skipPrompt ?? false,
			reserveTokens: settings?.reserveTokens ?? 16384,
			signal,
			retry: options.settings?.getRetrySettings(),
			...(request === undefined
				? {}
				: {
						model: request.model,
						...(request.apiKey === undefined ? {} : { apiKey: request.apiKey }),
						...(request.headers === undefined ? {} : { headers: request.headers }),
						...(request.env === undefined ? {} : { env: request.env }),
						...(request.streamFn === undefined ? {} : { streamFn: request.streamFn }),
					}),
		};
	};

	const select = async (conversationId: string, context: Context): Promise<void> => {
		const existing = await conversationOf(conversationId);
		if (existing === undefined) return;
		closeFocus();
		// Focus-only: an existing conversation, no summary, no new conversation.
		const focused = await focusConversation(options.harness, conversationId, context);
		if (focused === undefined) return;
		const known = (id: string) =>
			state.value.conversations.find((summary) => summary.id === id) ?? {
				role: id === rootId ? ("main" as const) : ("fork" as const),
				label: id,
			};
		publish((draft) => {
			draft.selected = conversationId;
			draft.view = null;
			draft.lane = laneFrom(conversationId === rootId ? rootView?.value : undefined, known(conversationId));
		});
		// The root's view is the Transcript service's; only another conversation needs one here.
		if (conversationId === rootId) return;
		focusContext = context;
		const attached = await focused.viewState(context);
		focus = { id: conversationId, state: attached };
		focus.state.subscribe(() => publishFocus());
		publish((draft) => {
			draft.view = attached.value;
			draft.lane = laneFrom(attached.value, draft.conversations.find((summary) => summary.id === conversationId) ?? known(conversationId));
		});
	};

	const returnPoints = async (conversationId: string, context: Context): Promise<readonly ReturnPoint[]> => {
		const conversation = await conversationOf(conversationId);
		if (conversation === undefined) return [];
		return readReturnPoints(conversation, context);
	};

	const leave = async (
		conversationId: string,
		at: string,
		choice: { readonly summarize: boolean; readonly customInstructions?: string | null },
		context: Context,
	): Promise<LeaveResult> => {
		const signal = new AbortController();
		try {
			const custom = choice.customInstructions?.trim();
			const result = await navigateTree(
				options.harness,
				{
					kind: "leave",
					conversationId,
					at,
					summarize: choice.summarize,
					...(custom === undefined || custom.length === 0 ? {} : { customInstructions: custom }),
				},
				context,
				await summaryDeps(conversationId, signal.signal),
			);
			if (result.cancelled) return { conversationId: null, summarized: false, cancelled: true, error: null };
			await select(String(result.conversation.id), context);
			return {
				conversationId: String(result.conversation.id),
				summarized: result.summarized,
				cancelled: false,
				error: null,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { conversationId: null, summarized: false, cancelled: false, error: { code: "leave", message } };
		}
	};

	const fork = async (conversationId: string, at: string | null, context: Context): Promise<Awaited<ReturnType<Conversations["fork"]>>> => {
		try {
			const created = await forkAt(options.harness, conversationId, at, context);
			await select(String(created.id), context);
			return { conversationId: String(created.id), error: null };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { conversationId: null, error: { code: "fork", message } };
		}
	};

	const refresh = async (context: Context): Promise<void> => {
		const conversations = await readList();
		publish((draft) => {
			draft.conversations = conversations;
			draft.branchSummarySkipPrompt = skipPrompt();
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

	const older = async (conversationId: string, before: string | null, cursor: string | null, limit: number, context: Context): Promise<HistoryPage> => {
		const conversation = await conversationOf(conversationId);
		if (conversation === undefined) return { entries: [] };
		return pageOlder(conversation, before, cursor, limit, context);
	};

	/** Wire the harness's commit stream and task graph into this state. */
	const activate = async (context: Context): Promise<void> => {
		rootView?.dispose();
		rootView = await options.root.viewState(context);
		rootView.subscribe(() => {
			if (state.value.selected !== rootId) return;
			const lane = laneFrom(rootView?.value, summaryOf(rootId));
			publish((draft) => {
				draft.lane = lane;
			});
		});
		const conversations = await readList();
		publish((draft) => {
			draft.conversations = conversations;
			draft.selected = rootId;
			draft.branchSummarySkipPrompt = skipPrompt();
			draft.lane = laneFrom(
				rootView?.value,
				conversations.find((summary) => summary.id === rootId),
			);
		});
		const saved = await readFocus(options.harness, context);
		if (saved.length > 0 && saved !== rootId && conversations.some((summary) => summary.id === saved)) {
			await select(saved, context);
		}
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
			fork,
			returnPoints,
			leave,
			refresh,
			older,
			async prompt(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentOperationResponse> {
				const controller = await controllerOf(conversationId);
				if (controller === undefined) {
					return {
						accepted: false,
						operationId: null,
						error: {
							code: "unknown",
							message: `Unknown conversation: ${conversationId}`,
						},
					};
				}
				return controller.prompt({ ...request, conversationId }, context);
			},
			async steer(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse> {
				const controller = await controllerOf(conversationId);
				if (controller === undefined) {
					return {
						accepted: false,
						entryId: null,
						error: {
							code: "unknown",
							message: `Unknown conversation: ${conversationId}`,
						},
					};
				}
				return controller.steer({ ...request, conversationId }, context);
			},
			async followUp(conversationId: string, request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse> {
				const controller = await controllerOf(conversationId);
				if (controller === undefined) {
					return {
						accepted: false,
						entryId: null,
						error: {
							code: "unknown",
							message: `Unknown conversation: ${conversationId}`,
						},
					};
				}
				return controller.followUp({ ...request, conversationId }, context);
			},
			async abort(conversationId: string, context: Context): Promise<void> {
				await (await controllerOf(conversationId))?.abort(context);
			},
			async cancelQueued(conversationId: string, entryId: string, context: Context) {
				const controller = await controllerOf(conversationId);
				if (controller === undefined) return { outcome: "not_found" as const };
				return controller.cancelQueued(entryId, context);
			},
			async compact(conversationId: string, request: AgentCompactionRequest, context: Context): Promise<AgentOperationResponse> {
				const controller = await controllerOf(conversationId);
				if (controller === undefined) {
					return {
						accepted: false as const,
						operationId: null,
						error: {
							code: "unknown",
							message: `Unknown conversation: ${conversationId}`,
						},
					};
				}
				return controller.compact(request, context);
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
			rootView?.dispose();
			rootView = undefined;
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
