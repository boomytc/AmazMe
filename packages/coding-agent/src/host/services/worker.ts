import {
	type Context,
	createRemoteServiceEndpoint,
	createStaticFacetLoader,
	defineFacet,
	type FacetLoader,
	type JsonValue,
	type RemoteServiceEndpoint,
	type ServiceCall,
	type ServiceProviderUpdate,
} from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { Conversation, ConversationId, Harness, Registry } from "@amazme/durable";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { ProviderLogin } from "../../core/provider-login.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { ResourceLoader } from "../../core/resource-loader.ts";
import { configureHarnessHttp } from "../../durable/harness-setup.ts";
import { createAgentExtensionsFacet } from "../../core/plugins/agent-extensions.ts";
import { AgentRuntime, createAgentRuntime } from "../../core/plugins/agent-runtime.ts";
import { Conversations } from "./conversations.ts";
import { assertPluginsIdle, openPluginRuntime, type PluginRuntime } from "../../core/plugins/runtime.ts";
import { AgentController } from "../../core/plugins/agent-controller.ts";
import { createAgentController } from "../../core/plugins/agent-controller-provider.ts";
import { createCommandsFacet } from "./commands-provider.ts";
import { createApprovalsFacet, type ApprovalGate } from "./approvals-provider.ts";
import { createConversationsFacet, summaryModelFromRuntime } from "./conversations-provider.ts";
import { createModelsServiceFacet } from "./models-provider.ts";
import type { McpManagement } from "../../core/mcp/management.ts";
import { createMcpFacet } from "./mcp-provider.ts";
import { SessionPlugins } from "./plugins.ts";
import { createSlashCommandsRuntimeFacet } from "../../core/plugins/command-registry.ts";
import { SessionSettings } from "./settings.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { isSessionEmpty } from "../session-lifecycle.ts";
import { createTerminalFacet } from "./terminal-provider.ts";
import { createTranscriptServiceFacet } from "./transcript-provider.ts";
import { createWorkspaceFacet } from "./workspace-provider.ts";

export interface SessionWorkerRuntime {
	/** The working directory the Session's agent runs in: the workspace and terminal root. */
	readonly cwd: string;
	readonly harness: Harness;
	readonly registry?: Registry;
	/** The root conversation the services expose. */
	readonly conversation: Conversation;
	readonly modelRuntime?: ModelRuntime;
	readonly settingsManager?: SettingsManager;
	readonly resources?: ResourceLoader;
	readonly mcp?: McpManagement;
	/** The tool boundary's approval gate, when the worker installed one. */
	readonly approvalGate?: ApprovalGate;
	readonly facetLoader?: FacetLoader;
	/** The terminal handoff: the mirror of this session in the terminal's store. */
	readonly handoff?: { refresh(): Promise<void>; dispose(): Promise<void> };
	/** Release resources the Harness does not own, such as execution environments, after it closed. */
	cleanup?(context: Context): Promise<void>;
}

export interface WorkerServiceScope {
	readonly serverConnectionId: string;
	readonly attachmentId: string;
}

interface ScopedServiceEndpoint {
	readonly scope: WorkerServiceScope;
	readonly endpoint: RemoteServiceEndpoint;
}

export interface SessionWorkerServices {
	invoke(call: ServiceCall, scope: WorkerServiceScope, context: Context): Promise<JsonValue | undefined>;
	removeSubscriptions(matches: (scope: WorkerServiceScope) => boolean): void;
	dispose(): Promise<void>;
	authenticationActive(): boolean;
	subscribeAuthentication(listener: () => void): () => void;
}

