import {
	clampThinkingLevel,
	type Model,
	type ModelThinkingLevel,
} from "@amazme/ai";
import type { ModelRef } from "@amazme/durable";
import { getAgentDir } from "../config.ts";
import type { CodingResourceOptions } from "../durable/prompt.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import {
	applyHttpProxySettings,
	configureHttpDispatcher,
} from "./http-dispatcher.ts";
import {
	findInitialModel,
	resolveCliModel,
	type ScopedModel,
} from "./model-resolver.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import {
	DefaultResourceLoader,
	type ResourceLoader,
} from "./resource-loader.ts";
import { SettingsManager } from "./settings-manager.ts";
import {
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "./trust-manager.ts";

export type { CodingResourceOptions };

export interface InitialModel {
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly fallbackMessage?: string;
}

/** A headless host uses saved project trust and the global policy; it cannot prompt for trust. */
export function createCodingSettings(cwd: string): SettingsManager {
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(cwd, agentDir, {
		projectTrusted: false,
	});
	refreshCodingProjectTrust(settings, cwd);
	return settings;
}

/** Re-read saved consent when an already opened hosted session reloads its configuration. */
export function refreshCodingProjectTrust(
	settings: SettingsManager,
	cwd: string,
): boolean {
	const trusted =
		!hasTrustRequiringProjectResources(cwd) ||
		(new ProjectTrustStore(getAgentDir()).get(cwd) ??
			settings.getDefaultProjectTrust() === "always");
	const changed = settings.isProjectTrusted() !== trusted;
	settings.setProjectTrusted(trusted);
	return changed;
}

/** pi's HTTP setup: proxy, idle timeouts, and one undici for fetch. Without it, some provider streams break off. */
export function configureHarnessHttp(settingsManager: SettingsManager): void {
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
}

/** Use Pi's resource selection without evaluating SDK extension factories in the native runtime. */
export async function loadCodingResources(
	settingsManager: SettingsManager,
	cwd: string,
	options: CodingResourceOptions = {},
): Promise<ResourceLoader> {
	const resources = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: true,
		additionalPromptTemplatePaths: options.promptTemplates?.slice(),
		noPromptTemplates: options.noPromptTemplates,
		additionalThemePaths: options.themes?.slice(),
		noThemes: options.noThemes,
		systemPrompt: options.systemPrompt,
		appendSystemPrompt: options.appendSystemPrompt?.slice(),
		additionalSkillPaths: options.skills?.slice(),
		noSkills: options.noSkills,
		noContextFiles: options.noContextFiles,
	});
	await resources.reload();
	return resources;
}

/** Explicit thinking, then per-model/global defaults and a switch fallback, bounded by model capabilities. */
export function initialThinkingLevel(
	settingsManager: SettingsManager,
	model: Model<string>,
	requested?: ModelThinkingLevel,
	fallback?: ModelThinkingLevel,
): ModelThinkingLevel {
	return clampThinkingLevel(
		model,
		requested ??
			settingsManager.getModelThinkingLevel(model.provider, model.id) ??
			settingsManager.getDefaultThinkingLevel() ??
			fallback ??
			DEFAULT_THINKING_LEVEL,
	);
}

/** New roots use the explicit model, saved default within a scope, first scoped model, or Pi's defaults. */
export async function findInitialAgentModel(
	settingsManager: SettingsManager,
	modelRuntime: ModelRuntime,
	cli?: {
		readonly provider?: string;
		readonly model: string;
		readonly thinkingLevel?: ModelThinkingLevel;
		readonly inlineApiKey?: boolean;
	},
	scopedModels: readonly ScopedModel[] = [],
): Promise<InitialModel> {
	if (cli !== undefined) {
		const resolved = resolveCliModel({
			cliProvider: cli.provider,
			cliModel: cli.model,
			cliThinking: cli.thinkingLevel,
			inlineApiKey: cli.inlineApiKey,
			modelRuntime,
		});
		if (resolved.error !== undefined || resolved.model === undefined) {
			throw new Error(
				`Could not resolve model: ${resolved.error ?? cli.model}`,
			);
		}
		const thinkingLevel = cli.thinkingLevel ?? resolved.thinkingLevel;
		return {
			model: { provider: resolved.model.provider, modelId: resolved.model.id },
			...(thinkingLevel === undefined
				? {}
				: { thinkingLevel: clampThinkingLevel(resolved.model, thinkingLevel) }),
		};
	}
	if (scopedModels.length > 0) {
		const selected =
			scopedModels.find(
				({ model }) =>
					model.provider === settingsManager.getDefaultProvider() &&
					model.id === settingsManager.getDefaultModel(),
			) ?? scopedModels[0]!;
		return {
			model: { provider: selected.model.provider, modelId: selected.model.id },
			thinkingLevel: initialThinkingLevel(
				settingsManager,
				selected.model,
				selected.thinkingLevel,
			),
		};
	}
	const initial = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: settingsManager.getDefaultProvider(),
		defaultModelId: settingsManager.getDefaultModel(),
		defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
		modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
		modelRuntime,
	});
	return {
		...(initial.model === undefined
			? {}
			: {
					model: {
						provider: initial.model.provider,
						modelId: initial.model.id,
					},
					thinkingLevel: initialThinkingLevel(settingsManager, initial.model),
				}),
		...(initial.fallbackMessage === undefined
			? {}
			: { fallbackMessage: initial.fallbackMessage }),
	};
}
