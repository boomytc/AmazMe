import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@amazme/ai";
import { defineFacet } from "@amazme/chord";
import type { AttachedReplicatedState, FacetLoader } from "@amazme/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@amazme/chord/context";
import {
	type AgentState,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type EntryRecord,
	AgentDoc,
	Harness,
	section,
	type ModelRef,
	type Submission,
	type TaskGraph,
	type SessionEnd,
} from "@amazme/durable";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { ModelRuntime } from "../core/model-runtime.ts";
import { ProviderLogin } from "../core/provider-login.ts";
import type { ProviderAuthManagement } from "../core/provider-login.ts";
import { createAgentExtensionsFacet } from "../core/plugins/agent-extensions.ts";
import { AgentRuntime, createAgentRuntime } from "../core/plugins/agent-runtime.ts";
import { AgentController } from "../core/plugins/agent-controller.ts";
import { createAgentController } from "../core/plugins/agent-controller-provider.ts";
import { createSlashCommandsRuntimeFacet, SlashCommandRegistry } from "../core/plugins/command-registry.ts";
import type { SlashCommandCompletion, SlashCommandContribution } from "../core/plugins/slash-commands.ts";
import { describePluginSources } from "../core/plugins/info.ts";
import { discoverPluginSources } from "../core/plugins/sources.ts";
import { assertPluginsIdle, openPluginRuntime, type PluginRuntime } from "../core/plugins/runtime.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { durableToolSelection, getToolSelectionError, type ToolSelectionOptions } from "../core/tool-selection.ts";
import { IDLE_LANE, oldestPresentedEntryId, type ConversationSummary, type LaneStatus, type ReturnPoint } from "./conversation-view.ts";
import {
	forkAt,
	formatLane,
	laneFrom,
	navigateTree,
	pageOlder,
	readFocus,
	readReturnPoints,
	readSummaries,
	type TreeNavigationDeps,
} from "./session-surface.ts";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createCodingSettings,
	createHarnessSettings,
	ExecutionEnvs,
	findInitialAgentModel,
	initialThinkingLevel,
} from "./harness-setup.ts";
import { selectSession } from "./sessions.ts";
import { applyDurableMcpSelection, openDurableMcp, type DurableMcp } from "./mcp.ts";
import { Subagent } from "./subagent.ts";
import type { McpManagement } from "../core/mcp/management.ts";
import { NATIVE_COMMANDS } from "./commands.ts";

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
	readonly commands?: readonly Pick<SlashCommandContribution, "name" | "description" | "argumentHint">[];
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
	describePlugins?(): string;
	runCommand?(name: string, args: string): Promise<void>;
	completeCommand?(name: string, prefix: string): Promise<readonly SlashCommandCompletion[] | null>;
	/** Reload the selected application plugin facets; absent when none were configured. */
	reloadPlugins?(): Promise<void>;
	readonly mcp?: McpManagement;
	readonly auth?: ProviderAuthManagement;
	/** Prompt when idle; otherwise steer or queue a follow-up. */
	submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
	compact(instructions: string | undefined): Promise<void>;
	abort(): Promise<void>;
	cycleThinking(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	toggleTasks(): Promise<void>;
	/** Show and talk to another conversation. The choice is stored in the session. */
	switchConversation(id: ConversationId): Promise<void>;
	/** User entries before the tip of the shown conversation. */
	returnPoints(): Promise<readonly ReturnPoint[]>;
	/** Pi `branchSummary.skipPrompt`: leaving does not ask and does not summarize. */
	skipBranchSummaryPrompt(): boolean;
	/**
	 * Leave the shown conversation back to ancestor entry `at` and focus the continuation.
	 * A summary calls `Conversation.branchSummary`. No summary forks at `at` without that entry.
	 */
	leave(at: string, choice: { readonly summarize: boolean; readonly customInstructions?: string }): Promise<void>;
	/** Abort an in-flight branch summary. The shown conversation stays put. */
	cancelLeave(): void;
	/** Fork the shown conversation at its newest entry and switch to the fork. */
	fork(): Promise<void>;
	/** Page one older slice of stored history above the transcript. */
	loadOlder(): Promise<void>;
}

export interface OpenDurableOptions extends ToolSelectionOptions {
	readonly extensions?: readonly string[];
	readonly noExtensions?: boolean;
	/** Application-selected Chord facets; no plugin owner is started when absent. */
	readonly facetLoader?: FacetLoader;
	readonly cwd?: string;
	readonly continueSession?: boolean;
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: ModelThinkingLevel;
	/** A non-persistent credential for the explicitly selected provider. */
	readonly apiKey?: string;
	readonly noMcp?: boolean;
	readonly settingsManager?: SettingsManager;
	readonly modelRuntime?: ModelRuntime;
}

