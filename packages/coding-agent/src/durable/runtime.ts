import { serviceSetFacet, type ApplicationService, type ServiceValue } from "@amazme/protocol/services";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getSupportedThinkingLevels, type AssistantMessage, type ImageContent, type Model, type ModelThinkingLevel, type TextContent } from "@amazme/ai";
import type { AttachedReplicatedState, FacetLoader } from "@amazme/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@amazme/chord/context";
import {
	type AgentEventStream,
	type AgentState,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type EntryRecord,
	AgentDoc,
	LiveDoc,
	Harness,
	section,
	type ModelRef,
	type SettledSubmissionRecord,
	type Submission,
	type InboxItem,
	type TaskGraph,
	type SessionEnd,
	watchEvents } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { ModelRuntime } from "../core/model-runtime.ts";
import { ModelScope, type ModelScopeConfig } from "../core/model-scope.ts";
import { resolveModelScopeWithDiagnostics } from "../core/model-resolver.ts";
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
	SessionViewDoc,
	type TreeNavigationDeps } from "./session-surface.ts";
import { abortArchivedForks } from "./fork-management.ts";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createCodingSettings,
	createHarnessSettings,
	ExecutionEnvs,
	findInitialAgentModel,
	initialThinkingLevel,
	loadCodingResources } from "./harness-setup.ts";
import type { CodingResourceOptions } from "./prompt.ts";
import { readReview, refreshReview } from "./insights/workspace-review.ts";
import { resumeRun } from "./insights/run-policy.ts";
import { RunStateDoc } from "./insights/state.ts";
import { expandResourceCommand } from "../core/resource-command.ts";
import type { ResourceLoader } from "../core/resource-loader.ts";
import { readDurableSessionCwd } from "./session-cwd.ts";
import { selectSession } from "./sessions.ts";
import { applyDurableMcpSelection, openDurableMcp, type DurableMcp } from "./mcp.ts";
import { Subagent } from "./subagent.ts";
import type { McpManagement } from "../core/mcp/management.ts";
import { NATIVE_COMMANDS } from "./commands.ts";
import { APP_COMMAND, APP_NAME, VERSION } from "../config.ts";
import { collectSettingsDiagnostics } from "../core/settings-diagnostics.ts";
import { normalizePromptImages } from "../utils/prompt-images.ts";
import { estimateContextTokens } from "../core/compaction/index.ts";

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
		readonly directory?: string;
		readonly cwd: string;
		readonly name?: string;
	};
	/** Startup banner lines shown at the top of the transcript. */
	readonly startup?: readonly string[];
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

/** One input's admitted submission and, for callers that wait, its settled receipt. */
export interface DurableCompactionResult {
	readonly summary: string;
	readonly firstKeptEntryId: string;
	readonly tokensBefore: number;
}

export interface DurableSubmissionRpc {
	readonly accepted: boolean;
	readonly disposition: "handled" | "queued" | "started";
}

export interface DurableSubmissionResult {
	readonly accepted: boolean;
	/** Absent for a plugin command, which resolves after the conversation is idle again. */
	readonly settled?: SettledSubmissionRecord;
	/** The committed answer, read back after its receipt rather than from a lagging view. */
	readonly answer?: AssistantMessage;
}

