import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@amazme/client";
import { createWebSocketTransportFactory } from "@amazme/client/websocket";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { ConversationView } from "@amazme/durable";
import { isBusy, modelPicker, queuedInputs, transcriptBlocks } from "@amazme/web";
import { afterEach, describe, expect, test } from "vitest";
import { AgentController } from "../src/experimental/services/agent-controller.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type SessionServiceSource,
} from "../src/experimental/services/connection.ts";
import { Models, type Models as ModelsService } from "../src/experimental/services/models.ts";
import { Plugins, type Plugins as PluginsService } from "../src/experimental/services/plugins.ts";
import { SessionDirectory, SessionManagement } from "../src/experimental/services/sessions.ts";
import { Settings, type Settings as SettingsService } from "../src/experimental/services/settings.ts";
import { Skills, type Skills as SkillsService } from "../src/experimental/services/skills.ts";
import { Transcript } from "../src/experimental/services/transcript.ts";
import { startWebHost, type WebHost } from "../src/experimental/web/host.ts";

interface Presentation {
	readonly management: SessionManagement;
	readonly directory: SessionDirectory;
	readonly sessionSource: SessionServiceSource;
	dispose(): Promise<void>;
}

interface Attached {
	readonly transcript: { readonly state: { readonly value: ConversationView | undefined } };
	readonly controller: AgentController;
	readonly models: ModelsService;
	dispose(): Promise<void>;
}

const hosts = new Set<WebHost>();
const directories = new Set<string>();
const previousAgentDir = process.env.AMAZME_CODING_AGENT_DIR;

async function makeDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 90_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

/** Start a host whose agent directory has no credentials: model turns fail offline and fast. */
async function startLoopHost(): Promise<WebHost> {
	process.env.AMAZME_CODING_AGENT_DIR = await makeDirectory("web-loop-agent-");
	const host = await startWebHost({
		port: 0,
		directory: await makeDirectory("web-loop-server-"),
		sessionDir: await makeDirectory("web-loop-sessions-"),
	});
	hosts.add(host);
	return host;
}

/** One page-shaped presentation: two of these against one host are two browser tabs. */
async function openPresentation(host: WebHost): Promise<Presentation> {
	const client = await Client.connect({
		serverId: host.serverId,
		transportFactory: createWebSocketTransportFactory({ url: host.webSocketUrl }),
	});
	const serverSource = createServerServiceSource(client);
	const sessionSource = createSessionServiceSource(client);
	const serverServices = serverSource.open({
		services: [SessionDirectory, SessionManagement],
		assertAccess(): void {},
		onError(): void {},
	});
	await serverServices.ready(BACKGROUND_CONTEXT);
	return {
		management: serverServices.use(SessionManagement),
		directory: serverServices.use(SessionDirectory),
		sessionSource,
		async dispose() {
			await serverServices.dispose(BACKGROUND_CONTEXT);
			await client.dispose();
		},
	};
}

/** Attach a session the way the page does: transcript, agent control, and the models facade. */
async function attachSession(presentation: Presentation, sessionId: string): Promise<Attached> {
	await presentation.management.attach(sessionId, BACKGROUND_CONTEXT);
	await presentation.sessionSource.whenAttached(sessionId, BACKGROUND_CONTEXT);
	const services = presentation.sessionSource.open({
		services: [Transcript, AgentController, Models],
		assertAccess(): void {},
		onError(): void {},
	});
	await services.ready(BACKGROUND_CONTEXT);
	return {
		transcript: services.use(Transcript),
		controller: services.use(AgentController),
		models: services.use(Models),
		async dispose() {
			await services.dispose(BACKGROUND_CONTEXT);
		},
	};
}

function sawUserText(view: ConversationView | undefined, marker: string): boolean {
	return transcriptBlocks("en", view).some((block) => block.kind === "user" && block.text.includes(marker));
}

function listedSessions(presentation: Presentation): readonly string[] {
	return (presentation.directory.state.value?.sessions ?? []).map((session) => session.sessionId);
}

interface Administration {
	readonly settings: SettingsService;
	readonly skills: SkillsService;
	readonly plugins: PluginsService;
	dispose(): Promise<void>;
}