export async function createSessionWorkerServices(options: {
	readonly cwd: string;
	readonly harness: Harness;
	readonly registry?: Registry;
	readonly conversation: Conversation;
	readonly modelRuntime: ModelRuntime | undefined;
	readonly settingsManager?: SettingsManager;
	readonly resources?: ResourceLoader;
	readonly mcp?: McpManagement;
	/** The tool boundary's approval gate, when the worker installed one. */
	readonly approvalGate?: ApprovalGate;
	readonly facetLoader?: FacetLoader;
	readonly refreshMirror?: () => Promise<void>;
	publish(scope: WorkerServiceScope, subscriptionId: string, update: ServiceProviderUpdate): Promise<void>;
}): Promise<SessionWorkerServices> {
	let pluginRuntime: PluginRuntime | undefined;
	const authentication = options.modelRuntime === undefined ? undefined : new ProviderLogin(options.modelRuntime,
		options.settingsManager === undefined ? {} : { getDeviceId: () => options.settingsManager!.getOrCreateDeviceId() });
	const agentControllerRuntimeFacet = defineFacet({
		id: "@pi/agent-controller-runtime",
		setup(env) {
			const conversations = env.use(Conversations);
			const runtime = createAgentRuntime(
				options.harness,
				() => Number(conversations.state.value?.selected ?? options.conversation.id) as ConversationId,
				() => pluginRuntime?.changing === true,
			);
			env.provide(AgentRuntime, runtime);
			env.provide(AgentController, createAgentController(
				options.harness,
				async (context) => (await runtime.current(context)).conversation,
				() => pluginRuntime?.changing === true
					? { code: "plugins_reloading", message: "Plugins are unavailable; finish reloading or restart the session" }
					: undefined,
			));
			env.provide(SessionLifecycle, {
				isEmpty: (context) => isSessionEmpty(options.harness, context),
				refreshMirror: async () => { await options.refreshMirror?.(); },
			});
		},
	});
	let reloadPlugins = (): Promise<void> => Promise.reject(new Error("Session plugins are not ready"));
	const pluginRuntimeFacet = defineFacet({
		id: "@pi/session-plugins-runtime",
		setup(env) {
			env.provide(SessionPlugins, { reload: () => reloadPlugins() });
		},
	});
	// A settings change made by another process (the web client, another CLI) reaches this Session
	// through a reload; the worker otherwise keeps the copy it loaded when it started.
	const settingsManager = options.settingsManager;
	const settingsRuntimeFacet =
		settingsManager === undefined
			? undefined
			: defineFacet({
					id: "@pi/session-settings-runtime",
					setup(env) {
						env.provide(SessionSettings, {
							reload: async () => {
								await (options.resources?.reload() ?? settingsManager.reload());
								configureHarnessHttp(settingsManager);
							},
						});
					},
				});
	const builtins = [
		agentControllerRuntimeFacet,
		...(options.registry === undefined ? [] : [createAgentExtensionsFacet(options.registry)]),
		pluginRuntimeFacet,
		// Plugins register their commands here, and the catalogue lists them: one command surface for
		// the terminal client, the page, and a desktop client.
		createSlashCommandsRuntimeFacet(),
		...(settingsRuntimeFacet === undefined ? [] : [settingsRuntimeFacet]),
		await createModelsServiceFacet({ ...options, authentication, context: BACKGROUND_CONTEXT }),
		...(options.mcp === undefined ? [] : [createMcpFacet(options.mcp)]),
		await createTranscriptServiceFacet(options.conversation, BACKGROUND_CONTEXT),
		createCommandsFacet({ cwd: options.cwd, settings: options.settingsManager, resourceLoader: options.resources }),
		createConversationsFacet({
			harness: options.harness,
			root: options.conversation,
			...(options.settingsManager === undefined ? {} : { settings: options.settingsManager }),
			...(options.modelRuntime === undefined
				? {}
				: { summaryModel: summaryModelFromRuntime(options.harness, options.modelRuntime) }),
		}),
		...(options.approvalGate === undefined ? [] : [createApprovalsFacet(options.approvalGate)]),
		createWorkspaceFacet({ cwd: options.cwd }),
		...(options.settingsManager === undefined
			? []
			: [createTerminalFacet({ cwd: options.cwd, settings: options.settingsManager })]),
	];
	const pluginLoader = options.facetLoader ?? createStaticFacetLoader([]);
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
	const removeSubscriptions = (matches: (scope: WorkerServiceScope) => boolean): void => {
		for (const [key, entry] of endpoints) {
			if (!matches(entry.scope)) continue;
			entry.endpoint.dispose();
			endpoints.delete(key);
		}
	};

	return {
		authenticationActive: () => authentication?.active ?? false,
		subscribeAuthentication: (listener) => authentication?.subscribe(listener) ?? (() => {}),
		invoke(call, scope, context) {
			const key = serviceScopeKey(scope);
			let entry = endpoints.get(key);
			if (entry === undefined) {
				entry = { scope, endpoint: createRemoteServiceEndpoint(provider) };
				endpoints.set(key, entry);
			}
			return entry.endpoint.invoke(
				call,
				(subscriptionId, update) => options.publish(scope, subscriptionId, update),
				context,
			);
		},
		removeSubscriptions,
		async dispose() {
			removeSubscriptions(() => true);
			try { await authentication?.close(); await options.settingsManager?.flush(); }
			finally { await pluginRuntime!.close(); }
		},
	};
}

function serviceScopeKey(scope: WorkerServiceScope): string {
	return `${scope.serverConnectionId}\0${scope.attachmentId}`;
}
