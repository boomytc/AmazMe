import {
	createFacetHost,
	createRemoteServiceBinding,
	defineFacet,
	replicatedState,
	type RemoteServiceProvider,
	type RemoteServiceTransport,
} from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { describe, expect, test } from "vitest";
import { AgentController, type AgentController as AgentControllerService } from "../src/experimental/services/agent-controller.ts";
import { Commands, type CommandSummary } from "../src/experimental/services/commands.ts";
import { createCommandsFacet } from "../src/experimental/services/commands-provider.ts";
import { Models, type ModelsState } from "../src/experimental/services/models.ts";
import { SessionPlugins } from "../src/experimental/services/plugins.ts";
import { SlashCommands } from "../src/experimental/services/slash-commands.ts";
import {
	createSlashCommandsRuntimeFacet,
	SlashCommandRegistry,
} from "../src/experimental/services/slash-commands-provider.ts";

/** The loopback transport the client tests use: a binding straight onto the host's provider. */
function loopback(provider: RemoteServiceProvider): RemoteServiceTransport {
	return {
		invoke: (call, context) => provider.invoke(call, context),
		subscribe: async (serviceId, mode, listener) => {
			const subscription = provider.subscribe(serviceId, mode, (update) => listener(update, BACKGROUND_CONTEXT));
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.activate(),
				close: () => subscription.close(),
			};
		},
	};
}

const models: ModelsState = {
	catalog: { revision: 1, availableModels: [{ provider: "p", modelId: "m", name: "M", reasoning: false }] },
	configuration: { model: { provider: "p", modelId: "m" }, thinkingLevel: "low" },
	refresh: { status: "idle" },
};

/**
 * A session's command surface as a client reads it: the plugin registry, the three services the
 * catalogue's own commands use, and the catalogue facet, all behind the real service boundary.
 */
async function openCommands(registry: SlashCommandRegistry) {
	const host = await createFacetHost({
		facets: [
			createSlashCommandsRuntimeFacet(registry),
			defineFacet({
				id: "@test/models",
				setup(env) {
					env.provide(Models, {
						state: replicatedState(models),
						async cycleThinking() {},
						async getThinkingLevels() {
							return ["off", "low", "high"] as const;
						},
						async refresh() {},
						async select() {},
						async selectThinking() {},
					});
				},
			}),
			defineFacet({
				id: "@test/controller",
				setup(env) {
					const service: AgentControllerService = {
						async prompt() {
							return { accepted: true, operationId: "op" };
						},
						async steer() {
							return { accepted: true, operationId: "op" };
						},
						async followUp() {
							return { accepted: true, operationId: "op" };
						},
						async cancelQueued() {
							return { outcome: "not_found" };
						},
						async abort() {},
						async compact() {
							return { accepted: true, operationId: "op" };
						},
						async waitForPrompt() {
							return { status: "unanswered", reason: "not used" };
						},
					};
					env.provide(AgentController, service);
				},
			}),
			defineFacet({
				id: "@test/plugins",
				setup(env) {
					env.provide(SessionPlugins, { reload: async () => {} });
				},
			}),
			createCommandsFacet({ cwd: process.cwd() }),
		],
	});
	const binding = createRemoteServiceBinding({
		services: [Commands],
		transport: loopback(host.services),
		bound: false,
	});
	await binding.rebind(true, BACKGROUND_CONTEXT);
	await binding.ready(BACKGROUND_CONTEXT);
	return {
		commands: binding.use(Commands),
		async dispose() {
			await binding.dispose();
			await host.dispose();
		},
	};
}

describe("the session's command catalogue at the service boundary", () => {
	test("lists a plugin's command beside the host's own and the terminal's own", async () => {
		const registry = new SlashCommandRegistry();
		const ran: string[] = [];
		const close = registry.register({
			name: "hello",
			description: "Say hello",
			argumentHint: "<who>",
			async run(args: string) {
				ran.push(args);
				return undefined;
			},
		});
		const session = await openCommands(registry);
		// A session's catalogue is re-read when its resources or plugins move; a client does that on
		// attach, so a command registered while the session starts is in the catalogue it sees.
		await session.commands.refresh(BACKGROUND_CONTEXT);
		const catalog: CommandSummary[] = session.commands.state.value?.commands ?? [];
		expect(catalog.find((command) => command.name === "hello")).toMatchObject({
			source: "plugin",
			availability: "all",
			argumentHint: "<who>",
		});
		expect(catalog.filter((command) => command.availability === "all").map((command) => command.name)).toContain(
			"model",
		);
		// The terminal's screen-only commands are listed as such, not left for a client to guess.
		expect(catalog.find((command) => command.name === "export")).toMatchObject({
			availability: "terminal",
			source: "builtin",
		});
		// A plugin's command runs through the same contract the terminal client uses.
		expect(await session.commands.run("hello", "world", BACKGROUND_CONTEXT)).toEqual({ ok: true, note: "Done." });
		expect(ran).toEqual(["world"]);
		close();
		await session.dispose();
	});

	test("refuses a terminal-only command with the reason, and an unknown one as unknown", async () => {
		const session = await openCommands(new SlashCommandRegistry());
		expect(await session.commands.run("export", "out.html", BACKGROUND_CONTEXT)).toEqual({
			ok: false,
			problem: "/export runs in the terminal only.",
		});
		expect(await session.commands.run("quit", "", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });
		expect(await session.commands.run("nope", "", BACKGROUND_CONTEXT)).toEqual({
			ok: false,
			problem: "Unknown command: /nope",
		});
		await session.dispose();
	});

	test("takes a plugin's later registration with the catalogue refresh", async () => {
		const registry = new SlashCommandRegistry();
		const session = await openCommands(registry);
		const before = session.commands.state.value?.commands.length ?? 0;
		const close = registry.register({ name: "later", description: "Registered later", async run() {} });
		// `/reload` is the moment a plugin change takes effect, and it re-reads the catalogue.
		await session.commands.refresh(BACKGROUND_CONTEXT);
		expect(session.commands.state.value?.commands.length).toBe(before + 1);
		expect((session.commands.state.value?.commands ?? []).some((command) => command.name === "later")).toBe(true);
		close();
		await session.dispose();
	});
});
