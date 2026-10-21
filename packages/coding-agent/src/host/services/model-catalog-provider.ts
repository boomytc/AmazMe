import { join } from "node:path";
import { getSupportedThinkingLevels, type Model } from "@amazme/ai";
import { replicatedState, type Context } from "@amazme/chord";
import { BACKGROUND_CONTEXT, awaitWithContext } from "@amazme/chord/context";
import { ModelConfig } from "../../core/model-config.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { ModelScope } from "../../core/model-scope.ts";
import { ProviderLogin } from "../../core/provider-login.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { createCodingSettings, findInitialAgentModel } from "../../durable/harness-setup.ts";
import type { ModelRef, ModelsState } from "./models.ts";
import type { CatalogModel, ModelCatalog, ModelCatalogState, ProviderConnection } from "./model-catalog.ts";

const secretParameter = /^(?:api[-_]?key|key|token|access[-_]?token|secret|signature)$/i;
function publicEndpoint(value: string): string {
	try {
		const url = new URL(value); url.username = ""; url.password = "";
		for (const key of url.searchParams.keys()) if (secretParameter.test(key)) url.searchParams.set(key, "[configured]");
		return url.toString();
	} catch { return ""; }
}

/** One host owns configuration writes and sign-in; each worker keeps its conversation configuration. */
export async function createModelCatalogService(options: {
	readonly agentDir: string;
	readonly projectCwd: (id: string) => Promise<string>;
	readonly synchronize: (context: Context) => Promise<void>;
}) {
	const settings = SettingsManager.create(options.agentDir, options.agentDir, { projectTrusted: false });
	const runtime = await ModelRuntime.create({ settingsManager: settings });
	const authentication = new ProviderLogin(runtime, { getDeviceId: () => settings.getOrCreateDeviceId() });
	const lifetime = new AbortController();
	const checks = new Map<string, ProviderConnection["verification"]>();
	let refresh: ModelsState["refresh"] = { status: "idle" };
	let syncing: string | null = null;
	let refreshTask: Promise<void> | undefined;
	let tail = Promise.resolve();
	const state = replicatedState<ModelCatalogState>({ revision: 0, models: [], providers: [], authentication: authentication.snapshot(), defaults: null, enabledModelIds: null, refresh, error: null });
	const describeModel = (model: Model<string>): CatalogModel => ({
		provider: model.provider, modelId: model.id, name: model.name, reasoning: model.reasoning,
		contextWindow: model.contextWindow, levels: getSupportedThinkingLevels(model),
		available: runtime.getAvailableSnapshot().some(item => item.provider === model.provider && item.id === model.id),
	});
	const configuration = async (manager: SettingsManager): Promise<ModelsState> => {
		const available = runtime.getAvailableSnapshot();
		const scope = new ModelScope(manager);
		const initial = await findInitialAgentModel(manager, runtime, undefined, scope.resolve(available));
		const enabled = scope.configuration(available).enabledModelIds;
		return {
			catalog: { revision: state.value.revision, availableModels: available.map(describeModel), enabledModelIds: enabled === null ? null : [...enabled] },
			configuration: { model: initial.model ?? null, thinkingLevel: initial.thinkingLevel ?? "off" },
			refresh, authentication: authentication.snapshot(),
		};
	};
	const publish = async (): Promise<void> => {
		if (lifetime.signal.aborted) return;
		const config = await ModelConfig.load(join(options.agentDir, "models.json"));
		const initial = await configuration(settings);
		const defaults = initial.configuration.model ? { model: initial.configuration.model, thinkingLevel: initial.configuration.thinkingLevel } : null;
		const enabled = new ModelScope(settings).configuration(runtime.getModels()).enabledModelIds;
		if (lifetime.signal.aborted) return;
		state.replace(BACKGROUND_CONTEXT, {
			revision: state.value.revision + 1,
			models: runtime.getAvailableSnapshot().map(describeModel),
			providers: runtime.getProviders().map(provider => {
				const models = runtime.getModels(provider.id);
				const stored = config.getProvider(provider.id);
				const auth = runtime.getProviderAuthStatus(provider.id);
				return { id: provider.id, name: provider.name, configured: auth.configured, ...(auth.source ? { source: auth.source } : {}),
					baseUrl: publicEndpoint(stored?.baseUrl ?? models[0]?.baseUrl ?? ""), api: stored?.api ?? models[0]?.api ?? "openai-completions",
					modelCount: models.length, custom: stored?.models !== undefined,
					...(stored?.models === undefined ? {} : { modelIds: stored.models.map(model => model.id) }),
					verification: checks.get(provider.id) ?? { status: "idle" as const } };
			}).sort((left, right) => Number(right.configured) - Number(left.configured) || left.name.localeCompare(right.name)),
			authentication: authentication.snapshot(), defaults,
			enabledModelIds: enabled === null ? null : [...enabled],
			refresh, error: syncing ?? (runtime.getError() ? "configuration" : null),
		});
	};
	const synchronize = async (): Promise<void> => {
		try { await options.synchronize(BACKGROUND_CONTEXT); syncing = null; }
		catch { syncing = "synchronization"; }
	};
	const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = tail.catch(() => {}).then(() => { lifetime.signal.throwIfAborted(); return operation(); });
		tail = result.then(() => {}, () => {});
		return result;
	};
	const reload = async (): Promise<void> => {
		await settings.reload();
		await runtime.refresh({ allowNetwork: false, signal: lifetime.signal });
		await synchronize();
		await publish();
	};
	const stopAuthentication = authentication.subscribe(() => {
		if (authentication.active) void serialize(publish).catch(() => {});
		else void serialize(async () => {
			const provider = authentication.snapshot().login?.provider;
			if (provider) checks.delete(provider);
			await reload();
		}).catch(() => {});
	});
	const requireModel = (ref: ModelRef) => {
		const model = runtime.getAvailableSnapshot().find(model => model.provider === ref.provider && model.id === ref.modelId);
		if (!model) throw new Error("Choose an available model.");
		return model;
	};
	/** A live reply is the availability check. Provider errors can carry credentials, so only the outcome is kept. */
	const probeModel = async (model: ReturnType<ModelRuntime["getModels"]>[number], signal: AbortSignal): Promise<boolean> => {
		try {
			const answer = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }] }, { signal, maxTokens: 16 });
			return answer.stopReason !== "error" && answer.stopReason !== "aborted";
		} catch { return false; }
	};
	const service: ModelCatalog = {
		state,
		async resolve(projectId, context) {
			context.abortSignal?.throwIfAborted();
			const manager = projectId === null ? settings : createCodingSettings(await options.projectCwd(projectId));
			await manager.reload();
			return configuration(manager);
		},
		async models(provider, context) { context.abortSignal?.throwIfAborted(); return runtime.getModels(provider).map(describeModel); },
		async refresh(context) {
			refreshTask ??= serialize(async () => {
				refresh = { status: "refreshing" }; await publish();
				try {
					await settings.reload();
					const result = await runtime.refresh({ signal: lifetime.signal });
					refresh = result.errors.size === 0 ? { status: "done" } : { status: "warning", errors: Object.fromEntries([...result.errors.keys()].map(id => [id, "catalog"])) };
					await synchronize();
				} catch { refresh = { status: "warning", errors: { catalog: "unavailable" } }; }
				await publish();
			}).finally(() => { refreshTask = undefined; });
			await awaitWithContext(refreshTask, context);
		},
		configureProvider: (input, context) => serialize(async () => {
			context.abortSignal?.throwIfAborted();
			if (authentication.active) throw new Error("Finish or cancel provider sign-in before editing connections.");
			if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.id) || !input.name.trim()) throw new Error("Enter a provider ID and name.");
			const url = new URL(input.baseUrl);
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Enter an HTTP API endpoint without credentials.");
			if (!["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].includes(input.api)) throw new Error("Unsupported API protocol.");
			if (input.modelIds?.some(id => !id.trim())) throw new Error("Model IDs cannot be empty.");
			await ModelConfig.updateProvider(join(options.agentDir, "models.json"), input.id, current => ({
				...current, name: input.name.trim(), baseUrl: current?.baseUrl && publicEndpoint(current.baseUrl) === input.baseUrl ? current.baseUrl : input.baseUrl.trim(), api: input.api,
				...(input.modelIds === undefined ? {} : { models: [...new Set(input.modelIds.map(id => id.trim()))].map(id => current?.models?.find(model => model.id === id) ?? { id }) }),
			}), context.abortSignal);
			checks.delete(input.id);
			await reload();
		}),
		setModelEnabled: (ref, enabled, context) => serialize(async () => {
			context.abortSignal?.throwIfAborted();
			if (typeof enabled !== "boolean") throw new Error("Model visibility must be a boolean.");
			if (!runtime.getModel(ref.provider, ref.modelId)) throw new Error("Unknown model.");
			await settings.updateGlobalSettings(() => {
				const scope = new ModelScope(settings);
				const models = runtime.getModels();
				const references = new Map(scope.resolve(models).map(({ model, thinkingLevel }) => {
					const id = `${model.provider}/${model.id}`;
					return [id, thinkingLevel ? `${id}:${thinkingLevel}` : id];
				}));
				// Unavailable references and per-model reasoning suffixes are still saved preferences.
				for (const id of scope.configuration(models).enabledModelIds ?? []) if (!references.has(id)) references.set(id, id);
				const id = `${ref.provider}/${ref.modelId}`;
				if (enabled && !references.has(id)) references.set(id, id);
				if (!enabled) references.delete(id);
				settings.setEnabledModels([...references.values()]);
			});
			if (settings.drainErrors().length) throw new Error("Could not save the model list. Repair settings.json and retry.");
			await reload();
		}),
		saveDefaults: (selection, context) => serialize(async () => {
			context.abortSignal?.throwIfAborted();
			const model = requireModel(selection.model);
			if (!getSupportedThinkingLevels(model).includes(selection.thinkingLevel)) throw new Error("Unsupported reasoning level.");
			await settings.updateGlobalSettings(() => {
				const enabled = new ModelScope(settings).configuration(runtime.getModels()).enabledModelIds;
				const id = `${model.provider}/${model.id}`;
				if (enabled !== null && !enabled.includes(id)) settings.setEnabledModels([...(settings.getEnabledModels() ?? []), id]);
				settings.setDefaultModelAndProvider(model.provider, model.id);
				settings.setDefaultThinkingLevel(selection.thinkingLevel);
			});
			if (settings.drainErrors().length) throw new Error("Could not save model defaults. Repair settings.json and retry.");
			await reload();
		}),
		testConnection: (ref, context) => serialize(async () => {
			const model = requireModel(ref);
			const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000), ...(context.abortSignal ? [context.abortSignal] : [])]);
			checks.set(ref.provider, { status: "checking", modelId: model.id }); await publish();
			const success = await probeModel(model, signal);
			checks.set(ref.provider, { status: success ? "success" : "error", checkedAt: Date.now(), modelId: model.id });
			await publish();
		}),
		testModels: (provider, modelId, context) => serialize(async () => {
			context.abortSignal?.throwIfAborted();
			const models = runtime.getModels(provider).filter(model => modelId === null || model.id === modelId);
			const signal = AbortSignal.any([lifetime.signal, ...(context.abortSignal ? [context.abortSignal] : [])]);
			checks.set(provider, { status: "checking", ...(modelId === null ? {} : { modelId }) }); await publish();
			const failed: string[] = [];
			for (const model of models) {
				signal.throwIfAborted();
				const attempt = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
				if (!await probeModel(model, attempt)) failed.push(model.id);
			}
			checks.set(provider, { status: models.length > 0 && failed.length === 0 ? "success" : "error", checkedAt: Date.now(), ...(modelId === null ? {} : { modelId }) });
			await publish();
			return { ok: models.length > 0 && failed.length === 0, failed };
		}),
		startLogin(provider, method, context) { return serialize(() => authentication.startLogin(provider, method, context.abortSignal)); },
		async submitLoginPrompt(id, promptId, value, context) { context.abortSignal?.throwIfAborted(); return authentication.submitPrompt(id, promptId, value); },
		async cancelLogin(id, context) { context.abortSignal?.throwIfAborted(); return authentication.cancelLogin(id); },
		async logout(provider, context) {
			await authentication.logout(provider, context.abortSignal);
			await serialize(async () => { checks.delete(provider); await reload(); });
		},
	};
	await publish();
	return { service, async close() { lifetime.abort(); stopAuthentication(); await authentication.close(); await tail; } };
}
