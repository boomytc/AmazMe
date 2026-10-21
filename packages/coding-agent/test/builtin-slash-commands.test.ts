import { replicatedState } from "@amazme/chord";
import type { Conversation } from "@amazme/durable";
import { createServiceHost, ServiceHost } from "@amazme/protocol/services";
import { beforeAll, describe, expect, test } from "vitest";
import { AgentController } from "../src/core/plugins/agent-controller.ts";
import { AgentExtensions } from "../src/core/plugins/agent-extensions.ts";
import { AgentRuntime } from "../src/core/plugins/agent-runtime.ts";
import { SlashCommandRegistry, createSlashCommandsRuntimeFacet } from "../src/core/plugins/command-registry.ts";
import checkpoint from "../plugins/checkpoint/src/session.ts";
import history from "../plugins/history/src/session.ts";
import memory from "../plugins/memory/src/session.ts";
import workflows from "../plugins/workflows/src/session.ts";
import { createBuiltInSlashCommandsFacet } from "../src/host/services/slash-commands-provider.ts";
import { createInsightsCommandsFacet } from "../src/host/services/insights-commands.ts";
import { createShareCommandFacet } from "../src/host/services/share-command.ts";
import { Commands } from "../src/host/services/commands.ts";
import { sourceFacets, type ServerServiceSource } from "../src/host/services/connection.ts";
import { SessionInsights, type SessionInsightsState } from "../src/host/services/insights.ts";
import { Models, type ModelsState } from "../src/host/services/models.ts";
import { PresentationPlugins } from "../src/host/services/plugins.ts";
import { PresentationUI } from "../src/host/services/presentation-ui.ts";
import { SessionSettings, Settings, type SettingsState } from "../src/host/services/settings.ts";
import { connectTestHost } from "./native-host-support.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

function testSource(provider: ServiceHost) {
	return {
		async catalogue() {
			await provider.ready();
			return provider.catalogue.filter((entry) => !entry.local);
		},
		open(options: Parameters<ServerServiceSource["open"]>[0]) {
			const peer = connectTestHost(provider.host);
			for (const service of options.services) peer.scope.get(service);
			return {
				get: peer.scope.get.bind(peer.scope),
				ready: peer.scope.ready.bind(peer.scope),
				dispose: () => peer.close(),
			};
		},
	};
}

function settingsState(): SettingsState {
	return {
		revision: 1,
		agentDir: "/tmp/agent",
		cwd: "/tmp",
		paths: { global: "/tmp/agent/settings.json" },
		projectTrusted: true,
		descriptors: [],
		errors: [],
	};
}

function modelsState(): ModelsState {
	return {
		catalog: { revision: 1, enabledModelIds: null, availableModels: [] },
		configuration: { model: null, thinkingLevel: "off" },
		refresh: { status: "idle" },
		authentication: null,
	};
}

function insightsState(): SessionInsightsState {
	return {
		revision: 1,
		reviewRevision: 0,
		conversationId: "1",
		paused: null,
		calls: 0,
		cleanup: { tools: 0, images: 0 },
		files: [],
		notes: [],
		skipped: 0,
		at: 0,
		verification: [],
	};
}

describe("builtin slash commands", () => {
	let conversation: Conversation;
	let closeConversation: () => Promise<void> = async () => {};

	beforeAll(async () => {
		const durable = await openFauxConversation();
		conversation = durable.conversation;
		closeConversation = () => durable.close();
	});

	test("every builtin registered command name passes registry validation", async () => {
		const registry = new SlashCommandRegistry();
		const remote = new ServiceHost("builtin-command-services");
		const host = createServiceHost("builtin-commands");
		const local = new ServiceHost(host.name, host);
		remote.provide(Models, {
			state: replicatedState(modelsState()),
			async suggestPrompt() {
				return null;
			},
			async cycleThinking() {},
			async cycleModel() {},
			async getModelScope() {
				return { allModels: [], enabledModelIds: null };
			},
			async setModelScope() {},
			async saveDefaults() {},
			async getThinkingLevels() {
				return ["off"];
			},
			async refresh() {},
			async reload() {},
			async select() {},
			async selectThinking() {},
			async startLogin() {
				return "unused";
			},
			async submitLoginPrompt() {
				return false;
			},
			async cancelLogin() {
				return false;
			},
			async logout() {},
		});
		remote.provide(AgentController, {
			async prompt() {
				throw new Error("unused");
			},
			async steer() {
				throw new Error("unused");
			},
			async followUp() {
				throw new Error("unused");
			},
			async cancelQueued() {
				return { outcome: "not_found" as const };
			},
			async abort() {},
			async compact() {
				throw new Error("unused");
			},
			async waitForPrompt() {
				throw new Error("unused");
			},
			async findPrompt() {
				return null;
			},
			async cancelPrompt() {
				return { outcome: "not_found" as const };
			},
		});
		remote.provide(Commands, {
			state: replicatedState({ revision: 1, commands: [] }),
			async run() {
				return { ok: true as const, note: "" };
			},
			async complete() {
				return [];
			},
			async expand() {
				return { ok: false as const, problem: "unused" };
			},
			async refresh() {},
		});
		remote.provide(PresentationPlugins, {
			async prepareSession() {
				return {};
			},
			async reload() {
				return {};
			},
		});
		remote.provide(Settings, {
			state: replicatedState(settingsState()),
			async set() {},
			async adjustFontSizes() {},
			async reload() {},
		});
		remote.provide(SessionSettings, {
			state: replicatedState(settingsState()),
			async reload() {},
		});
		remote.provide(SessionInsights, {
			state: replicatedState(insightsState()),
			async refresh() {},
			async diff() {
				return "";
			},
			async resume() {},
		});
		local.provide(PresentationUI, {
			async select() {
				return undefined;
			},
			showStatus() {},
		});
		local.provide(AgentExtensions, {
			install() {
				return () => {};
			},
			list() {
				return [];
			},
		});
		local.provide(AgentRuntime, {
			async current() {
				throw new Error("unused");
			},
			async withWritableConversation() { throw new Error("unused"); },
		});
		const facets = [
			createSlashCommandsRuntimeFacet(registry),
			createBuiltInSlashCommandsFacet({
				async reloadPresentationPlugins() {},
				async authenticate() {},
			}),
			createInsightsCommandsFacet(),
			createShareCommandFacet({
				conversation,
				cwd: "/tmp",
				destination: () => "auto",
			}),
			checkpoint,
			history,
			memory,
			workflows,
		];
		try {
			await remote.ready();
			await host.load([...(await sourceFacets(facets, [testSource(remote)])), ...facets]);
			const names = registry.list().map((command) => command.name);
			const fresh = new SlashCommandRegistry();
			for (const command of registry.list()) fresh.register(command);
			expect(fresh.list().map((command) => command.name).sort()).toEqual([...names].sort());
			expect(names).toEqual(
				expect.arrayContaining([
					"changes",
					"checkpoint",
					"compact",
					"execution",
					"limits",
					"login",
					"logout",
					"memory",
					"model",
					"recall",
					"reload",
					"resume-run",
					"share",
					"thinking",
					"workflows",
				]),
			);
			expect(() => fresh.register({ name: "resume_run", run: () => undefined })).toThrow(
				"Invalid slash command name: resume_run",
			);
		} finally {
			await local.dispose();
			await remote.dispose();
			await closeConversation();
		}
	});
});
