import { ChannelEndpoint, type ChannelCall } from "@amazme/protocol";
import { serviceFacet, serviceSetFacet, type ApplicationService, type ServiceValue, disposeResources } from "@amazme/protocol/services";
import { replicatedState } from "@amazme/chord";
import { join } from "node:path";
import {
	type Context,
	type FacetLoader,
	type JsonValue,
	type Frame } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { Conversation, ConversationId, Harness, Registry } from "@amazme/durable";
import type { ExecutionEnv } from "@amazme/durable/env";
import type { AgentOperationError } from "../../core/plugins/agent-controller.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { ProviderLogin } from "../../core/provider-login.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { ResourceLoader } from "../../core/resource-loader.ts";
import { configureHarnessHttp, refreshCodingProjectTrust } from "../../durable/harness-setup.ts";
import { createAgentExtensionsFacet } from "../../core/plugins/agent-extensions.ts";
import { AgentRuntime, createAgentRuntime } from "../../core/plugins/agent-runtime.ts";
import { Conversations } from "./conversations.ts";
import { assertPluginsIdle, openPluginRuntime, type PluginRuntime } from "../../core/plugins/runtime.ts";
import { AgentController } from "../../core/plugins/agent-controller.ts";
import { createAgentController } from "../../core/plugins/agent-controller-provider.ts";
import { createCommandsFacet } from "./commands-provider.ts";
import { createToolReloadTracker, reloadConversationResources } from "../../durable/tool-activation.ts";
import { durableToolSelection } from "../../core/tool-selection.ts";
import { createApprovalsFacet, type ApprovalGate } from "./approvals-provider.ts";
import { createConversationsFacet, summaryModelFromRuntime } from "./conversations-provider.ts";
import { createModelsServiceFacet } from "./models-provider.ts";
import type { McpManagement } from "../../core/mcp/management.ts";
import { createMcpFacet } from "./mcp-provider.ts";
import { SessionPlugins } from "./plugins.ts";
import { NATIVE_COMMANDS } from "../../durable/commands.ts";
import { createSlashCommandsRuntimeFacet, SlashCommandRegistry } from "../../core/plugins/command-registry.ts";
import { createShareCommandFacet } from "./share-command.ts";
import { SessionSettings } from "./settings.ts";
import { publishSettings, settingsErrors, settingsSnapshot } from "./settings-provider.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { SessionMirror } from "./session-mirror.ts";
import type { SessionMirrorStatus } from "./session-mirror.ts";
import { abortSessionWork, hasSessionWork, isSessionEmpty } from "../session-lifecycle.ts";
import { createTerminalFacet } from "./terminal-provider.ts";
import { Terminal } from "./terminal.ts";
import { createTranscriptServiceFacet } from "./transcript-provider.ts";
import { createWorkspaceFacet } from "./workspace-provider.ts";
import { createInsightsFacet } from "./insights-provider.ts";

export interface SessionWorkerRuntime {
	readonly admission?: (context: Context) => Promise<AgentOperationError | undefined>;
	readonly executionEnv?: ExecutionEnv;
	readonly stopExecution?: (context: Context) => Promise<void>;
	/** The working directory the Session's agent runs in: the workspace and terminal root. */
	readonly cwd: string;
	readonly workspaceDirectories?: () => Promise<readonly string[]>;
	readonly harness: Harness;
	readonly registry?: Registry;
	/** The root conversation the services expose. */
	readonly conversation: Conversation;
	readonly modelRuntime?: ModelRuntime;
	readonly settingsManager?: SettingsManager;
	readonly resources?: ResourceLoader;
	readonly mcp?: McpManagement;
	/** Widen the focused conversation's tool allow-list after MCP connections reload. */
	alignConversation?(conversation: Conversation, context: Context): Promise<void>;
	/** The tool boundary's approval gate, when the worker installed one. */
	readonly approvalGate?: ApprovalGate;
	readonly facetLoader?: FacetLoader;
	/** Release resources the Harness does not own, such as execution environments, after it closed. */
	cleanup?(context: Context): Promise<void>;
}

export interface WorkerServiceScope {
	readonly serverConnectionId: string;
	readonly attachmentId: string;
}

interface ScopedServiceEndpoint {
	readonly scope: WorkerServiceScope;
	readonly endpoint: ChannelEndpoint;
}

export interface SessionWorkerServices {
	invoke(call: ChannelCall, scope: WorkerServiceScope, context: Context): Promise<JsonValue | undefined>;
	closeChannels(matches: (scope: WorkerServiceScope) => boolean): Promise<void>;
	dispose(): Promise<void>;
	authenticationActive(): boolean;
	subscribeAuthentication(listener: () => void): () => void;
}

