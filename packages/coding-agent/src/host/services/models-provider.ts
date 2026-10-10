import type { ModelThinkingLevel } from "@amazme/ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@amazme/ai";
import type { Context, Facet, MutableReplicatedState } from "@amazme/chord";
import { defineFacet } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { AgentState, Conversation, Harness } from "@amazme/durable";
import { AgentDoc } from "@amazme/durable";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { ProviderLogin } from "../../core/provider-login.ts";
import { AgentRuntime } from "../../core/plugins/agent-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { Conversations } from "./conversations.ts";
import type { Models as ModelsService, ModelsState } from "./models.ts";
import { Models } from "./models.ts";

export interface ModelsServiceRuntime {
	readonly service: ModelsService;
	activate(context: Context): Promise<void>;
	/** Publish the agent document's model and thinking level when they changed. */
	syncConfiguration(context: Context): void;
	close(): Promise<void>;
}

/**
 * Model actions use the selected conversation's own agent document. The configuration projection reads the
 * existing root document or focused view, including changes made by other clients.
 */
export function createModelsService(
	current: (context: Context) => Promise<Conversation>,
	readAgent: () => Readonly<AgentState> | null | undefined,
	modelRuntime: ModelRuntime | undefined,
	settingsManager: SettingsManager | undefined,
	createState: (initial: ModelsState) => MutableReplicatedState<ModelsState>,
	sharedAuthentication?: ProviderLogin,
): ModelsServiceRuntime {
	let catalogRevision = 0;
	const authentication = sharedAuthentication ?? (modelRuntime === undefined ? undefined
		: new ProviderLogin(modelRuntime, settingsManager === undefined ? {} : { getDeviceId: () => settingsManager.getOrCreateDeviceId() }));
	const configurationOf = (value: Readonly<AgentState> | null | undefined): ModelsState["configuration"] => ({
		model: value?.model === undefined ? null : { provider: value.model.provider, modelId: value.model.modelId },
		thinkingLevel: value?.thinkingLevel ?? "off",
	});
	const state = createState({
		catalog: { revision: 0, availableModels: [] },
		configuration: { model: null, thinkingLevel: "off" },
		refresh: { status: "idle" },
		authentication: authentication?.snapshot() ?? null,
	});
	const selectedModel = (agent = readAgent()) => {
		const ref = agent?.model;
		return ref === undefined ? undefined : modelRuntime?.getModel(ref.provider, ref.modelId);
	};
	const readThinkingLevels = (agent: Readonly<AgentState>): ModelThinkingLevel[] => {
		const selected = selectedModel(agent);
		return selected === undefined ? ["off"] : getSupportedThinkingLevels(selected);
	};
	const readCatalog = (): ModelsState["catalog"] => {
		const selected = selectedModel();
		const available = modelRuntime?.getAvailableSnapshot() ?? [];
		const catalog = selected === undefined || includesModel(available, selected) ? available : [...available, selected];
		catalogRevision += 1;
		return {
			revision: catalogRevision,
			availableModels: catalog.map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				reasoning: model.reasoning,
				contextWindow: model.contextWindow,
			})),
		};
	};
	let stopAuthentication: (() => void) | undefined;
	const authenticationOwner = (): ProviderLogin => {
		if (!authentication) throw new Error("Provider authentication is unavailable for this session");
		return authentication;
	};
	const service: ModelsService = {
		state,
		startLogin(provider, method, context) {
			context.abortSignal?.throwIfAborted();
			return authenticationOwner().startLogin(provider, method, context.abortSignal);
		},
		submitLoginPrompt(id, promptId, value, context) {
			context.abortSignal?.throwIfAborted();
			return authenticationOwner().submitPrompt(id, promptId, value);
		},
		cancelLogin(id, context) {
			context.abortSignal?.throwIfAborted();
			return authenticationOwner().cancelLogin(id);
		},
		logout(provider, context) {
			context.abortSignal?.throwIfAborted();
			return authenticationOwner().logout(provider, context.abortSignal);
		},
		async cycleThinking(context) {
			const conversation = await current(context);
			await conversation.commit(async (tx) => {
				const agent = await tx.doc(AgentDoc, conversation.id);
				const levels = readThinkingLevels(agent);
				const level = agent.thinkingLevel ?? "off";
				agent.thinkingLevel = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
			}, context);
		},
		async getThinkingLevels(context) {
			const conversation = await current(context);
			return conversation.commit(async (tx) => readThinkingLevels(await tx.doc(AgentDoc, conversation.id)), context);
		},
		async refresh(context) {
			state.change(context, (draft) => {
				draft.refresh = { status: "refreshing" };
			});
			const refresh = modelRuntime?.refresh({ signal: context.abortSignal });
			const errors =
				refresh === undefined
					? {}
					: Object.fromEntries([...(await refresh).errors].map(([id, error]) => [id, error.message]));
			const catalog = readCatalog();
			state.change(context, (draft) => {
				draft.catalog = catalog;
				draft.authentication = authentication?.snapshot() ?? null;
				draft.refresh = Object.keys(errors).length === 0 ? { status: "done" } : { status: "warning", errors };
			});
		},
		async select(model, context) {
			const selected = modelRuntime?.getModel(model.provider, model.modelId);
			if (selected === undefined) throw new Error(`Unknown model: ${model.provider}/${model.modelId}`);
			const conversation = await current(context);
			await conversation.commit(async (tx) => {
				const agent = await tx.doc(AgentDoc, conversation.id);
				agent.thinkingLevel = clampThinkingLevel(selected, agent.thinkingLevel ?? "off");
				agent.model = { provider: selected.provider, modelId: selected.id };
			}, context);
			settingsManager?.setDefaultModelAndProvider(selected.provider, selected.id);
			await settingsManager?.flush();
		},
		async selectThinking(level, context) {
			const conversation = await current(context);
			await conversation.commit(async (tx) => {
				const agent = await tx.doc(AgentDoc, conversation.id);
				const levels = readThinkingLevels(agent);
				if (!levels.includes(level)) {
					throw new Error(`Thinking level ${level} is unavailable; choose one of: ${levels.join(", ")}`);
				}
				agent.thinkingLevel = level;
			}, context);
		},
	};
	return {
		service,
		async activate(context) {
			stopAuthentication ??= authentication?.subscribe(() => {
				state.change(BACKGROUND_CONTEXT, (draft) => {
					draft.authentication = authentication.snapshot();
					if (!authentication.active) draft.catalog = readCatalog();
				});
			});
			const catalog = readCatalog();
			state.change(context, (draft) => {
				draft.catalog = catalog;
				draft.configuration = configurationOf(readAgent());
				draft.refresh = { status: "idle" };
				draft.authentication = authentication?.snapshot() ?? null;
			});
		},
		async close() {
			stopAuthentication?.();
			if (sharedAuthentication === undefined) await authentication?.close();
		},
		syncConfiguration(context) {
			const next = configurationOf(readAgent());
			const current = state.value.configuration;
			if (
				current.model?.provider === next.model?.provider &&
				current.model?.modelId === next.model?.modelId &&
				current.thinkingLevel === next.thinkingLevel
			) {
				return;
			}
			const modelChanged =
				current.model?.provider !== next.model?.provider || current.model?.modelId !== next.model?.modelId;
			const catalog = modelChanged ? readCatalog() : undefined;
			state.change(context, (draft) => {
				draft.configuration = next;
				if (catalog !== undefined) draft.catalog = catalog;
			});
		},
	};
}