/** What the TUI may ask for. */
export interface DurableController {
	describePlugins?(): string;
	describeChanges?(args?: string): Promise<string | undefined>;
	runCommand(name: string, args: string): Promise<void>;
	completeCommand?(name: string, prefix: string): Promise<readonly SlashCommandCompletion[] | null>;
	/** Reload prompt resources and any selected application plugin facets while idle. */
	reload(): Promise<void>;
	readonly mcp?: McpManagement;
	readonly auth?: ProviderAuthManagement;
	/** Normalize and admit input to the current conversation; false means preparation/command rejection. */
	submit(text: string, whenBusy: "steer" | "followUp", images?: readonly ImageContent[]): Promise<boolean>;
	/**
	 * Normalize, admit, and wait for one input. Print/JSON/RPC use this instead of the TUI's
	 * fire-and-notice path, so a caller owns the receipt rather than reading notices.
	 */
	submitAndWait(text: string, whenBusy: "steer" | "followUp", images?: readonly ImageContent[]): Promise<DurableSubmissionResult>;
	/** Admit one input and report how it entered the run, without waiting for its answer. */
	submitForRpc(text: string, whenBusy: "steer" | "followUp", images?: readonly ImageContent[]): Promise<DurableSubmissionRpc>;
	compact(instructions: string | undefined): Promise<void>;
	abort(): Promise<void>;
	cycleThinking(): Promise<void>;
	setThinkingLevel(level: ModelThinkingLevel): Promise<void>;
	cycleModel(direction?: "forward" | "backward"): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	setSessionName(name: string): Promise<void>;
	getAvailableModels(): readonly Model<any>[];
	/** Like setModel(), but rejects the caller instead of turning the failure into a notice. */
	setModelNow(model: ModelRef): Promise<void>;
	/** Like setThinkingLevel(), but rejects the caller instead of turning the failure into a notice. */
	setThinkingLevelNow(level: ModelThinkingLevel): Promise<void>;
	/** Like compact(), but rejects the caller when admission fails. */
	compactNow(instructions: string | undefined): Promise<void>;
	/** Run a manual compaction and wait for its summary placement. */
	compactAndWait(instructions: string | undefined): Promise<DurableCompactionResult>;
	getModelScope(): ModelScopeConfig;
	setModelScope(models: readonly string[] | null, persist: boolean): Promise<void>;
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
	/** Fork the shown conversation at `entryId`, or at its newest entry when omitted. */
	forkAt(entryId?: string): Promise<void>;
	/** Withdraw queued steering and follow-up inputs, returning their text. */
	clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
	/** Page one older slice of stored history above the transcript. */
	loadOlder(): Promise<void>;
}

export interface OpenDurableOptions extends ToolSelectionOptions, CodingResourceOptions {
	readonly extensions?: readonly string[];
	readonly noExtensions?: boolean;
	/** Application-selected Chord facets; no plugin owner is started when absent. */
	readonly facetLoader?: FacetLoader;
	readonly cwd?: string;
	readonly continueSession?: boolean;
	readonly noSession?: boolean;
	readonly sessionDir?: string;
	/** Open one exact Durable session directory instead of creating or continuing one. */
	readonly sessionDirectory?: string;
	readonly name?: string;
	readonly provider?: string;
	readonly model?: string;
	/** Ordered model patterns for startup and cycling; falls back to enabledModels in settings. */
	readonly models?: readonly string[];
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
	/** The shown conversation's experimental agent events, for the headless JSON stream. */
	watchAgentEvents(): Promise<AgentEventStream>;
	/** The model catalog the session resolves against, for protocol clients that need full models. */
	availableModels(): readonly Model<any>[];
	/** pi's settings, for the TUI's theme and terminal capabilities. */
	readonly settings: SettingsManager;
	/** The same resource owner supplies the presentation's selected themes. */
	readonly resources: Pick<ResourceLoader, "getThemes">;
	close(): Promise<void>;
}

/** The agent document of a view; absent while the conversation has none. */
export function agentOf(view: ConversationView): AgentState {
	return (view.docs["amazme.agent"] ?? {}) as AgentState;
}

function inputText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null || !("type" in part)) return [];
			if (part.type === "text" && "text" in part && typeof part.text === "string") return [part.text];
			if (part.type === "image") return ["[Image]"];
			return [];
		})
		.join("\n");
}