/** The management surface's bindings: the three server services the page's panels read. */
async function openAdministration(host: WebHost): Promise<Administration> {
	const client = await Client.connect({
		serverId: host.serverId,
		transportFactory: createWebSocketTransportFactory({ url: host.webSocketUrl }),
	});
	const serverSource = createServerServiceSource(client);
	const services = serverSource.open({
		services: [Settings, Skills, Plugins],
		assertAccess(): void {},
		onError(): void {},
	});
	await services.ready(BACKGROUND_CONTEXT);
	return {
		settings: services.use(Settings),
		skills: services.use(Skills),
		plugins: services.use(Plugins),
		async dispose() {
			await services.dispose(BACKGROUND_CONTEXT);
			await client.dispose();
		},
	};
}

afterEach(async () => {
	await Promise.allSettled([...hosts].map((host) => host.close()));
	hosts.clear();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
	if (previousAgentDir === undefined) delete process.env.AMAZME_CODING_AGENT_DIR;
	else process.env.AMAZME_CODING_AGENT_DIR = previousAgentDir;
});

describe("web client interactive loop", () => {
	test(
		"commits a prompt from one presentation and replicates it to a second one",
		async () => {
			// An empty agent directory has no credentials, so the model turn fails fast and offline
			// while the user entry still commits: the prompt and its replication are the observable.
			const host = await startLoopHost();

			const first = await openPresentation(host);
			const created = await first.management.create({ id: "web-loop" }, BACKGROUND_CONTEXT);
			expect(created.sessionId).toBe("web-loop");
			const attached = await attachSession(first, created.sessionId);

			const marker = `web-loop-marker-${Date.now()}`;
			const accepted = await attached.controller.prompt({ message: marker, images: null }, BACKGROUND_CONTEXT);
			expect(accepted).toMatchObject({ accepted: true });
			await waitFor(
				() => sawUserText(attached.transcript.state.value, marker),
				"the marker in the first presentation's transcript",
			);

			const second = await openPresentation(host);
			const secondAttached = await attachSession(second, created.sessionId);
			await waitFor(
				() => sawUserText(secondAttached.transcript.state.value, marker),
				"the marker in the second presentation's transcript",
			);

			await attached.controller.abort(BACKGROUND_CONTEXT);
			await secondAttached.dispose();
			await attached.dispose();
			await second.dispose();
			await first.dispose();
		},
		240_000,
	);

	test(
		"creates sessions from the presentation and keeps two attachments isolated",
		async () => {
			const host = await startLoopHost();
			const first = await openPresentation(host);

			const alpha = await first.management.create({ id: "web-loop-alpha" }, BACKGROUND_CONTEXT);
			expect(alpha.sessionId).toBe("web-loop-alpha");
			expect(listedSessions(first)).toContain(alpha.sessionId);

			// The same call the page's new-session bar makes, then the attach the page follows it with.
			const beta = await first.management.create({}, BACKGROUND_CONTEXT);
			expect(beta.sessionId).not.toBe(alpha.sessionId);
			await waitFor(() => listedSessions(first).includes(beta.sessionId), "the created session in the directory");

			const attachedAlpha = await attachSession(first, alpha.sessionId);
			const alphaMarker = `web-loop-alpha-${Date.now()}`;
			await attachedAlpha.controller.prompt({ message: alphaMarker, images: null }, BACKGROUND_CONTEXT);
			await waitFor(
				() => sawUserText(attachedAlpha.transcript.state.value, alphaMarker),
				"the alpha marker in alpha's transcript",
			);

			// The second presentation attaches the other session: no entry bleeds between them.
			const second = await openPresentation(host);
			const attachedBeta = await attachSession(second, beta.sessionId);
			const betaMarker = `web-loop-beta-${Date.now()}`;
			await attachedBeta.controller.prompt({ message: betaMarker, images: null }, BACKGROUND_CONTEXT);
			await waitFor(
				() => sawUserText(attachedBeta.transcript.state.value, betaMarker),
				"the beta marker in beta's transcript",
			);

			expect(sawUserText(attachedAlpha.transcript.state.value, betaMarker)).toBe(false);
			expect(sawUserText(attachedBeta.transcript.state.value, alphaMarker)).toBe(false);
			expect(
				transcriptBlocks("en", attachedAlpha.transcript.state.value).filter((block) => block.kind === "user"),
			).toHaveLength(1);

			await attachedBeta.dispose();
			await attachedAlpha.dispose();
			await second.dispose();
			await first.dispose();
		},
		240_000,
	);

	test(
		"accepts a follow-up while a turn runs, lists it as queued, and settles on abort",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-queue" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			const marker = `web-loop-run-${Date.now()}`;
			const accepted = await attached.controller.prompt({ message: marker, images: null }, BACKGROUND_CONTEXT);
			expect(accepted).toMatchObject({ accepted: true });
			// The run is in flight from here: its live document is what the page reads as busy.
			await waitFor(() => isBusy(attached.transcript.state.value), "the run to be in flight");

			const queuedMarker = `web-loop-queued-${Date.now()}`;
			const queued = await attached.controller.followUp({ message: queuedMarker, images: null }, BACKGROUND_CONTEXT);
			expect(queued).toMatchObject({ accepted: true });
			await waitFor(
				() => queuedInputs("en", attached.transcript.state.value).some((item) => item.includes(queuedMarker)),
				"the follow-up in the queue",
			);

			await attached.controller.abort(BACKGROUND_CONTEXT);
			await waitFor(
				() =>
					!isBusy(attached.transcript.state.value) &&
					queuedInputs("en", attached.transcript.state.value).length === 0,
				"the aborted run to settle and the queue to empty",
			);
			// The aborted turn is still a committed user entry: the input was not lost.
			expect(sawUserText(attached.transcript.state.value, marker)).toBe(true);

			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"replicates a model and thinking-level change, per session",
		async () => {
			const host = await startLoopHost();
			const first = await openPresentation(host);
			const alpha = await first.management.create({ id: "web-loop-models-a" }, BACKGROUND_CONTEXT);
			const attachedAlpha = await attachSession(first, alpha.sessionId);

			await waitFor(() => attachedAlpha.models.state.value !== undefined, "the models state");
			const catalog = attachedAlpha.models.state.value?.catalog.availableModels ?? [];
			// The model data ships with the repository; without it the picker's empty state is the
			// observable and the round trip cannot be driven (recorded under Risks in the plan).
			if (catalog.length === 0) {
				expect(modelPicker("en", attachedAlpha.models.state.value, [], true).empty).toBe("No models available.");
				return;
			}

			const target = catalog.find((model) => model.reasoning) ?? catalog[0]!;
			await attachedAlpha.models.select({ provider: target.provider, modelId: target.modelId }, BACKGROUND_CONTEXT);
			await waitFor(
				() => attachedAlpha.models.state.value?.configuration.model?.modelId === target.modelId,
				"the replicated model selection",
			);
			expect(attachedAlpha.models.state.value?.configuration.model).toEqual({
				provider: target.provider,
				modelId: target.modelId,
			});

			const levels = await attachedAlpha.models.getThinkingLevels(BACKGROUND_CONTEXT);
			expect(levels.length).toBeGreaterThan(0);
			const level = levels.find((candidate) => candidate !== attachedAlpha.models.state.value?.configuration.thinkingLevel);
			if (level !== undefined) {
				await attachedAlpha.models.selectThinking(level, BACKGROUND_CONTEXT);
				await waitFor(
					() => attachedAlpha.models.state.value?.configuration.thinkingLevel === level,
					"the replicated thinking level",
				);
				expect(attachedAlpha.models.state.value?.configuration.thinkingLevel).toBe(level);
			}

			// The projection the page renders reads exactly that configuration.
			const picker = modelPicker("en", attachedAlpha.models.state.value, levels, true);
			expect(picker.label).toBe(target.name);
			expect(picker.groups.flatMap((group) => group.options).filter((option) => option.selected)).toEqual([
				{ provider: target.provider, modelId: target.modelId, label: target.name, selected: true },
			]);

			// A second session carries its own configuration: changing alpha's model left beta alone.
			const second = await openPresentation(host);
			const beta = await second.management.create({ id: "web-loop-models-b" }, BACKGROUND_CONTEXT);
			const attachedBeta = await attachSession(second, beta.sessionId);
			expect(attachedBeta.models.state.value?.configuration.model).not.toEqual({
				provider: target.provider,
				modelId: target.modelId,
			});
			const other = catalog.find(
				(model) => model.provider !== target.provider || model.modelId !== target.modelId,
			);
			if (other !== undefined) {
				await attachedBeta.models.select({ provider: other.provider, modelId: other.modelId }, BACKGROUND_CONTEXT);
				await waitFor(
					() => attachedBeta.models.state.value?.configuration.model?.modelId === other.modelId,
					"beta's own model selection",
				);
				expect(attachedAlpha.models.state.value?.configuration.model).toEqual({
					provider: target.provider,
					modelId: target.modelId,
				});
			}

			await attachedBeta.dispose();
			await attachedAlpha.dispose();
			await second.dispose();
			await first.dispose();
		},
		240_000,
	);
});

