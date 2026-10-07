import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@amazme/ai";
import type { AttachedReplicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import {
	type AgentState,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type EntryRecord,
	Harness,
	type ModelRef,
	type Submission,
	type TaskGraph,
} from "@amazme/durable";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { ConversationSummary, LaneStatus } from "../services/conversations.ts";
import { IDLE_LANE } from "../services/conversations.ts";
import { forkAt, formatLane, laneFrom, pageOlder, readFocus, readSummaries, writeFocus } from "../session-surface.ts";
import { configureHarnessHttp, createCodingRegistry, createHarnessSettings, ExecutionEnvs, findInitialAgentModel } from "./harness-setup.ts";
import { selectSession } from "./sessions.ts";
import { Subagent } from "./subagent.ts";

const context = BACKGROUND_CONTEXT;

export interface ModelSummary extends ModelRef {
	readonly name: string;
	readonly contextWindow: number;
}

export interface Notice {
	readonly id: number;
	readonly level: "info" | "warning" | "error";
	readonly message: string;
}

/** Everything the TUI renders. Plain values; no Harness objects cross this boundary. */
export interface DurableView {
	readonly session: {
		readonly id: string;
		readonly directory: string;
		readonly cwd: string;
	};
	/** The conversation shown and talked to. */
	readonly conversation: ConversationView;
	readonly conversations: readonly ConversationSummary[];
	/** Lane, model, thinking, and run of the shown conversation. */
	readonly lane: LaneStatus;
	/** Stored history paged in above the active transcript, oldest first. */
	readonly history: readonly EntryRecord[];
	/** Another older page exists. */
	readonly historyMore: boolean;
	readonly models: readonly ModelSummary[];
	readonly notices: readonly Notice[];
	/** The live task graph while the task panel is open. */
	readonly tasks?: TaskGraph;
}

export { formatLane };

export interface DurableViewSource {
	current(): DurableView;
	subscribe(listener: () => void): () => void;
}

/** What the TUI may ask for. */
export interface DurableController {
	/** Prompt when idle; otherwise steer or queue a follow-up. */
	submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
	compact(instructions: string | undefined): Promise<void>;
	abort(): Promise<void>;
	cycleThinking(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	toggleTasks(): Promise<void>;
	/** Show and talk to another conversation. The choice is stored in the session. */
	switchConversation(id: ConversationId): Promise<void>;
	/** Fork the shown conversation at its newest entry and switch to the fork. */
	fork(): Promise<void>;
	/** Page one older slice of stored history above the transcript. */
	loadOlder(): Promise<void>;
}

export interface OpenDurableOptions {
	readonly cwd?: string;
	readonly continueSession?: boolean;
}

export interface OpenDurableResult {
	readonly view: DurableViewSource;
	readonly controller: DurableController;
	/** pi's settings, for the TUI's theme and terminal capabilities. */
	readonly settings: SettingsManager;
	close(): Promise<void>;
}

/** The agent document of a view; absent while the conversation has none. */
export function agentOf(view: ConversationView): AgentState {
	return (view.docs["amazme.agent"] ?? {}) as AgentState;
}

export async function openDurable(options: OpenDurableOptions = {}): Promise<OpenDurableResult> {
	const location = await selectSession(options.cwd ?? process.cwd(), options.continueSession ?? false);
	const envs = new ExecutionEnvs(location.cwd);
	let harness: Harness | undefined;
	try {
		const modelRuntime = await ModelRuntime.create();
		const settingsManager = SettingsManager.create(location.cwd);
		configureHarnessHttp(settingsManager);
		const settings = createHarnessSettings(settingsManager);
		const registry = createCodingRegistry(settingsManager, location.cwd);
		registry.install(Subagent);

		const pendingReports: unknown[] = [];
		let report: (error: unknown) => void = (error) => pendingReports.push(error);
		harness = await Harness.open(
			await openNodeSqliteStorage(location.database),
			{
				models: modelRuntime,
				registry,
				settings,
				env: envs.env,
				onReport: (error) => report(error),
			},
			context,
		);
		const initial = location.created ? await findInitialAgentModel(settingsManager, modelRuntime) : undefined;
		const root = await harness.root(context, {
			agent: {
				cwd: location.cwd,
				...(initial?.model === undefined ? {} : { model: initial.model }),
				...(initial?.thinkingLevel === undefined ? {} : { thinkingLevel: initial.thinkingLevel }),
			},
		});
		const opened = harness;
		const summaries = await readSummaries(opened, String(root.id));
		let current: Conversation = root;
		let conversation: AttachedReplicatedState<ConversationView> = await root.viewState(context);
		let history: EntryRecord[] = [];
		let historyCursor: string | null = null;
		let historyLoaded = false;
		const models = (): ModelSummary[] =>
			modelRuntime.getAvailableSnapshot().map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
			}));

		const laneNow = (value: ConversationView = conversation.value): LaneStatus =>
			laneFrom(
				value,
				state.conversations.find((summary) => String(summary.id) === String(current.id)) ?? {
					role: current.id === root.id ? "main" : "fork",
					label: String(current.id),
				},
			);
		let state: DurableView = {
			session: {
				id: location.id,
				directory: location.directory,
				cwd: location.cwd,
			},
			conversation: conversation.value,
			conversations: summaries,
			lane: laneFrom(conversation.value, summaries.find((summary) => summary.root) ?? IDLE_LANE),
			history: [],
			historyMore: true,
			models: models(),
			notices: [],
		};
		const listeners = new Set<() => void>();
		let notifying = false;
		// Commit listeners and Chord frames call this on the Session line; rendering runs afterwards, once per burst.
		const update = (patch: Partial<DurableView>): void => {
			state = { ...state, ...patch };
			if (notifying) return;
			notifying = true;
			setImmediate(() => {
				notifying = false;
				for (const listener of listeners) listener();
			});
		};
		let nextNotice = 1;
		const notice = (level: Notice["level"], message: string): void => {
			update({
				notices: [...state.notices, { id: nextNotice++, level, message }].slice(-20),
			});
		};
		const fail = (error: unknown): void => notice("error", error instanceof Error ? error.message : String(error));
		report = (error) => notice("warning", error instanceof Error ? error.message : String(error));
		for (const error of pendingReports) report(error);
		let unsubscribe = conversation.subscribe((value) => update({ conversation: value, lane: laneNow(value) }));
		let listTimer: NodeJS.Timeout | undefined;
		const refreshList = (): void => {
			if (listTimer !== undefined) return;
			listTimer = setTimeout(() => {
				listTimer = undefined;
				void readSummaries(opened, String(root.id)).then(
					(conversations) => update({ conversations, lane: laneNow() }),
					() => {},
				);
			}, 200);
			listTimer.unref?.();
		};
		// A commit only schedules a re-read; no Session API is called from the listener.
		const unsubscribeCommits = harness.subscribeCommits((publication) => {
			for (const change of publication.changes) {
				if (change.type === "conversation" || change.type === "entry") {
					refreshList();
					return;
				}
			}
		});

		let tasks: AttachedReplicatedState<TaskGraph> | undefined;
		let unsubscribeTasks = (): void => {};
		const closeTasks = (): void => {
			unsubscribeTasks();
			tasks?.dispose();
			tasks = undefined;
		};

		let queue = Promise.resolve();
		// One at a time, so toggles, switches, and key presses apply in order.
		const command = (operation: () => Promise<void>): Promise<void> => {
			queue = queue.then(operation).catch(fail);
			return queue;
		};
		const watchAnswer = (submission: Submission): void => {
			void submission.wait(context).then((settled) => {
				if (settled.status === "unanswered" && settled.reason !== "aborted") {
					notice("error", `No answer: ${settled.reason}${settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`}`);
				}
			}, fail);
		};
		const agentModel = () => {
			const ref = agentOf(state.conversation).model;
			const model = ref === undefined ? undefined : modelRuntime.getModel(ref.provider, ref.modelId);
			if (model === undefined) throw new Error(ref === undefined ? "No model selected" : "Current model is unavailable");
			return model;
		};
		const show = async (id: ConversationId): Promise<void> => {
			const next = await opened.conversation(id, context);
			if (next === undefined) throw new Error(`Conversation ${id} does not exist`);
			const nextState = await next.viewState(context);
			unsubscribe();
			conversation.dispose();
			current = next;
			conversation = nextState;
			history = [];
			historyCursor = null;
			historyLoaded = false;
			unsubscribe = nextState.subscribe((value) => update({ conversation: value, lane: laneNow(value) }));
			await writeFocus(opened, String(next.id), context);
			update({
				conversation: nextState.value,
				history: [],
				historyMore: true,
				lane: laneNow(),
			});
		};
		const controller: DurableController = {
			submit: (text, whenBusy) => command(async () => watchAnswer(await current.submit({ type: "input", content: text, whenBusy }, context))),
			compact: (instructions) =>
				command(async () => {
					const id = await current.compact(instructions, context);
					// Report the outcome once it is known; the status line shows the compaction meanwhile.
					void opened.waitForTask(id, context).then(async (receipt) => {
						const outcome = receipt.state.outcome;
						if (outcome.status === "completed") {
							const { entryId, submissionId } = outcome.result;
							// A summary written while busy is a submission: placed now, queued, or dropped as stale.
							const status = submissionId === undefined ? undefined : (await (await opened.submission(submissionId, context))?.status(context))?.status;
							notice(
								"info",
								entryId !== undefined || status === "done"
									? "Compacted."
									: status === "queued"
										? "Compaction summary queued; it is placed at the next turn boundary."
										: status === "unanswered"
											? "Compaction summary dropped: the context changed under it."
											: "Nothing to compact: the context fits in the recent window that is kept verbatim.",
							);
						} else if (outcome.status === "aborted") notice("info", "Compaction aborted.");
						else notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
					}, fail);
				}),
			// Not queued: it waits until the conversation is idle.
			abort: () => current.abort(context).catch(fail),
			cycleThinking: () =>
				command(async () => {
					const model = agentModel();
					if (!model.reasoning) throw new Error("Current model does not support thinking");
					const levels = getSupportedThinkingLevels(model);
					const level = agentOf(state.conversation).thinkingLevel ?? "off";
					const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
					await current.configure({ thinkingLevel: next }, context);
				}),
			setModel: (ref) =>
				command(async () => {
					const model = modelRuntime.getModel(ref.provider, ref.modelId);
					if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
					const thinking: ModelThinkingLevel = agentOf(state.conversation).thinkingLevel ?? "off";
					await current.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, context);
				}),
			toggleTasks: () =>
				command(async () => {
					if (tasks !== undefined) {
						closeTasks();
						update({ tasks: undefined });
						return;
					}
					const graph = await opened.taskGraph(context);
					tasks = graph;
					unsubscribeTasks = graph.subscribe((value) => update({ tasks: value }));
				}),
			switchConversation: (id) => command(() => show(id)),
			fork: () =>
				command(async () => {
					const created = await forkAt(opened, String(current.id), null, context);
					await show(created.id);
				}),
			loadOlder: () =>
				command(async () => {
					if (historyLoaded && historyCursor === null) {
						update({ historyMore: false });
						return;
					}
					const oldest = history[0]?.id ?? conversation.value.entries[0]?.id;
					const before = historyLoaded || oldest === undefined ? null : String(oldest);
					const page = await pageOlder(current, before, historyCursor, 20, context);
					historyLoaded = true;
					history = [...page.entries, ...history];
					historyCursor = page.cursor ?? null;
					update({
						history: [...history],
						historyMore: historyCursor !== null,
					});
				}),
		};

		const saved = agentOf(state.conversation).model;
		if (saved === undefined) notice("warning", "No model configured; select one with /model.");
		else if (modelRuntime.getModel(saved.provider, saved.modelId) === undefined) {
			notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
		}
		if (initial?.fallbackMessage !== undefined) notice("info", initial.fallbackMessage);
		// The task panel starts open; /tasks hides it.
		await controller.toggleTasks();
		const savedFocus = await readFocus(opened, context);
		if (savedFocus.length > 0 && savedFocus !== String(root.id)) {
			await controller.switchConversation(Number(savedFocus) as ConversationId);
		}
		// Recovered work from an interrupted turn continues now.
		harness.resume();

		let closing: Promise<void> | undefined;
		return {
			view: {
				current: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			controller,
			settings: settingsManager,
			close() {
				closing ??= (async () => {
					unsubscribe();
					unsubscribeCommits();
					if (listTimer !== undefined) clearTimeout(listTimer);
					conversation.dispose();
					closeTasks();
					try {
						// Close writes no outcome: a running turn resumes with --continue.
						await opened.close(context);
						await envs.cleanup(context);
					} finally {
						await location.release();
					}
				})();
				return closing;
			},
		};
	} catch (error) {
		await harness?.close(context).catch(() => {});
		await location.release().catch(() => {});
		throw error;
	}
}
