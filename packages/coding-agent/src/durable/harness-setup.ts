import type { Context } from "@amazme/chord";
import { clampThinkingLevel, type Model, type ModelThinkingLevel } from "@amazme/ai";
import {
	createRegistry,
	defineExtension,
	type EnvTarget,
	type HarnessSettings,
	type ModelRef,
	type Registry,
} from "@amazme/durable";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
import {
	createCodingTools,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	type SearchProgramOptions,
} from "@amazme/durable/tools";
import { ensureTool } from "../utils/tools-manager.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../core/http-dispatcher.ts";
import { DEFAULT_THINKING_LEVEL } from "../core/defaults.ts";
import { findInitialModel, resolveCliModel } from "../core/model-resolver.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { DefaultResourceLoader, type ResourceLoader } from "../core/resource-loader.ts";
import { getAgentDir } from "../config.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../core/trust-manager.ts";
import { createPiPrompt, type CodingPromptOptions } from "./prompt.ts";
import { createDurableCodemode } from "./codemode.ts";

/** A headless host uses saved project trust and the global policy; it cannot prompt for trust. */
export function createCodingSettings(cwd: string): SettingsManager {
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const trusted = !hasTrustRequiringProjectResources(cwd) ||
		(new ProjectTrustStore(agentDir).get(cwd) ?? settings.getDefaultProjectTrust() === "always");
	settings.setProjectTrusted(trusted);
	return settings;
}

/** pi's HTTP setup: proxy, idle timeouts, and one undici for fetch. Without it, some provider streams break off. */
export function configureHarnessHttp(settingsManager: SettingsManager): void {
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
}

/** Harness settings read at every use from pi's settings as loaded at startup. */
export function createHarnessSettings(settingsManager: SettingsManager): HarnessSettings {
	return {
		get stream() {
			const provider = settingsManager.getProviderRetrySettings();
			const idle = settingsManager.getHttpIdleTimeoutMs();
			return {
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
				maxRetryDelayMs: provider.maxRetryDelayMs,
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
			};
		},
		get compaction() {
			return settingsManager.getCompactionSettings();
		},
		get retry() {
			return settingsManager.getRetrySettings();
		},
		get steeringMode() {
			return settingsManager.getSteeringMode();
		},
		get followUpMode() {
			return settingsManager.getFollowUpMode();
		},
	};
}

/** Use Pi's resource selection without evaluating SDK extension factories in the native runtime. */
export async function loadCodingResources(
	settingsManager: SettingsManager,
	cwd: string,
	options: CodingPromptOptions = {},
): Promise<ResourceLoader> {
	const resources = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: true,
		noThemes: true,
		systemPrompt: options.systemPrompt,
		appendSystemPrompt: options.appendSystemPrompt?.slice(),
		additionalSkillPaths: options.skills?.slice(),
		noSkills: options.noSkills,
		noContextFiles: options.noContextFiles,
	});
	await resources.reload();
	return resources;
}

/** A registry with Pi's coding tools and one resource-backed system prompt. */
export function createCodingRegistry(settingsManager: SettingsManager, cwd: string, resources: ResourceLoader): Registry {
	const registry = createRegistry();
	registry.install(
		createCodingTools({
			images: {
				async prepare(bytes, mimeType, limits) {
					const { processImage } = await import("../utils/image-process.ts");
					const result = await processImage(bytes, mimeType, {
						autoResizeImages: settingsManager.getSettings().images?.autoResize,
						resizeOptions: limits,
					});
					return result.ok ? result : undefined;
				},
			},
		}),
	);
	registry.install(createDurableCodemode(settingsManager));
	const program =
		(name: "rg" | "fd"): SearchProgramOptions["program"] =>
		async (api) => {
			if (api.env?.id !== "node:local") return name;
			const path = await ensureTool(name);
			if (path === undefined) throw new Error(`${name} is unavailable in the execution environment`);
			return path;
		};
	registry.install(
		defineExtension({
			name: "file-search-tools",
			tools: [
				createGrepTool({ program: program("rg") }),
				createFindTool({ program: program("fd") }),
				createLsTool(),
			].map((tool) => ({ ...tool, defaultActive: false })),
		}),
	);
	registry.install(
		defineExtension({ name: "powershell", tools: [{ ...createPowerShellTool(), defaultActive: false }] }),
	);
	registry.install(createPiPrompt(resources, cwd));
	return registry;
}

/** One execution environment per directory, shared by every conversation in it. */
export class ExecutionEnvs {
	readonly #defaultCwd: string;
	readonly #envs = new Map<string, NodeExecutionEnv>();

	constructor(defaultCwd: string) {
		this.#defaultCwd = defaultCwd;
	}

	readonly env = ({ cwd = this.#defaultCwd }: EnvTarget): NodeExecutionEnv => {
		let env = this.#envs.get(cwd);
		if (env === undefined) {
			env = new NodeExecutionEnv({ cwd });
			this.#envs.set(cwd, env);
		}
		return env;
	};

	async cleanup(context: Context): Promise<void> {
		const envs = [...this.#envs.values()];
		this.#envs.clear();
		for (const env of envs) await env.cleanup(context);
	}
}

export interface InitialModel {
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly fallbackMessage?: string;
}

/** Explicit thinking, then per-model and global settings, bounded by the model's capabilities. */
export function initialThinkingLevel(
	settingsManager: SettingsManager,
	model: Model<string>,
	requested?: ModelThinkingLevel,
): ModelThinkingLevel {
	return clampThinkingLevel(
		model,
		requested ??
			settingsManager.getModelThinkingLevel(model.provider, model.id) ??
			settingsManager.getDefaultThinkingLevel() ??
			DEFAULT_THINKING_LEVEL,
	);
}

/** The model a new root conversation starts with: an explicit `--provider`/`--model`, or pi's default resolution. */
export async function findInitialAgentModel(
	settingsManager: SettingsManager,
	modelRuntime: ModelRuntime,
	cli?: { readonly provider?: string; readonly model: string; readonly thinkingLevel?: ModelThinkingLevel },
): Promise<InitialModel> {
	if (cli !== undefined) {
		const resolved = resolveCliModel({
			cliProvider: cli.provider,
			cliModel: cli.model,
			cliThinking: cli.thinkingLevel,
			modelRuntime,
		});
		if (resolved.error !== undefined || resolved.model === undefined) {
			throw new Error(`Could not resolve model: ${resolved.error ?? cli.model}`);
		}
		const thinkingLevel = cli.thinkingLevel ?? resolved.thinkingLevel;
		return {
			model: { provider: resolved.model.provider, modelId: resolved.model.id },
			...(thinkingLevel === undefined ? {} : { thinkingLevel: clampThinkingLevel(resolved.model, thinkingLevel) }),
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
					model: { provider: initial.model.provider, modelId: initial.model.id },
					thinkingLevel: initialThinkingLevel(settingsManager, initial.model),
				}),
		...(initial.fallbackMessage === undefined ? {} : { fallbackMessage: initial.fallbackMessage }),
	};
}