/** Acquire the conversation's agent document, then build the facet that owns it. */
export async function createModelsServiceFacet(options: {
	readonly harness: Harness;
	readonly conversation: Conversation;
	readonly modelRuntime: ModelRuntime | undefined;
	readonly settingsManager?: SettingsManager;
	readonly context: Context;
	readonly authentication?: ProviderLogin;
}): Promise<Facet> {
	const agent = await options.harness.documentState(AgentDoc, options.conversation.id, options.context);
	if (agent === undefined) throw new Error(`Conversation ${options.conversation.id} has no agent document`);
	return defineFacet({
		id: "@pi/models",
		setup(env) {
			env.own(() => agent.dispose());
			const conversations = env.use(Conversations);
			const agentRuntime = env.use(AgentRuntime);
			const readAgent = (): Readonly<AgentState> | null | undefined => {
				const selected = conversations.state.value?.selected ?? String(options.conversation.id);
				if (selected === String(options.conversation.id)) return agent.value;
				const view = conversations.state.value?.view;
				return view !== null && view !== undefined && String(view.conversation.id) === selected
					? (view.docs["amazme.agent"] as AgentState | undefined)
					: undefined;
			};
			const runtime = createModelsService(
				async (context) => (await agentRuntime.current(context)).conversation,
				readAgent,
				options.modelRuntime,
				options.settingsManager,
				env.replicatedState,
				options.authentication,
			);
			env.own(() => runtime.close());
			env.provide(Models, runtime.service);
			env.onActivate(async () => {
				await runtime.activate(BACKGROUND_CONTEXT);
				env.own(agent.subscribe((_value, context) => runtime.syncConfiguration(context)));
				env.own(conversations.state.subscribe((_value, context) => runtime.syncConfiguration(context)));
			});
		},
	});
}

function includesModel(
	models: readonly { readonly provider: string; readonly id: string }[],
	selected: { readonly provider: string; readonly id: string },
): boolean {
	return models.some((model) => model.provider === selected.provider && model.id === selected.id);
}