export async function openDurable(input: OpenDurableOptions = {}): Promise<OpenDurableResult> {
	const error = getToolSelectionError(input);
	if (error !== undefined) throw new Error(`Invalid tools option: ${error}`);
	const options = { ...input, models: input.models?.slice(), tools: input.tools?.slice(), excludeTools: input.excludeTools?.slice() };
	const name = options.name?.trim();
	if (options.name !== undefined && !name) throw new Error("--name requires a non-empty value");
	if (options.noSession && options.continueSession) throw new Error("--no-session cannot be combined with --continue or --resume");
	if (options.provider !== undefined && options.model === undefined) throw new Error("--provider requires --model");
	if (options.apiKey !== undefined && options.model === undefined) throw new Error("--api-key requires --model");
	const sessionCwd = options.cwd === undefined && options.sessionDirectory !== undefined
		? await readDurableSessionCwd(resolve(options.sessionDirectory))
		: undefined;
	const cwd = await realpath(resolve(sessionCwd ?? options.cwd ?? process.cwd()));
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
			inlineApiKey: options.apiKey !== undefined,
			thinkingLevel: options.thinkingLevel });
	if (options.apiKey !== undefined && selected?.model !== undefined) {
		await modelRuntime.setRuntimeApiKey(selected.model.provider, options.apiKey);
	}
	const modelScope = new ModelScope(settingsManager, options.models ?? settingsManager.getEnabledModels() ?? null);
	const modelPatterns = () => modelScope.patterns ?? [];
	const scope = modelPatterns().length === 0
		? { scopedModels: [], diagnostics: [] }
		: await resolveModelScopeWithDiagnostics(modelPatterns(), modelRuntime, { signal: AbortSignal.timeout(15_000) });
	const initial = options.continueSession === true
		? undefined
		: selected ?? (await findInitialAgentModel(settingsManager, modelRuntime, undefined, scope.scopedModels));
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
	const resources = await loadCodingResources(settingsManager, cwd, options);
	const location = await selectSession(cwd, options.continueSession ?? false, {
		noSession: options.noSession,
		sessionDir: options.sessionDir ?? settingsManager.getSessionDir(),
		...(options.sessionDirectory === undefined ? {} : { sessionDirectory: options.sessionDirectory }) });
	const envs = new ExecutionEnvs(location.cwd, settingsManager);
	let harness: Harness | undefined;
	let mcp: DurableMcp | undefined;
	let plugins: PluginRuntime | undefined;
	let providerLogin: ProviderLogin | undefined;
	let disposeView = (): void => {};
	try {
		configureHarnessHttp(settingsManager);
		const settings = createHarnessSettings(settingsManager);
		const registry = createCodingRegistry(settingsManager, location.cwd, resources, async () => [location.cwd], location.directory === undefined ? undefined : join(location.directory, "artifacts", "review"));
		registry.install(Subagent);

		const pendingReports: unknown[] = [];
		let report: (error: unknown) => void = (error) => pendingReports.push(error);
		const activeMcp = await openDurableMcp({ registry, cwd: location.cwd, settings: settingsManager, models: modelRuntime, disabled: options.noMcp, report: error => report(error) });
		mcp = activeMcp;
		harness = await Harness.open(
			location.database === undefined ? new MemoryStorage() : await openNodeSqliteStorage(location.database),
			{
				models: modelRuntime,
				registry,
				settings,
				env: envs.env,
				onReport: (error) => report(error) },
			context,
		);
		const root = await harness.root(context, {
			agent: {
				cwd: location.cwd,
				...(initial?.model === undefined ? {} : { model: initial.model }),
				...(initialThinking === undefined ? {} : { thinkingLevel: initialThinking }) },
			init: async (tx, id) => {
				const agent = await tx.doc(AgentDoc, id);
				agent.tools = activeMcp.selection(toolSelection);
			} });
		const opened = harness;
		await abortArchivedForks(opened);
		if (name !== undefined) {
			await opened.commit(async (tx) => {
				(await tx.doc(SessionViewDoc)).name = name;
			}, context);
		}
		const sessionName = (await opened.snapshot(SessionViewDoc, context))?.name;
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
				contextWindow: model.contextWindow }));

		const laneNow = (value: ConversationView = conversation.value): LaneStatus =>
			laneFrom(
				value,
				state.conversations.find((summary) => String(summary.id) === String(current.id)) ?? {
					role: current.id === root.id ? "main" : "fork",
					label: String(current.id) },
			);
		let state: DurableView = {
			session: {
				id: location.id,
				...(location.directory === undefined ? {} : { directory: location.directory }),
				cwd: location.cwd,
				...(sessionName === undefined ? {} : { name: sessionName }) },
			conversation: conversation.value,
			conversations: summaries,
			lane: laneFrom(conversation.value, summaries.find((summary) => summary.root) ?? IDLE_LANE),
			history: [],
			historyMore: true,
			models: models(),
			notices: [] };
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
			const kept = level === "info" ? state.notices.filter((item) => item.level !== "info") : state.notices;
			update({
				notices: [...kept, { id: nextNotice++, level, message }].slice(-20) });
		};
		const clearNotices = (predicate: (item: Notice) => boolean): void => {
			const next = state.notices.filter((item) => !predicate(item));
			if (next.length !== state.notices.length) update({ notices: next });
		};
		const fail = (error: unknown): void => notice("error", error instanceof Error ? error.message : String(error));
		const reportPausedRun = async (): Promise<void> => {
			const id = current.id;
			const [policy, live] = await Promise.all([opened.snapshot(RunStateDoc, id, context), opened.snapshot(LiveDoc, id, context)]);
			if (current.id === id && policy?.paused && policy.run === String(live?.run?.inputs[0] ?? "")) notice("warning", "本轮预算已用完，已暂停于执行边界。/resume_run 追加预算继续，或按停止键取消。");
		};
		await reportPausedRun();
		const reportResources = (): void => {
			for (const diagnostic of [...resources.getSkills().diagnostics, ...resources.getPrompts().diagnostics, ...resources.getThemes().diagnostics]) {
				notice(diagnostic.type === "error" ? "error" : "warning", `${diagnostic.path === undefined ? "" : `${diagnostic.path}: `}${diagnostic.message}`);
			}
		};
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
				if (change.type === "document" && change.conversationId === current.id && change.record.kind === RunStateDoc.definition.kind
					&& change.value?.paused && change.ops.some(op => Array.isArray(op[1]) && op[1][0] === "paused")) notice("warning", "本轮预算已用完，已暂停于执行边界。/resume_run 追加预算继续，或按停止键取消。");
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
		let inputGeneration = 0;
		// One at a time, so toggles, switches, and key presses apply in order.
		const command = (operation: () => Promise<void>): Promise<void> => {
			queue = queue.then(() => {
				if (closing !== undefined) throw new Error("Session is closing");
				return operation();
			}).catch(fail);
			return queue;
		};
		// A queued operation whose failure belongs to the caller, not to the TUI's notice list.
		const commandResult = <T>(operation: () => Promise<T>): Promise<T> => {
			const result = queue.then(() => {
				if (closing !== undefined) throw new Error("Session is closing");
				return operation();
			});
			queue = result.then(() => undefined, fail);
			return result;
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
				...(auth?.env === undefined ? {} : { env: auth.env }) };
		};
		let leaveAbort: AbortController | undefined;
		const selectModel = async (ref: ModelRef, thinkingLevel?: ModelThinkingLevel): Promise<void> => {
			const model = modelRuntime.getModel(ref.provider, ref.modelId);
			if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
			if (!(await modelRuntime.checkAuth(model.provider))) throw new Error(`No API key for ${ref.provider}/${ref.modelId}`);
			await current.configure({
				model: ref,
				thinkingLevel: initialThinkingLevel(settingsManager, model, thinkingLevel, agentOf(state.conversation).thinkingLevel) }, context);
			clearNotices(
				(item) =>
					item.message === "No model configured; select one with /model." ||
					item.message.startsWith("Saved model is unavailable: "),
			);
		};
		const selectThinking = async (value: string): Promise<void> => {
			const levels = getSupportedThinkingLevels(agentModel());
			const level = levels.find((candidate) => candidate === value.toLowerCase());
			if (level === undefined) throw new Error(`Unknown thinking level "${value}". Available: ${levels.join(", ")}.`);
			await current.configure({ thinkingLevel: level }, context);
		};
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
				lane: laneNow() });
			await reportPausedRun();
		};
		const pluginCommands = facetLoader === undefined ? undefined : new SlashCommandRegistry(NATIVE_COMMANDS.map(({ name }) => name));
		const reservedCommands = new Set<string>(NATIVE_COMMANDS.map(({ name }) => name));
		const publishCommands = (): void => {
			const contributed = pluginCommands?.list() ?? [];
			const taken = new Set([...reservedCommands, ...contributed.map(({ name }) => name)]);
			const templates = resources.getPrompts().prompts
				.filter(({ name }) => !taken.has(name))
				.map(({ name, description, argumentHint }) => ({ name, description, argumentHint }));
			for (const { name } of templates) taken.add(name);
			const skills = settingsManager.getEnableSkillCommands()
				? resources.getSkills().skills.flatMap(({ name, description }) => taken.has(`skill:${name}`) ? [] : [{ name: `skill:${name}`, description, argumentHint: "[args]" }])
				: [];
			update({ commands: [...contributed, ...templates, ...skills].map(({ name, description, argumentHint }) => ({ name, description, argumentHint })) });
		};
		let unsubscribeCommands = (): void => {};
		if (facetLoader !== undefined) {
			if (sources.length > 0) registry.install({ name: "plugin-development", sections: [section("plugin_development", () => describePluginSources(sources))] });
			const controllerFacet = serviceSetFacet(
				"@amazme/agent-controller-runtime",
				[AgentRuntime, AgentController],
				[],
				async (services) => {
					const values = new Map<ApplicationService, unknown>();

					const provided0: ServiceValue<typeof AgentRuntime> = createAgentRuntime(
						opened,
						() => current.id,
						() => plugins?.changing !== false,
					);
					values.set(AgentRuntime, provided0);
					const provided1: ServiceValue<typeof AgentController> = createAgentController(
						opened,
						() => current,
						() =>
							plugins?.changing !== false
								? { code: "plugins_reloading", message: "Plugins are unavailable; finish reloading or restart the session" }
								: undefined,
					);
					values.set(AgentController, provided1);

					return { value: values };
				},
			);
			plugins = await openPluginRuntime(
				[createAgentExtensionsFacet(registry), createSlashCommandsRuntimeFacet(pluginCommands!), controllerFacet],
				facetLoader,
				async () => {
					await assertPluginsIdle(opened);
					await resources.reload();
				},
			);
			unsubscribeCommands = pluginCommands!.subscribe(publishCommands);
		}
		publishCommands();
		const expandInput = (text: string): string => {
			const invocation = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text);
			if (invocation === null || reservedCommands.has(invocation[1]!)) return text;
			const name = invocation[1]!;
			if (!name.startsWith("skill:") && !resources.getPrompts().prompts.some((template) => template.name === name)) return text;
			const expanded = expandResourceCommand({ templates: resources.getPrompts().prompts, skills: resources.getSkills().skills }, name, invocation[2] ?? "");
			if (!expanded.ok) throw new Error(expanded.problem);
			return expanded.prompt;
		};
		const runPluginCommand = async (selected: SlashCommandContribution, args: string): Promise<void> => {
			const operation = new AbortController();
			activeCommand = operation;
			notice("info", `Running /${selected.name}`);
			try {
				const outcome = await selected.run(args, withAbortSignal(operation.signal, context));
				if (outcome?.accepted === false) throw new Error(outcome.error.message);
				notice("info", `${operation.signal.aborted ? "Cancelled" : "Ran"} /${selected.name}`);
			} catch (error) {
				if (operation.signal.aborted) notice("info", `Cancelled /${selected.name}`);
				else throw error;
			} finally {
				if (activeCommand === operation) activeCommand = undefined;
			}
		};
	const prepareSubmission = async (text: string, whenBusy: "steer" | "followUp", images: readonly ImageContent[] = []): Promise<Submission | undefined> => {
			if (plugins?.changing) throw new Error("Plugins are unavailable; finish reloading or restart the session");
			const invocation = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text);
			const selected = invocation === null ? undefined : pluginCommands?.list().find(({ name }) => name === invocation[1]);
			if (selected !== undefined) {
				if (images.length > 0) throw new Error("Plugin commands do not accept attached images; submit a prompt or clear the attachments first.");
				await runPluginCommand(selected, invocation?.[2] ?? "");
				return undefined;
			}
			let expanded = expandInput(text);
			clearNotices((item) => item.level === "info");
			if (images.length === 0) return current.submit({ type: "input", content: expanded, whenBusy }, context);
			const operation = new AbortController();
			activeCommand = operation;
			try {
				const ref = agentOf(state.conversation).model;
				const model = ref === undefined ? undefined : modelRuntime.getModel(ref.provider, ref.modelId);
				const normalized = await normalizePromptImages(images, {
					autoResizeImages: settingsManager.getImageAutoResize(),
					resizeOptions: model?.inputLimits?.images?.resize }, operation.signal);
				if (normalized.hints.length > 0) expanded += `\n\n${normalized.hints.join("\n")}`;
				const content: (TextContent | ImageContent)[] = [{ type: "text", text: expanded }, ...normalized.images];
				operation.signal.throwIfAborted();
				return await current.submit({ type: "input", content, whenBusy }, context);
			} finally {
				if (activeCommand === operation) activeCommand = undefined;
			}
		};
		const submitInput = async (text: string, whenBusy: "steer" | "followUp", images: readonly ImageContent[] = []): Promise<void> => {
			const submission = await prepareSubmission(text, whenBusy, images);
			if (submission !== undefined) watchAnswer(submission);
		};
		const describeChanges = async (args = ""): Promise<string> => {
			await refreshReview(opened, current.id, context);
			const review = await readReview(opened, current.id, context);
			const query = args.trim();
			const selected = review.files.filter((file) => file.path === query || `${file.root}/${file.path}` === query);
			return query
				? selected.map((file) => file.diff).join("\n") || "没有匹配的变更文件。"
				: [
						"本轮工作区变更（可能包含人工并发修改）：",
						...review.files.map((file) => `${file.root}/${file.path} +${file.added} -${file.removed}`),
						...(review.state?.notes ?? []),
						...(review.state?.verification ?? []).map(
							(item) => `${item.command}: ${item.exitCode === null ? "结果未知" : `退出码 ${item.exitCode}`}`,
						),
						`跳过 ${review.state?.skipped ?? 0} 个文件；/changes 文件路径 查看差异。`,
					].join("\n");
		};
		const controller: DurableController = {
			setSessionName: (sessionName) => commandResult(async () => {
				const trimmed = sessionName.trim();
				if (!trimmed) throw new Error("Session name cannot be empty");
				await opened.commit(async (tx) => {
					(await tx.doc(SessionViewDoc)).name = trimmed;
				}, context);
				update({ session: { ...state.session, name: trimmed } });
			}),
			auth,
			...(plugins === undefined ? {} : {
				describePlugins: () => sources.length === 0 ? "Plugins use the application-provided facet loader" : describePluginSources(sources) }),
			describeChanges: async (args = "") => {
				let output: string | undefined;
				await command(async () => {
					output = await describeChanges(args);
				});
				return output;
			},
			completeCommand: async (name, prefix) => {
				const query = prefix.toLowerCase();
				if (name === "model") return modelScope.resolve(modelRuntime.getAvailableSnapshot()).map(({ model }) => model)
					.filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query))
					.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name, description: model.provider }));
				if (name === "thinking") return getSupportedThinkingLevels(agentModel())
					.filter((level) => level.includes(query)).map((level) => ({ value: level, label: level }));
				return plugins?.changing ? null : await pluginCommands?.list().find((entry) => entry.name === name)?.getArgumentCompletions?.(prefix) ?? null;
			},
			runCommand: (name, args) => command(async () => {
				if (name === "model") {
					const query = args.trim().toLowerCase();
					const matches = modelRuntime.getAvailableSnapshot().filter((model) =>
						`${model.provider}/${model.id}`.toLowerCase() === query || model.id.toLowerCase() === query);
					const selected = matches[0];
					if (matches.length !== 1 || selected === undefined) throw new Error(matches.length === 0 ? `Unknown model: ${args}` : `Ambiguous model: ${args}. Use provider/model.`);
					await selectModel({ provider: selected.provider, modelId: selected.id });
					return;
				}
				if (name === "thinking") { await selectThinking(args.trim()); return; }
				if (name === "changes") {
					notice("info", await describeChanges(args));
					return;
				}
				if (name === "resume_run") {
					await resumeRun(opened, current.id, context);
					clearNotices((item) => item.message.startsWith("本轮预算已用完"));
					notice("info", "已允许继续当前回合。");
					return;
				}
				if (name === "limits") {
					if (args.trim()) {
						const parts = args.trim().split(/\s+/).map(Number);
						if (parts.length !== 3 || !parts.every(value => Number.isFinite(value) && value >= 0) || !parts.slice(0, 2).every(Number.isSafeInteger)) throw new Error("用法：/limits 工具次数 秒数 美元；0 表示不限。");
						settingsManager.setRunLimits({ calls: parts[0], seconds: parts[1], cost: parts[2] }); await settingsManager.flush();
					}
					const limits = settingsManager.getSettings().runLimits;
					notice("info", `单个对话每轮预算：工具 ${limits?.calls ?? 0} 次，${limits?.seconds ?? 0} 秒，$${limits?.cost ?? 0}；0 表示不限。暂停后 /resume_run 继续。`); return;
				}
				if (name === "execution") {
					const mode = args.trim();
					if (mode && mode !== "full-access" && mode !== "workspace-write" && mode !== "read-only") throw new Error("用法：/execution full-access|workspace-write|read-only");
					if (mode) { settingsManager.setExecutionMode(mode as "full-access" | "workspace-write" | "read-only"); await settingsManager.flush(); }
					notice("info", `执行模式：${settingsManager.getSettings().executionMode ?? "full-access"}。限制模式约束文件写入，不限制读取和网络；从下一次工具执行生效。`); return;
				}
				if (reservedCommands.has(name) || !state.commands?.some((candidate) => candidate.name === name)) throw new Error(`Unknown command: /${name}`);
				await submitInput(`/${name}${args.length === 0 ? "" : ` ${args}`}`, "steer");
			}),
			reload: () => command(async () => {
				if (plugins === undefined) {
					await assertPluginsIdle(opened);
					await resources.reload();
				} else await plugins.reload();
				publishCommands();
				reportResources();
				notice("info", plugins === undefined ? "Reloaded prompt resources" : "Reloaded prompt resources and plugins");
			}),
			mcp: activeMcp.management,
			submit: async (text, whenBusy, images) => {
				const copied = images?.map((image) => ({ ...image }));
				const generation = inputGeneration;
				let accepted = false;
				await command(async () => {
					if (generation !== inputGeneration) throw new Error("Input preparation cancelled");
					await submitInput(text, whenBusy, copied);
					accepted = true;
				});
				return accepted;
			},
			submitForRpc: async (text, whenBusy, images) => {
				const copied = images?.map((image) => ({ ...image }));
				const generation = inputGeneration;
				const submission = await commandResult(() => prepareSubmission(text, whenBusy, copied));
				if (generation !== inputGeneration) throw new Error("Input preparation cancelled");
				if (submission === undefined) return { accepted: true, disposition: "handled" };
				const record = await submission.status(context);
				return { accepted: true, disposition: record.status === "queued" ? "queued" : "started" };
			},
			submitAndWait: async (text, whenBusy, images) => {
				const copied = images?.map((image) => ({ ...image }));
				const generation = inputGeneration;
				const submission = await commandResult(() => prepareSubmission(text, whenBusy, copied));
				if (generation !== inputGeneration) throw new Error("Input preparation cancelled");
				if (submission === undefined) {
					await opened.waitForIdle(context);
					return { accepted: true };
				}
				const settled = await submission.wait(context);
				if (settled.status !== "done" || settled.answer === undefined) return { accepted: true, settled };
				const transcript = await current.context(context);
				const message = transcript.entries.find((entry) => entry.id === settled.answer)?.model?.[0];
				return message?.role === "assistant" ? { accepted: true, settled, answer: message } : { accepted: true, settled };
			},
			compactAndWait: (instructions) =>
				commandResult(async () => {
					if (plugins?.changing) throw new Error("Plugins are unavailable; finish reloading or restart the session");
					const before = await current.context(context);
					const tokensBefore = estimateContextTokens([...before.messages]).tokens;
					const taskId = await current.compact(instructions, context);
					const receipt = await opened.waitForTask(taskId, context);
					const outcome = receipt.state.outcome;
					if (outcome.status !== "completed") throw new Error(`Compaction ${outcome.status}`);
					const { entryId, submissionId } = outcome.result;
					let id = entryId;
					if (id === undefined && submissionId !== undefined) {
						const placed = await (await opened.submission(submissionId, context))?.status(context);
						if (placed?.status === "done") id = placed.entry;
					}
					if (id === undefined) return { summary: "", firstKeptEntryId: "", tokensBefore };
					const entry = (await current.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, context)).items[0];
					if (entry === undefined) return { summary: "", firstKeptEntryId: "", tokensBefore };
					const first = entry.model?.[0];
					let text = "";
					if (first?.role === "user") {
						text = typeof first.content === "string"
							? first.content
							: first.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
					}
					const start = text.indexOf("<summary>\n");
					const end = text.lastIndexOf("\n</summary>");
					return {
						summary: start < 0 || end < start ? text : text.slice(start + "<summary>\n".length, end),
						firstKeptEntryId: entry.head === undefined ? "" : String(entry.head),
						tokensBefore,
					};
				}),
			compactNow: (instructions) =>
				commandResult(async () => {
					if (plugins?.changing) throw new Error("Plugins are unavailable; finish reloading or restart the session");
					await current.compact(instructions, context);
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
				++inputGeneration;
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
					await selectThinking(next);
				}),
			setModel: (ref) => command(() => selectModel(ref)),
			setModelNow: (ref) => commandResult(() => selectModel(ref)),
			setThinkingLevel: (level) => command(() => selectThinking(level)),
			setThinkingLevelNow: (level) => commandResult(() => selectThinking(level)),
			getModelScope: () => modelScope.configuration(modelRuntime.getAvailableSnapshot()),
			getAvailableModels: () => modelRuntime.getAvailableSnapshot(),
			setModelScope: async (ids, persist) => {
				if (closing !== undefined) throw new Error("Session is closing");
				await modelScope.configure(ids, persist);
				update({ models: models() });
			},
			cycleModel: (direction = "forward") => command(async () => {
				const available = modelRuntime.getAvailableSnapshot();
				const choices = modelScope.resolve(available);
				if (choices.length === 0) return;
				const ref = agentOf(state.conversation).model;
				const index = choices.findIndex(({ model }) => model.provider === ref?.provider && model.id === ref.modelId);
				if (choices.length === 1 && index === 0) return;
				const next = choices[index < 0 ? 0 : (index + (direction === "forward" ? 1 : choices.length - 1)) % choices.length]!;
				await selectModel({ provider: next.model.provider, modelId: next.model.id }, next.thinkingLevel);
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
								...(choice.customInstructions === undefined ? {} : { customInstructions: choice.customInstructions }) },
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
			forkAt: (entryId) =>
				command(async () => {
					const created = await forkAt(opened, String(current.id), entryId ?? null, context);
					await show(created.id);
				}),
			clearQueue: () =>
				commandResult(async () => {
					const state = await current.viewState(context);
					try {
						const inbox = state.value.docs["amazme.inbox"] as { items?: readonly InboxItem[] } | undefined;
						const steering: string[] = [];
						const followUp: string[] = [];
						for (const item of inbox?.items ?? []) {
							if (item.mode !== "steer" && item.mode !== "followUp") continue;
							const text = inputText(item.content);
							const outcome = await opened.cancelPrompt(item.id, context, current.id);
							if (outcome !== "cancelled") continue;
							(item.mode === "steer" ? steering : followUp).push(text);
						}
						return { steering, followUp };
					} finally {
						state.dispose();
					}
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
						historyMore: historyCursor !== null });
				}) };

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
					...(thinkingLevel === undefined ? {} : { thinkingLevel }) },
				context,
			);
		}
		const startup: string[] = [];
		if (settingsManager.getQuietStartup() !== true) startup.push(`${APP_NAME} v${VERSION}`);
		if (settingsManager.getQuietStartup() === false) {
			startup.push(`Loaded resources: ${resources.getAgentsFiles().agentsFiles.length} context files, ${resources.getSkills().skills.length} skills, ${resources.getPrompts().prompts.length} templates, ${resources.getThemes().themes.length} themes, ${sources.length} plugin sources`);
			if (modelPatterns().length > 0) startup.push(`Model scope: ${modelPatterns().join(", ")}`);
		}
		if (initial?.fallbackMessage !== undefined) startup.push(initial.fallbackMessage);
		if (startup.length > 0) update({ startup });
		for (const diagnostic of collectSettingsDiagnostics(settingsManager)) notice(diagnostic.type, diagnostic.message);
		const modelError = modelRuntime.getError();
		if (modelError !== undefined) notice("warning", `Model configuration or availability has errors; run ${APP_COMMAND} doctor for local diagnostics.`);
		const saved = agentOf(state.conversation).model;
		if (saved === undefined) notice("warning", "No model configured; select one with /model.");
		else if (modelRuntime.getModel(saved.provider, saved.modelId) === undefined) {
			notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
		}
		for (const diagnostic of scope.diagnostics) notice("warning", diagnostic.message);
		reportResources();
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
				} },
			controller,
			watchAgentEvents: () => watchEvents(opened, current.id, context),
			availableModels: () => modelRuntime.getAvailableSnapshot(),
			settings: settingsManager,
			resources,
			close() {
				closing ??= (async () => {
					activeCommand?.abort(new Error("Session closing"));
					disposeView();
					try {
						await auth.close();
						await modelScope.flush();
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
			} };
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