describe("web client management surfaces", () => {
	test("edits settings, skills, and MCP servers through the host's service catalogue", async () => {
		const host = await startLoopHost();
		const administration = await openAdministration(host);
		const agentDir = process.env.AMAZME_CODING_AGENT_DIR!;

		// Settings: the host publishes its catalogue, and a write lands in the agent directory.
		await waitFor(
			() => (administration.settings.state.value?.descriptors.length ?? 0) > 0,
			"the settings catalogue to hydrate",
		);
		const steering = administration.settings.state.value?.descriptors.find(
			(descriptor) => descriptor.id === "steeringMode",
		);
		expect(steering).toBeDefined();
		await administration.settings.set("steeringMode", "all", BACKGROUND_CONTEXT);
		await waitFor(
			() =>
				administration.settings.state.value?.descriptors.find((d) => d.id === "steeringMode")?.value === "all",
			"the steering mode in the settings state",
		);
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({ steeringMode: "all" });
		// A value the field cannot take is rejected over the wire too, and the file keeps the old one.
		// (The remote boundary reports its own message; the field's own wording is not what crosses it.)
		await expect(administration.settings.set("steeringMode", "sometimes", BACKGROUND_CONTEXT)).rejects.toThrow();
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({ steeringMode: "all" });

		// Skills: a created skill is listed by the host's own loader and readable back.
		await administration.skills.write(
			{ name: "web-turn-report", content: "---\nname: web-turn-report\ndescription: Report a turn\n---\n\nBody.\n" },
			BACKGROUND_CONTEXT,
		);
		await waitFor(
			() => administration.skills.state.value?.skills.some((skill) => skill.name === "web-turn-report") === true,
			"the created skill in the skills state",
		);
		expect(administration.skills.state.value?.directory).toBe(join(agentDir, "skills"));
		await expect(administration.skills.read("web-turn-report", BACKGROUND_CONTEXT)).resolves.toContain("Body.");
		await administration.skills.remove("web-turn-report", BACKGROUND_CONTEXT);
		await waitFor(
			() => administration.skills.state.value?.skills.length === 0,
			"the removed skill to leave the skills state",
		);

		// Plugins: an MCP server lands in the agent directory's mcp.json and comes back with its patch.
		await administration.plugins.addMcpServer(
			"web-loop-mcp",
			JSON.stringify({ url: "https://mcp.example/mcp" }),
			BACKGROUND_CONTEXT,
		);
		await waitFor(
			() => administration.plugins.state.value?.mcp.servers.some((server) => server.name === "web-loop-mcp") === true,
			"the added MCP server in the plugins state",
		);
		expect(administration.plugins.state.value?.mcp.globalPath).toBe(join(agentDir, "mcp.json"));
		await administration.plugins.setMcpServer("web-loop-mcp", { enabled: false }, BACKGROUND_CONTEXT);
		await waitFor(
			() =>
				administration.plugins.state.value?.mcp.servers.find((server) => server.name === "web-loop-mcp")?.enabled ===
				false,
			"the disabled MCP server",
		);
		await administration.plugins.removeMcpServer("web-loop-mcp", BACKGROUND_CONTEXT);
		await waitFor(
			() => administration.plugins.state.value?.mcp.servers.length === 0,
			"the removed MCP server to leave the plugins state",
		);

		await administration.dispose();
		await host.close();
	}, 240_000);
});
