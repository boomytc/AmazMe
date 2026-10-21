import { serviceFacet, type ServiceValue, disposeResources } from "@amazme/protocol/services";
import { replicatedState } from "@amazme/chord";
import type { Model, ModelThinkingLevel } from "@amazme/ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@amazme/ai";
import type { Context, Facet, MutableReplicatedState } from "@amazme/chord";
import { awaitWithContext, withAbortSignal, BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { AgentState, Conversation, Harness } from "@amazme/durable";
import { AgentDoc } from "@amazme/durable";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { ModelScope } from "../../core/model-scope.ts";
import { ProviderLogin } from "../../core/provider-login.ts";
import { AgentRuntime } from "../../core/plugins/agent-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { initialThinkingLevel } from "../../durable/harness-setup.ts";
import { Conversations } from "./conversations.ts";
import type { Models as ModelsService, ModelsState } from "./models.ts";
import { Models } from "./models.ts";
import { suggestPrompt } from "./prompt-suggestions.ts";

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
	const lifetime = new AbortController();
	let refreshing: Promise<void> | undefined;
	const modelScope = new ModelScope(settingsManager);
	const authentication = sharedAuthentication ?? (modelRuntime === undefined ? undefined
		: new ProviderLogin(modelRuntime, settingsManager === undefined ? {} : { getDeviceId: () => settingsManager.getOrCreateDeviceId() }));
	const configurationOf = (value: Readonly<AgentState> | null | undefined): ModelsState["configuration"] => ({
		model: value?.model === undefined ? null : { provider: value.model.provider, modelId: value.model.modelId },
		thinkingLevel: value?.thinkingLevel ?? "off" });
	const state = createState({
		catalog: { revision: 0, availableModels: [], enabledModelIds: modelScope.patterns },
		configuration: { model: null, thinkingLevel: "off" },
		refresh: { status: "idle" },
		authentication: authentication?.snapshot() ?? null });
	const selectedModel = (agent = readAgent()) => {
		const ref = agent?.model;
		return ref === undefined ? undefined : modelRuntime?.getModel(ref.provider, ref.modelId);
	};
	const readThinkingLevels = (agent: Readonly<AgentState>): ModelThinkingLevel[] => {
		const selected = selectedModel(agent);
		return selected === undefined ? ["off"] : getSupportedThinkingLevels(selected);
	};
	const switchThinkingLevel = (
		model: Model<string>,
		requested: ModelThinkingLevel | undefined,
		fallback: ModelThinkingLevel | undefined,
	): ModelThinkingLevel => settingsManager === undefined
		? clampThinkingLevel(model, requested ?? fallback ?? "off")
		: initialThinkingLevel(settingsManager, model, requested, fallback);
	const readCatalog = (): ModelsState["catalog"] => {
		const selected = selectedModel();
		const available = modelRuntime?.getAvailableSnapshot() ?? [];
		const catalog = selected === undefined || includesModel(available, selected) ? available : [...available, selected];
		const enabledModelIds = modelScope.configuration(available).enabledModelIds;
		catalogRevision += 1;
		return {
			revision: catalogRevision,
			enabledModelIds: enabledModelIds === null ? null : [...enabledModelIds],
			availableModels: catalog.map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				reasoning: model.reasoning,
				contextWindow: model.contextWindow })) };
	};
	let stopAuthentication: (() => void) | undefined;
	const authenticationOwner = (): ProviderLogin => {
		if (!authentication) throw new Error("Provider authentication is unavailable for this session");
		return authentication;
	};
	const service: ModelsService = {
		state,
		async suggestPrompt(request, context) {
			if (settingsManager?.getPromptSuggestions() === false || !modelRuntime) return null;
			const conversation = await current(context);
			const model = selectedModel();
			if (!model) return null;
			const candidate = await suggestPrompt({ conversation, request, model, runtime: modelRuntime, context, lifetime: lifetime.signal });
			return settingsManager?.getPromptSuggestions() === false ? null : candidate;
		},
		async getModelScope(context) {
			context.abortSignal?.throwIfAborted();
			return modelScope.configuration(modelRuntime?.getAvailableSnapshot() ?? []);
		},
		async setModelScope(models, persist, context) {
			context.abortSignal?.throwIfAborted();
			await modelScope.configure(models, persist);
			state.change(context, (draft) => { draft.catalog = readCatalog(); });
		},
		async saveDefaults(model, thinking, context) {
			context.abortSignal?.throwIfAborted();
			const selected = modelRuntime?.getModel(model.provider, model.modelId);
			if (!selected || !getSupportedThinkingLevels(selected).includes(thinking)) throw new Error("Choose an available model and reasoning level before saving defaults.");
			if (!settingsManager) throw new Error("Default settings are unavailable.");
			settingsManager.drainErrors();
			settingsManager.setDefaultModelAndProvider(selected.provider, selected.id);
			settingsManager.setDefaultThinkingLevel(thinking);
			await settingsManager.flush();
			const errors = settingsManager.drainErrors();
			if (errors.length > 0) throw new Error(errors.map(({ error }) => error.message).join("; "));
		},
		async cycleModel(direction, context) {
			if (direction !== "forward" && direction !== "backward") throw new Error("Unknown model cycling direction.");
			const choices = modelScope.resolve(modelRuntime?.getAvailableSnapshot() ?? []);
			if (choices.length === 0) return;
			const conversation = await current(context);
			await conversation.commit(async (tx) => {
				const agent = await tx.doc(AgentDoc, conversation.id);
				const ref = agent.model;
				const index = choices.findIndex(({ model }) => model.provider === ref?.provider && model.id === ref.modelId);
				if (choices.length === 1 && index === 0) return;
				const next = choices[index < 0 ? 0 : (index + (direction === "forward" ? 1 : choices.length - 1)) % choices.length];
				if (!next) return;
				agent.thinkingLevel = switchThinkingLevel(next.model, next.thinkingLevel, agent.thinkingLevel);
				agent.model = { provider: next.model.provider, modelId: next.model.id };
			}, context);
		},
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
			context.abortSignal?.throwIfAborted();
			lifetime.signal.throwIfAborted();
			// One service-owned refresh: readers may leave without cancelling each other's catalog request.
			// Publish the promise before state observers can reenter refresh().
			refreshing ??= Promise.resolve().then(async () => {
				lifetime.signal.throwIfAborted();
				state.change(BACKGROUND_CONTEXT, (draft) => { draft.refresh = { status: "refreshing" }; });
				try {
					lifetime.signal.throwIfAborted();
					const result = await modelRuntime?.refresh({ signal: lifetime.signal });
					lifetime.signal.throwIfAborted();
					const errors = Object.fromEntries([...(result?.errors ?? [])].map(([id, error]) => [id, error.message]));
					const catalog = readCatalog();
					state.change(BACKGROUND_CONTEXT, (draft) => {
						draft.catalog = catalog;
						draft.authentication = authentication?.snapshot() ?? null;
						draft.refresh = Object.keys(errors).length === 0 ? { status: "done" } : { status: "warning", errors };
					});
				} catch (error) {
					if (!lifetime.signal.aborted) state.change(BACKGROUND_CONTEXT, (draft) => {
						draft.refresh = { status: "warning", errors: { catalog: error instanceof Error ? error.message : String(error) } };
					});
					throw error;
				}
			}).finally(() => { refreshing = undefined; });
			await awaitWithContext(refreshing, context);
		},
		async select(model, context) {
			const selected = modelRuntime?.getModel(model.provider, model.modelId);
			if (selected === undefined) throw new Error(`Unknown model: ${model.provider}/${model.modelId}`);
			const conversation = await current(context);
			await conversation.commit(async (tx) => {
				const agent = await tx.doc(AgentDoc, conversation.id);
				agent.thinkingLevel = switchThinkingLevel(selected, undefined, agent.thinkingLevel);
				agent.model = { provider: selected.provider, modelId: selected.id };
			}, context);
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
		} };
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
			lifetime.abort(new Error("Models service closed"));
			stopAuthentication?.();
			await refreshing?.catch(() => {});
			await modelScope.flush();
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
		} };
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
	return serviceFacet("@amazme/models", Models, [Conversations, AgentRuntime], async (services, signal) => {
  const agent = await options.harness.documentState(AgentDoc, options.conversation.id, withAbortSignal(signal, options.context));
  if (agent === undefined) throw new Error(`Conversation ${options.conversation.id} has no agent document`);
		const disposers: Array<() => void | Promise<void>> = [];
		try {
			disposers.push(() => agent.dispose());
			const conversations = services.get(Conversations);
			const agentRuntime = services.get(AgentRuntime);
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
				replicatedState,
				options.authentication,
			);
			disposers.push(() => runtime.close());
			const implementation: ServiceValue<typeof Models> = runtime.service;
			await (async () => {
				await runtime.activate(BACKGROUND_CONTEXT);
				disposers.push(agent.subscribe((_value, context) => runtime.syncConfiguration(context)));
				disposers.push(conversations.state.subscribe((_value, context) => runtime.syncConfiguration(context)));
			})();

			return { value: implementation, close: () => disposeResources(disposers) };
		} catch (error) {
			await disposeResources(disposers);
			throw error;
		}
	});
}

function includesModel(
	models: readonly { readonly provider: string; readonly id: string }[],
	selected: { readonly provider: string; readonly id: string },
): boolean {
	return models.some((model) => model.provider === selected.provider && model.id === selected.id);
}
