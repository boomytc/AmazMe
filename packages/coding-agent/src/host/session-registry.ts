import type { Context } from "@amazme/chord";
import {
	createRegistry,
	defineExtension,
	type EnvTarget,
	type HarnessSettings,
	type Registry,
	section,
} from "@amazme/durable";
import type { ExecutionEnv } from "@amazme/durable/env";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
import {
	createCodingTools,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	type SearchProgramOptions,
} from "@amazme/durable/tools";
import { createPolicyEnv } from "../durable/insights/execution-policy.ts";
import { PythonTerminalEnv } from "./python-terminal.ts";
import { createForkArchiveGate } from "../core/fork-admission.ts";
import type { ResourceLoader } from "../core/resource-loader.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ensureTool } from "../utils/tools-manager.ts";

/** Harness settings read at every use from pi's settings as loaded at startup. */
export function createHarnessSettings(
	settingsManager: SettingsManager,
): HarnessSettings {
	return {
		get stream() {
			const provider = settingsManager.getProviderRetrySettings();
			const idle = settingsManager.getHttpIdleTimeoutMs();
			return {
				transport: settingsManager.getTransport(),
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
				idleTimeoutMs: idle,
				maxRetryDelayMs: provider.maxRetryDelayMs,
				...(provider.maxRetries === undefined
					? {}
					: { maxRetries: provider.maxRetries }),
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

/** Coding tools for a caller that still builds a registry. Session execution itself is the Python backend. */
export function createCodingRegistry(
	settingsManager: SettingsManager,
	cwd: string,
	resources: ResourceLoader,
	workspaces: () => Promise<readonly string[]> = async () => [cwd],
	artifactDirectory?: string,
): Registry {
	void resources;
	void artifactDirectory;
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
	registry.install(createForkArchiveGate());
	const program =
		(name: "rg" | "fd"): SearchProgramOptions["program"] =>
		async (api) => {
			if (api.env?.id !== "node:local") return name;
			const path = await ensureTool(name);
			if (path === undefined)
				throw new Error(`${name} is unavailable in the execution environment`);
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
		defineExtension({
			name: "powershell",
			tools: [{ ...createPowerShellTool(), defaultActive: false }],
		}),
	);
	registry.install(
		defineExtension({
			name: "project-workspaces",
			sections: [
				section(
					"project_workspaces",
					async () =>
						`Authorized project workspace folders:\n${(await workspaces()).map((path) => `- ${path}`).join("\n")}\n` +
						`The session's execution directory is ${cwd}. Use absolute paths for other workspace folders. Before working in another folder, read its AGENTS.md. Tool approvals follow the configured policy.`,
				),
			],
		}),
	);
	return registry;
}

/**
 * One execution environment per working directory within a single session.
 * Each session constructs its own {@link ExecutionEnvs} with that session's `artifactDirectory`,
 * so two sessions that share a cwd never share an artifact directory.
 */
export class ExecutionEnvs {
	readonly #defaultCwd: string;
	readonly #artifactDirectory: string;
	readonly #envs = new Map<string, ExecutionEnv>();
	readonly #settings: SettingsManager | undefined;
	readonly #workspaces: () => Promise<readonly string[]>;

	constructor(
		defaultCwd: string,
		artifactDirectory: string,
		settings?: SettingsManager,
		workspaces: () => Promise<readonly string[]> = async () => [defaultCwd],
	) {
		this.#defaultCwd = defaultCwd;
		this.#artifactDirectory = artifactDirectory;
		this.#settings = settings;
		this.#workspaces = workspaces;
	}

	/** The session-scoped artifact directory injected into every env this instance creates. */
	get artifactDirectory(): string {
		return this.#artifactDirectory;
	}

	readonly env = ({ cwd = this.#defaultCwd }: EnvTarget): ExecutionEnv => {
		let env = this.#envs.get(cwd);
		if (env === undefined) {
			env = process.env.AMAZME_PYTHON_URL
				? new PythonTerminalEnv({ cwd, artifactDirectory: this.#artifactDirectory })
				: this.#settings
					? createPolicyEnv(cwd, this.#artifactDirectory, this.#settings, this.#workspaces)
					: new NodeExecutionEnv({ cwd, artifactDirectory: this.#artifactDirectory });
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