export interface OpenDurableResult {
	readonly closed: Promise<SessionEnd>;
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

export async function openDurable(input: OpenDurableOptions = {}): Promise<OpenDurableResult> {
	const error = getToolSelectionError(input);
	if (error !== undefined) throw new Error(`Invalid tools option: ${error}`);
	const options = { ...input, tools: input.tools?.slice(), excludeTools: input.excludeTools?.slice() };
	if (options.provider !== undefined && options.model === undefined) throw new Error("--provider requires --model");
	if (options.apiKey !== undefined && options.model === undefined) throw new Error("--api-key requires --model");
	const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
	const settingsManager = options.settingsManager ?? createCodingSettings(cwd);
	const sources = options.facetLoader === undefined
		? await discoverPluginSources({ cwd, settings: settingsManager, extensions: options.extensions, noExtensions: options.noExtensions })
		: [];
	if (options.facetLoader !== undefined && options.extensions !== undefined) throw new Error("Select either facetLoader or extension sources");
	const facetLoader = options.facetLoader ?? (sources.length === 0
		? undefined
		: (await import("../core/plugins/loader.ts")).createSourcePluginLoader(sources));
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
	// Resolve explicit arguments before creating or locking persistent session storage.
	const selected = options.model === undefined
		? undefined
		: await findInitialAgentModel(settingsManager, modelRuntime, {
			provider: options.provider,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
		});
	if (options.apiKey !== undefined && selected?.model !== undefined) {
		await modelRuntime.setRuntimeApiKey(selected.model.provider, options.apiKey);
	}
	const initial = options.continueSession === true
		? undefined
		: selected ?? (await findInitialAgentModel(settingsManager, modelRuntime));
	const initialRef = initial?.model;
	const initialModel = initialRef === undefined ? undefined : modelRuntime.getModel(initialRef.provider, initialRef.modelId);
	const initialThinking = initialModel === undefined
		? options.thinkingLevel
		: initialThinkingLevel(settingsManager, initialModel, options.thinkingLevel ?? initial?.thinkingLevel);
	const toolSelection = durableToolSelection(
		options,
		settingsManager.getDefaultTools(),
		settingsManager.getSettings().defaultTools,
	);
	const explicitTools = options.tools !== undefined || options.noTools !== undefined || options.excludeTools !== undefined;
	const location = await selectSession(cwd, options.continueSession ?? false);
	const envs = new ExecutionEnvs(location.cwd);
	let harness: Harness | undefined;
	let mcp: DurableMcp | undefined;
	let plugins: PluginRuntime | undefined;
	let providerLogin: ProviderLogin | undefined;
	let disposeView = (): void => {};
	try {
		configureHarnessHttp(settingsManager);
		const settings = createHarnessSettings(settingsManager);
		const registry = createCodingRegistry(settingsManager, location.cwd);
		registry.install(Subagent);

		const pendingReports: unknown[] = [];
		let report: (error: unknown) => void = (error) => pendingReports.push(error);
		const activeMcp = await openDurableMcp({ registry, cwd: location.cwd, settings: settingsManager, models: modelRuntime, disabled: options.noMcp, report: error => report(error) });
		mcp = activeMcp;
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
		const root = await harness.root(context, {
			agent: {
				cwd: location.cwd,
				...(initial?.model === undefined ? {} : { model: initial.model }),
				...(initialThinking === undefined ? {} : { thinkingLevel: initialThinking }),
			},
			init: async (tx, id) => {
				const agent = await tx.doc(AgentDoc, id);
				agent.tools = activeMcp.selection(toolSelection);
			},
		});
		const opened = harness;
		await applyDurableMcpSelection(mcp, root, context);
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
		const auth = new ProviderLogin(modelRuntime, { getDeviceId: () => settingsManager.getOrCreateDeviceId() });
		providerLogin = auth;
		let lastLogin: string | undefined;
		const stopAuth = auth.subscribe(() => {
			update({ models: models() });
			const login = auth.snapshot().login;
			if (!login || !["done", "error", "cancelled"].includes(login.status) || lastLogin === login.id) return;
			lastLogin = login.id;
			notice(login.status === "error" ? "error" : "info", login.error ?? (login.status === "done"
				? `Signed in to ${login.provider}; select a model with /model.` : "Provider sign-in cancelled."));
		});
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
		let closing: Promise<void> | undefined;
		let activeCommand: AbortController | undefined;
		// One at a time, so toggles, switches, and key presses apply in order.
		const command = (operation: () => Promise<void>): Promise<void> => {
			queue = queue.then(() => {
				if (closing !== undefined) throw new Error("Session is closing");
				return operation();
			}).catch(fail);
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
		const summaryDeps = async (signal: AbortSignal): Promise<TreeNavigationDeps> => {
			const branch = settingsManager.getBranchSummarySettings();
			const ref = agentOf(state.conversation).model;
			const model = ref === undefined ? undefined : modelRuntime.getModel(ref.provider, ref.modelId);
			const auth = model === undefined ? undefined : await modelRuntime.getAuth(model, { signal });
			const headers =
				auth?.auth.headers === undefined
					? undefined
					: Object.fromEntries(Object.entries(auth.auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
			return {
				skipPrompt: branch.skipPrompt,
				reserveTokens: branch.reserveTokens,
				signal,
				retry: settingsManager.getRetrySettings(),
				...(model === undefined ? {} : { model: auth?.auth.baseUrl === undefined ? model : { ...model, baseUrl: auth.auth.baseUrl } }),
				...(auth?.auth.apiKey === undefined ? {} : { apiKey: auth.auth.apiKey }),
				...(headers === undefined || Object.keys(headers).length === 0 ? {} : { headers }),
				...(auth?.env === undefined ? {} : { env: auth.env }),
			};
		};
		let leaveAbort: AbortController | undefined;
		const show = async (id: ConversationId): Promise<void> => {
			// Focus-only. An existing conversation: no summary, no new conversation.
			const focused = await navigateTree(opened, { kind: "focus", conversationId: String(id) }, context);
			const next = focused.conversation;
			await applyDurableMcpSelection(activeMcp, next, context);
			const nextState = await next.viewState(context);
			unsubscribe();
			conversation.dispose();
			current = next;
			conversation = nextState;
			history = [];
			historyCursor = null;
			historyLoaded = false;
			unsubscribe = nextState.subscribe((value) => update({ conversation: value, lane: laneNow(value) }));
			update({
				conversation: nextState.value,
				history: [],
				historyMore: true,
				lane: laneNow(),
			});
		};
		const pluginCommands = facetLoader === undefined ? undefined : new SlashCommandRegistry(NATIVE_COMMANDS.map(({ name }) => name));
		let unsubscribeCommands = (): void => {};
		if (facetLoader !== undefined) {
			if (sources.length > 0) registry.install({ name: "plugin-development", sections: [section("plugin_development", () => describePluginSources(sources))] });
			const controllerFacet = defineFacet({
				id: "@amazme/agent-controller-runtime",
				setup(env) {
					env.provide(AgentRuntime, createAgentRuntime(opened, () => current.id, () => plugins?.changing !== false));
					env.provide(AgentController, createAgentController(opened, () => current, () => plugins?.changing !== false
						? { code: "plugins_reloading", message: "Plugins are unavailable; finish reloading or restart the session" }
						: undefined));
				},
			});
			plugins = await openPluginRuntime(
				[createAgentExtensionsFacet(registry), createSlashCommandsRuntimeFacet(pluginCommands!), controllerFacet],
				facetLoader,
				() => assertPluginsIdle(opened),
			);
			unsubscribeCommands = pluginCommands!.subscribe((commands) => update({
				commands: commands.map(({ name, description, argumentHint }) => ({ name, description, argumentHint })),
			}));
		}
		const controller: DurableController = {
			auth,
			...(plugins === undefined ? {} : {
				describePlugins: () => sources.length === 0 ? "Plugins use the application-provided facet loader" : describePluginSources(sources),
				runCommand: (name: string, args: string) => command(async () => {
					if (plugins!.changing) throw new Error("Plugins are unavailable; finish reloading or restart the session");
					const selected = pluginCommands!.list().find((entry) => entry.name === name);
					if (selected === undefined) throw new Error(`Unknown command: /${name}`);
					const operation = new AbortController();
					activeCommand = operation;
					notice("info", `Running /${name}`);
					try {
						const outcome = await selected.run(args, withAbortSignal(operation.signal, context));
						if (outcome?.accepted === false) throw new Error(outcome.error.message);
						notice("info", `${operation.signal.aborted ? "Cancelled" : "Ran"} /${name}`);
					} catch (error) {
						if (operation.signal.aborted) notice("info", `Cancelled /${name}`);
						else throw error;
					} finally {
						if (activeCommand === operation) activeCommand = undefined;
					}
				}),
				completeCommand: async (name: string, prefix: string) => plugins!.changing
					? null
					: await pluginCommands!.list().find((entry) => entry.name === name)?.getArgumentCompletions?.(prefix) ?? null,
				reloadPlugins: () => command(async () => {
					await assertPluginsIdle(opened);
					await plugins!.reload();
					notice("info", "Reloaded plugins");
				}),
			}),
			mcp: activeMcp.management,
			submit: (text, whenBusy) => command(async () => {
				if (plugins?.changing) throw new Error("Plugins are unavailable; finish reloading or restart the session");
				watchAnswer(await current.submit({ type: "input", content: text, whenBusy }, context));
			}),
			compact: (instructions) =>
				command(async () => {
					if (plugins?.changing) throw new Error("Plugins are unavailable; finish reloading or restart the session");
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
			abort: () => {
				activeCommand?.abort(new Error("Command cancelled"));
				return current.abort(context).catch(fail);
			},
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
			returnPoints: () => readReturnPoints(current, context),
			skipBranchSummaryPrompt: () => settingsManager.getBranchSummarySkipPrompt(),
			leave: (at, choice) =>
				command(async () => {
					leaveAbort = new AbortController();
					try {
						const result = await navigateTree(
							opened,
							{
								kind: "leave",
								conversationId: String(current.id),
								at,
								summarize: choice.summarize,
								...(choice.customInstructions === undefined ? {} : { customInstructions: choice.customInstructions }),
							},
							context,
							await summaryDeps(leaveAbort.signal),
						);
						if (result.cancelled) {
							notice("info", "Branch summarization cancelled");
							return;
						}
						await show(result.conversation.id);
					} finally {
						leaveAbort = undefined;
					}
				}),
			cancelLeave: () => {
				leaveAbort?.abort();
			},
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
					const before = historyLoaded ? null : oldestPresentedEntryId(history.length > 0 ? history : conversation.value.entries);
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

		disposeView = () => {
			stopAuth();
			unsubscribeCommands();
			unsubscribe();
			unsubscribeCommits();
			if (listTimer !== undefined) clearTimeout(listTimer);
			conversation.dispose();
			closeTasks();
			listeners.clear();
		};
		const savedFocus = await readFocus(opened, context);
		if (savedFocus.length > 0 && savedFocus !== String(root.id)) {
			await show(Number(savedFocus) as ConversationId);
		}
		if (!location.created && (explicitTools || agentOf(state.conversation).tools === undefined)) {
			await opened.commit(async (tx) => {
				const agent = await tx.doc(AgentDoc, current.id);
				agent.tools = activeMcp.selection(toolSelection);
			}, context);
		}
		if (!location.created && (selected?.model !== undefined || options.thinkingLevel !== undefined)) {
			const savedAgent = agentOf(state.conversation);
			const ref = selected?.model ?? savedAgent.model;
			const model = ref === undefined ? undefined : modelRuntime.getModel(ref.provider, ref.modelId);
			const requested = options.thinkingLevel ?? selected?.thinkingLevel ?? savedAgent.thinkingLevel;
			const thinkingLevel = model === undefined ? requested : initialThinkingLevel(settingsManager, model, requested);
			await current.configure(
				{
					...(selected?.model === undefined ? {} : { model: selected.model }),
					...(thinkingLevel === undefined ? {} : { thinkingLevel }),
				},
				context,
			);
		}
		const saved = agentOf(state.conversation).model;
		if (saved === undefined) notice("warning", "No model configured; select one with /model.");
		else if (modelRuntime.getModel(saved.provider, saved.modelId) === undefined) {
			notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
		}
		if (initial?.fallbackMessage !== undefined) notice("info", initial.fallbackMessage);
		// The task panel starts open; /tasks hides it.
		await controller.toggleTasks();
		// Recovered work from an interrupted turn continues now.
		harness.resume();

		const result: OpenDurableResult = {
			closed: opened.closed,
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
					activeCommand?.abort(new Error("Session closing"));
					disposeView();
					try {
						await auth.close();
						await settingsManager.flush();
						await queue;
						// Close writes no outcome: a running turn resumes with --continue.
						await opened.close(context);
					} finally {
						try {
							try {
								await plugins?.close();
							} finally {
								try {
									await mcp?.close();
								} finally {
									await envs.cleanup(context);
								}
							}
						} finally {
							await location.release();
						}
					}
				})();
				return closing;
			},
		};
		void opened.closed.then((end) => (end.reason === "failed" ? result.close().catch(fail) : undefined));
		return result;
	} catch (error) {
		disposeView();
		await providerLogin?.close().catch(() => {});
		await harness?.close(context).catch(() => {});
		await plugins?.close().catch(() => {});
		await mcp?.close().catch(() => {});
		await envs.cleanup(context).catch(() => {});
		await location.release().catch(() => {});
		throw error;
	}
}