export async function createSessionWorkerServices(options: {
	readonly admission?: (context: Context) => Promise<AgentOperationError | undefined>;
	readonly executionEnv?: ExecutionEnv;
	readonly stopExecution?: (context: Context) => Promise<void>;
	readonly cwd: string;
	readonly workspaceDirectories?: () => Promise<readonly string[]>;
	readonly harness: Harness;
	readonly registry?: Registry;
	readonly conversation: Conversation;
	readonly modelRuntime: ModelRuntime | undefined;
	readonly settingsManager?: SettingsManager;
	readonly resources?: ResourceLoader;
	readonly mcp?: McpManagement;
	/** Widen the focused conversation's tool allow-list after MCP connections reload. */
	readonly alignConversation?: (conversation: Conversation, context: Context) => Promise<void>;
	/** The tool boundary's approval gate, when the worker installed one. */
	readonly approvalGate?: ApprovalGate;
	readonly facetLoader?: FacetLoader;
	publish(scope: WorkerServiceScope, subscriptionId: string, update: Frame | undefined): Promise<void>;
}): Promise<SessionWorkerServices> {
	let pluginRuntime: PluginRuntime | undefined;
	const settingsManager = options.settingsManager;
	const toolReload = settingsManager === undefined
		? undefined
		: createToolReloadTracker(durableToolSelection({}, settingsManager.getDefaultTools(), settingsManager.getSettings().defaultTools));
	let focusedConversation = (_context: Context): Promise<Conversation> => Promise.resolve(options.conversation);
	const authentication = options.modelRuntime === undefined ? undefined : new ProviderLogin(options.modelRuntime,
		options.settingsManager === undefined ? {} : { getDeviceId: () => options.settingsManager!.getOrCreateDeviceId() });
	const agentControllerRuntimeFacet = serviceSetFacet(
		"@pi/agent-controller-runtime",
		[AgentRuntime, AgentController, SessionLifecycle, SessionMirror],
		[Conversations, ...(options.settingsManager === undefined ? [] : [Terminal])],
		async (services) => {
			const values = new Map<ApplicationService, unknown>();
			const disposers: Array<() => void | Promise<void>> = [];
			try {
				const conversations = services.get(Conversations);
				const terminal = options.settingsManager === undefined ? undefined : services.get(Terminal);
				const runtime = createAgentRuntime(
					options.harness,
					() => Number(conversations.state.value?.selected ?? options.conversation.id) as ConversationId,
					() => pluginRuntime?.changing === true,
				);
				focusedConversation = (context) => runtime.current(context).then((value) => value.conversation);
				const provided0: ServiceValue<typeof AgentRuntime> = runtime;
				values.set(AgentRuntime, provided0);
				const provided1: ServiceValue<typeof AgentController> = createAgentController(
					options.harness,
					async (context) => (await runtime.current(context)).conversation,
					async (context) =>
						pluginRuntime?.changing === true
							? { code: "plugins_reloading", message: "Plugins are unavailable; finish reloading or restart the session" }
							: options.admission?.(context),
				);
				values.set(AgentController, provided1);
				const provided2: ServiceValue<typeof SessionLifecycle> = {
					isEmpty: (context) => isSessionEmpty(options.harness, context),
					hasWork: async context => authentication?.active === true || pluginRuntime?.changing === true || terminal?.state.value?.status === "running" || await hasSessionWork(options.harness, context),
					refreshMirror: async () => {},
					async stopWork(context) {
						await conversations.cancelSummaries(context);
						await terminal?.stop(context);
						await abortSessionWork(options.harness, context);
						await options.stopExecution?.(context);
					},
				};
				values.set(SessionLifecycle, provided2);
				const mirrorState = replicatedState<SessionMirrorStatus>({ warning: null });
				const provided3: ServiceValue<typeof SessionMirror> = { state: mirrorState };
				values.set(SessionMirror, provided3);

				return { value: values, close: () => disposeResources(disposers) };
			} catch (error) {
				await disposeResources(disposers);
				throw error;
			}
		},
	);
	let reloadPlugins = (): Promise<void> => Promise.reject(new Error("Session plugins are not ready"));
	const pluginRuntimeFacet = serviceFacet("@pi/session-plugins-runtime", SessionPlugins, [], async (services) => {
		const implementation: ServiceValue<typeof SessionPlugins> = { reload: () => reloadPlugins() };

		return { value: implementation };
	});
	// A settings change made by another process (the web client, another CLI) reaches this Session
	// through a reload; the worker otherwise keeps the copy it loaded when it started.
	const settingsRuntimeFacet =
		settingsManager === undefined
			? undefined
			: serviceFacet("@pi/session-settings-runtime", SessionSettings, [], async (services) => {
				const agentDir = getAgentDir();
				const paths = {
					global: join(agentDir, "settings.json"),
					project: join(options.cwd, CONFIG_DIR_NAME, "settings.json"),
				};
				const snapshot = () => ({
					manager: settingsManager,
					agentDir,
					cwd: options.cwd,
					paths,
					errors: settingsErrors(settingsManager),
				});
				const state = replicatedState({ revision: 0, ...settingsSnapshot(snapshot()) });
				let tail = Promise.resolve();
				const implementation: ServiceValue<typeof SessionSettings> = {
					state,
					reload: (context) => {
						const operation = tail.then(async () => {
							context.abortSignal?.throwIfAborted();
							await (options.resources?.reload() ?? settingsManager.reload());
							if (refreshCodingProjectTrust(settingsManager, options.cwd)) await options.resources?.reload();
							configureHarnessHttp(settingsManager);
							publishSettings(state, context, snapshot());
						});
						tail = operation.catch(() => {});
						return operation;
					},
				};

				return { value: implementation };
			});
	const builtins = [
		agentControllerRuntimeFacet,
		...(options.registry === undefined ? [] : [createAgentExtensionsFacet(options.registry)]),
		pluginRuntimeFacet,
		// Plugins register their commands here, and the catalogue lists them: one command surface for
		// the terminal client, the page, and a desktop client.
		// /share is registered by the host facet below. Reserving the name makes that registration fail.
		createSlashCommandsRuntimeFacet(new SlashCommandRegistry(NATIVE_COMMANDS.filter((command) => command.name !== "share").map((command) => command.name))),
		createShareCommandFacet({
			conversation: options.conversation,
			cwd: options.cwd,
			destination: () => options.settingsManager?.getSessionShareDestination() ?? "auto",
			...(options.modelRuntime === undefined ? {} : { modelRuntime: options.modelRuntime }),
		}),
		...(settingsRuntimeFacet === undefined ? [] : [settingsRuntimeFacet]),
		await createModelsServiceFacet({ ...options, authentication, context: BACKGROUND_CONTEXT }),
		...(options.mcp === undefined ? [] : [createMcpFacet(options.mcp)]),
		await createTranscriptServiceFacet(options.conversation, BACKGROUND_CONTEXT),
		createCommandsFacet({
			cwd: options.cwd,
			settings: options.settingsManager,
			resourceLoader: options.resources,
			onReloaded: async (context) => {
				await reloadConversationResources({
					context,
					settings: settingsManager,
					mcp: options.mcp,
					conversation: await focusedConversation(context),
					tracker: toolReload,
					align: options.alignConversation,
				});
			},
		}),
		createConversationsFacet({
			admission: options.admission,
			harness: options.harness,
			root: options.conversation,
			...(options.settingsManager === undefined ? {} : { settings: options.settingsManager }),
			...(options.modelRuntime === undefined
				? {}
				: { summaryModel: summaryModelFromRuntime(options.harness, options.modelRuntime) }) }),
		...(options.approvalGate === undefined ? [] : [createApprovalsFacet(options.approvalGate)]),
		createWorkspaceFacet({ cwd: options.cwd, directories: options.workspaceDirectories }),
		...(options.registry === undefined ? [] : [createInsightsFacet(options.harness, options.conversation.id, options.admission)]),
		...(options.settingsManager === undefined
			? []
			: [createTerminalFacet({ cwd: options.cwd, settings: options.settingsManager, env: options.executionEnv, admission: options.admission })]),
	];
	const pluginLoader = options.facetLoader ?? (async () => []);
	try {
		pluginRuntime = await openPluginRuntime(builtins, pluginLoader, async () => {
			await assertPluginsIdle(options.harness);
			await options.resources?.reload();
		});
	} catch (error) {
		await authentication?.close();
		throw error;
	}
	reloadPlugins = () => pluginRuntime!.reload();
	const provider = pluginRuntime.services;

	const endpoints = new Map<string, ScopedServiceEndpoint>();
	const retiring = new Set<{ scope: WorkerServiceScope; closed: Promise<void> }>();
 const closeChannels = async (matches: (scope: WorkerServiceScope) => boolean): Promise<void> => {
  for (const [key, entry] of endpoints) {
   if (!matches(entry.scope)) continue;
   endpoints.delete(key);
   const retirement = { scope: entry.scope, closed: entry.endpoint.dispose() };
   retiring.add(retirement);
   void retirement.closed.finally(() => retiring.delete(retirement)).catch(() => {});
  }
  const results = await Promise.allSettled([...retiring].filter(entry => matches(entry.scope)).map(entry => entry.closed));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "Session channel cleanup failed");
 };

	return {
		authenticationActive: () => authentication?.active ?? false,
		subscribeAuthentication: (listener) => authentication?.subscribe(listener) ?? (() => {}),
		invoke(call, scope, context) {
			const key = serviceScopeKey(scope);
			let entry = endpoints.get(key);
			if (entry === undefined) {
				entry = { scope, endpoint: new ChannelEndpoint(provider.host, () => provider.catalogue.filter(entry => !entry.local)) };
				endpoints.set(key, entry);
			}
			return entry.endpoint.invoke(
				call,
				(subscriptionId, update) => options.publish(scope, subscriptionId, update),
				context,
			);
		},
		closeChannels,
		async dispose() {
			await closeChannels(() => true);
			try { await authentication?.close(); await options.settingsManager?.flush(); }
			finally { await pluginRuntime!.close(); }
		} };
}

function serviceScopeKey(scope: WorkerServiceScope): string {
	return `${scope.serverConnectionId}\0${scope.attachmentId}`;
}
