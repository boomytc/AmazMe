import type { Api, Model } from "@amazme/ai";
import { resolveModelScopeFromModels, type ScopedModel } from "./model-resolver.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface ScopeModel {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
}

export interface ModelScopeConfig {
	readonly allModels: readonly ScopeModel[];
	/** null includes all models; an empty list deliberately includes none. */
	readonly enabledModelIds: readonly string[] | null;
}

/** One scope controls both model menus and cycling, independently of the active model. */
export class ModelScope {
	#patterns: string[] | null;
	#tail = Promise.resolve();
	readonly #settings: SettingsManager | undefined;

	constructor(settings?: SettingsManager, patterns: readonly string[] | null = settings?.getEnabledModels() ?? null) {
		this.#settings = settings;
		this.#patterns = patterns === null ? null : [...patterns];
	}

	get patterns(): string[] | null {
		return this.#patterns === null ? null : [...this.#patterns];
	}

	resolve(models: readonly Model<Api>[]): ScopedModel[] {
		return this.#patterns === null
			? models.map((model) => ({ model, thinkingLevel: undefined }))
			: resolveModelScopeFromModels(this.#patterns, models).scopedModels;
	}

	configuration(models: readonly Model<Api>[]): ModelScopeConfig {
		const resolved = this.#patterns === null ? undefined : resolveModelScopeFromModels(this.#patterns, models);
		const enabled = resolved?.scopedModels.map(({ model }) => `${model.provider}/${model.id}`) ?? null;
		for (const diagnostic of resolved?.diagnostics ?? []) {
			if (diagnostic.code === "no-match" && enabled && !enabled.includes(diagnostic.pattern)) enabled.push(diagnostic.pattern);
		}
		return {
			allModels: models.map(({ provider, id, name }) => ({ provider, id, name })),
			enabledModelIds: enabled,
		};
	}

	configure(patterns: readonly string[] | null, persist: boolean): Promise<void> {
		if (typeof persist !== "boolean") return Promise.reject(new Error("Model scope persistence must be a boolean."));
		if (patterns !== null && (!Array.isArray(patterns) || patterns.some((value) => typeof value !== "string" || value.trim().length === 0)))
			return Promise.reject(new Error("Model scope must be null or a list of non-empty model references."));
		const next = patterns === null ? null : [...new Set(patterns)];
		const operation = this.#tail.then(async () => {
			if (persist) {
				const settings = this.#settings;
				if (!settings) throw new Error("Model scope persistence is unavailable.");
				settings.drainErrors();
				settings.setEnabledModels(next === null ? undefined : [...next]);
				await settings.flush();
				const errors = settings.drainErrors();
				if (errors.length > 0) throw new Error(errors.map(({ error }) => error.message).join("; "));
			}
			this.#patterns = next;
		});
		this.#tail = operation.catch(() => {});
		return operation;
	}

	flush(): Promise<void> {
		return this.#tail;
	}
}
