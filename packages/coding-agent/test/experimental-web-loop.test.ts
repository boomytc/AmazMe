import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@amazme/client";
import { createWebSocketTransportFactory } from "@amazme/client/websocket";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { ConversationView } from "@amazme/durable";
import {
	inboxOf,
	isBusy,
	liveOf,
	modelPicker,
	QUEUE_CANCEL_ACTION,
	queuedInputs,
	rosterItems,
	SESSION_REMOVE_ACTION,
	transcriptBlocks,
} from "@amazme/web";
import { afterEach, describe, expect, test } from "vitest";
import { AgentController } from "../src/core/plugins/agent-controller.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type SessionServiceSource,
} from "../src/host/services/connection.ts";
import { Commands, type Commands as CommandsService } from "../src/host/services/commands.ts";
import { Approvals, type Approvals as ApprovalsService } from "../src/host/services/approvals.ts";
import { Feedback, type Feedback as FeedbackService } from "../src/host/services/feedback.ts";
import { Conversations, type Conversations as ConversationsService } from "../src/host/services/conversations.ts";
import { Terminal, type Terminal as TerminalService } from "../src/host/services/terminal.ts";
import { Workspace, type Workspace as WorkspaceService } from "../src/host/services/workspace.ts";
import { Models, type Models as ModelsService } from "../src/host/services/models.ts";
import { Plugins, type Plugins as PluginsService } from "../src/host/services/plugins.ts";
import { Schedules, type Schedules as SchedulesService } from "../src/core/plugins/schedules.ts";
import { SessionDirectory, SessionManagement } from "../src/host/services/sessions.ts";
import { Settings, type Settings as SettingsService } from "../src/host/services/settings.ts";
import { Skills, type Skills as SkillsService } from "../src/host/services/skills.ts";
import { Transcript } from "../src/host/services/transcript.ts";
import { runClient } from "../src/host/client.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { listSessions, readSession, writeSessionName } from "../src/host/session-catalog.ts";
import { startWebHost, type WebHost } from "../src/host/web/host.ts";

interface Presentation {
	readonly client: Client;
	readonly management: SessionManagement;
	readonly directory: SessionDirectory;
	/** The server-scoped surfaces the page binds: the reader's ratings live here. */
	readonly feedback: FeedbackService;
	/** The planned prompts the host runs on their own. */
	readonly schedules: SchedulesService;
	readonly sessionSource: SessionServiceSource;
	dispose(): Promise<void>;
}

interface Attached {
	readonly transcript: { readonly state: { readonly value: ConversationView | undefined } };
	readonly controller: AgentController;
	readonly models: ModelsService;
	readonly commands: CommandsService;
	readonly workspace: WorkspaceService;
	readonly conversations: ConversationsService;
	readonly approvals: ApprovalsService;
	readonly terminal: TerminalService;
	dispose(): Promise<void>;
}

const hosts = new Set<WebHost>();
const modelServers = new Set<Server>();
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
interface LoopHost {
	readonly host: WebHost;
	/** The server directory the host publishes its Unix socket in: what a terminal client discovers. */
	readonly directory: string;
	readonly sessionDir: string;
}

/** A host with its scratch directories in hand, for tests that drive a second client against it. */
async function startHostWithDirectories(holdModel = false): Promise<LoopHost> {
	process.env.AMAZME_CODING_AGENT_DIR = await makeDirectory("web-loop-agent-");
	if (holdModel) {
		// Hold a local OpenAI-compatible request until cancellation. Queue tests must
		// control the busy interval instead of depending on ambient credentials or remote latency.
		const modelServer = createServer((request, response) => {
			if (request.url !== "/v1/chat/completions") response.writeHead(404).end();
			else request.resume();
		});
		await new Promise<void>((resolve, reject) => {
			modelServer.once("error", reject);
			modelServer.listen(0, "127.0.0.1", resolve);
		});
		modelServers.add(modelServer);
		await writeFile(
			join(process.env.AMAZME_CODING_AGENT_DIR, "models.json"),
			JSON.stringify({
				providers: {
					loop: {
						baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`,
						api: "openai-completions",
						apiKey: "fixture-key",
						models: [{ id: "held" }],
					},
				},
			}),
		);
		await writeFile(
			join(process.env.AMAZME_CODING_AGENT_DIR, "settings.json"),
			JSON.stringify({
				defaultProvider: "loop",
				defaultModel: "held",
				compaction: { keepRecentTokens: 1 },
			}),
		);
	}
	const directory = await makeDirectory("web-loop-server-");
	const sessionDir = await makeDirectory("web-loop-sessions-");
	const host = await startWebHost({ port: 0, directory, sessionDir, pluginPackages: [fileURLToPath(new URL("../plugins/automation", import.meta.url))] });
	hosts.add(host);
	return { host, directory, sessionDir };
}

async function startLoopHost(holdModel = false): Promise<WebHost> {
	return (await startHostWithDirectories(holdModel)).host;
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
		services: [SessionDirectory, SessionManagement, Feedback, Schedules],
		assertAccess(): void {},
		onError(): void {},
	});
	await serverServices.ready(BACKGROUND_CONTEXT);
	return {
		client,
		management: serverServices.use(SessionManagement),
		directory: serverServices.use(SessionDirectory),
		feedback: serverServices.use(Feedback),
		schedules: serverServices.use(Schedules),
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
		services: [Transcript, AgentController, Models, Commands, Workspace, Terminal, Conversations, Approvals],
		assertAccess(): void {},
		onError(): void {},
	});
	await services.ready(BACKGROUND_CONTEXT);
	return {
		transcript: services.use(Transcript),
		controller: services.use(AgentController),
		models: services.use(Models),
		commands: services.use(Commands),
		workspace: services.use(Workspace),
		conversations: services.use(Conversations),
		approvals: services.use(Approvals),
		terminal: services.use(Terminal),
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
	await Promise.all(
		[...modelServers].map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.closeAllConnections();
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
	modelServers.clear();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
	if (previousAgentDir === undefined) delete process.env.AMAZME_CODING_AGENT_DIR;
	else process.env.AMAZME_CODING_AGENT_DIR = previousAgentDir;
});

describe("web client interactive loop", () => {
	test("reuses the latest empty session across concurrent tabs and creates after input", async () => {
		const { host, sessionDir } = await startHostWithDirectories();
		const first = await openPresentation(host);
		const second = await openPresentation(host);
		const initial = await first.management.create({ reuseEmpty: true }, BACKGROUND_CONTEXT);
		const attached = await attachSession(first, initial.sessionId);
		await first.management.rename(initial.sessionId, "empty but named", BACKGROUND_CONTEXT);
		const reused = await Promise.all([
			first.management.create({ reuseEmpty: true }, BACKGROUND_CONTEXT),
			second.management.create({ reuseEmpty: true }, BACKGROUND_CONTEXT),
		]);
		expect(reused.map((session) => session.sessionId)).toEqual([initial.sessionId, initial.sessionId]);
		expect(await listSessions(sessionDir)).toHaveLength(1);
		const submitted = await attached.controller.prompt({ message: "first input", images: null }, BACKGROUND_CONTEXT);
		expect(submitted.accepted).toBe(true);
		await waitFor(() => sawUserText(attached.transcript.state.value, "first input"), "committed input before new session");
		const next = await first.management.create({ reuseEmpty: true }, BACKGROUND_CONTEXT);
		expect(next.sessionId).not.toBe(initial.sessionId);
		expect((await second.management.create({ reuseEmpty: true }, BACKGROUND_CONTEXT)).sessionId).toBe(next.sessionId);
		// Explicit creation remains independent for programmatic callers.
		const explicit = await first.management.create({ id: "explicit-independent" }, BACKGROUND_CONTEXT);
		expect(explicit.sessionId).toBe("explicit-independent");
		await attached.dispose();
		await first.dispose();
		await second.dispose();
	}, 180_000);

	test("automatically names committed first input and preserves manual renames in both tabs", async () => {
		const { host } = await startHostWithDirectories();
		const first = await openPresentation(host);
		const second = await openPresentation(host);
		const created = await first.management.create({ id: "auto-title" }, BACKGROUND_CONTEXT);
		const attached = await attachSession(first, created.sessionId);
		const submitted = await attached.controller.prompt({ message: "修复登录\n  保持会话", images: null }, BACKGROUND_CONTEXT);
		expect(submitted.accepted).toBe(true);
		await waitFor(() => second.directory.state.value?.sessions.find((session) => session.sessionId === created.sessionId)?.name === "修复登录 保持会话", "automatic title replicated to another tab");
		const mirror = (await SessionManager.listAll()).find((session) => session.id === created.sessionId);
		expect(mirror).toBeDefined();
		expect(SessionManager.open(mirror!.path).getSessionName()).toBe("修复登录 保持会话");
		const renamed = await first.management.rename(created.sessionId, "人工名称", BACKGROUND_CONTEXT);
		expect(renamed.sessionId).toBe(created.sessionId);
		expect(SessionManager.open(mirror!.path).getSessionName()).toBe("人工名称");
		expect(JSON.stringify(SessionManager.open(mirror!.path).getEntries())).toContain("修复登录");
		await attached.controller.abort(BACKGROUND_CONTEXT);
		await attached.dispose();
		const reopened = await attachSession(second, created.sessionId);
		await first.management.create({ id: "refresh-after-reopen" }, BACKGROUND_CONTEXT);
		await waitFor(() => second.directory.state.value?.sessions.find((session) => session.sessionId === created.sessionId)?.name === "人工名称", "manual title after reopen");
		await reopened.dispose();
		await first.dispose();
		await second.dispose();
	}, 180_000);

	test("an explicitly cleared name stays cleared after first input and worker restart", async () => {
		const { host, directory, sessionDir } = await startHostWithDirectories();
		const first = await openPresentation(host);
		const created = await first.management.create({ id: "manually-cleared" }, BACKGROUND_CONTEXT);
		await first.management.rename(created.sessionId, " ", BACKGROUND_CONTEXT);
		const attached = await attachSession(first, created.sessionId);
		expect(await attached.controller.prompt({ message: "must not become the title", images: null }, BACKGROUND_CONTEXT))
			.toMatchObject({ accepted: true });
		await waitFor(() => sawUserText(attached.transcript.state.value, "must not become the title"), "the first input");
		await attached.controller.abort(BACKGROUND_CONTEXT);
		await attached.dispose();
		await first.dispose();
		await host.close();
		hosts.delete(host);
		const restarted = await startWebHost({ port: 0, directory, sessionDir });
		hosts.add(restarted);
		const second = await openPresentation(restarted);
		const reopened = await attachSession(second, created.sessionId);
		await waitFor(() => sawUserText(reopened.transcript.state.value, "must not become the title"), "reopened history");
		expect(second.directory.state.value?.sessions.find((session) => session.sessionId === created.sessionId)?.name).toBeUndefined();
		expect(await readSession(sessionDir, created.sessionId)).toMatchObject({ nameSource: "manual" });
		expect((await readSession(sessionDir, created.sessionId))?.name).toBeUndefined();
		await reopened.dispose();
		await second.dispose();
	}, 180_000);

	test(
		"publishes the name /name stores onto the roster",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "named-session" }, BACKGROUND_CONTEXT);
			const renamed = await presentation.management.rename(created.sessionId, "weekly\nreport", BACKGROUND_CONTEXT);
			expect(renamed.name).toBe("weekly report");
			await waitFor(
				() => presentation.directory.state.value?.sessions.some((session) => session.sessionId === "named-session" && session.name === "weekly report") === true,
				"the roster name",
			);
			expect(rosterItems("en", presentation.directory.state.value, undefined, Date.now(), "weekly").map((item) => item.label)).toEqual(["weekly report"]);
			const cleared = await presentation.management.rename(created.sessionId, " ", BACKGROUND_CONTEXT);
			expect(cleared.name).toBeUndefined();
			await presentation.dispose();
		},
		120_000,
	);

	test(
		"a name set before the first turn is what listSessions returns, including after refresh",
		async () => {
			const { host } = await startHostWithDirectories();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "pre-turn-name" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);
			const renamed = await presentation.management.rename(created.sessionId, "foo", BACKGROUND_CONTEXT);
			expect(renamed.name).toBe("foo");
			await waitFor(
				() =>
					presentation.directory.state.value?.sessions.some(
						(session) => session.sessionId === "pre-turn-name" && session.name === "foo",
					) === true,
				"the name on the roster before the first turn",
			);
			const refreshed = await openPresentation(host);
			await waitFor(
				() =>
					refreshed.directory.state.value?.sessions.some(
						(session) => session.sessionId === "pre-turn-name" && session.name === "foo",
					) === true,
				"the name after refresh",
			);
			await attached.dispose();
			await refreshed.dispose();
			await presentation.dispose();
		},
		180_000,
	);

	test(
		"an empty worker meta does not cover a catalog name",
		async () => {
			const { host, sessionDir } = await startHostWithDirectories();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "kept-name" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);
			// The catalog gains a name the running worker was not told about.
			await writeSessionName(sessionDir, created.sessionId, "kept");
			await presentation.management.create({ id: "other-session" }, BACKGROUND_CONTEXT);
			await waitFor(
				() =>
					presentation.directory.state.value?.sessions.some(
						(session) => session.sessionId === "kept-name" && session.name === "kept",
					) === true,
				"the catalog name beside an unnamed worker",
			);
			await attached.dispose();
			await presentation.dispose();
		},
		180_000,
	);

	test(
		"a later catalog write wins over the name the worker was started with",
		async () => {
			const { host, sessionDir } = await startHostWithDirectories();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "carried-name" }, BACKGROUND_CONTEXT);
			await presentation.management.rename(created.sessionId, "early", BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);
			await writeSessionName(sessionDir, created.sessionId, "sneaky");
			await presentation.management.create({ id: "other-carried" }, BACKGROUND_CONTEXT);
			await waitFor(
				() => {
					const sessions = presentation.directory.state.value?.sessions ?? [];
					return (
						sessions.some((session) => session.sessionId === "other-carried") &&
						sessions.some((session) => session.sessionId === "carried-name" && session.name === "sneaky")
					);
				},
				"the catalog name over the name from launch",
			);
			const renamed = await presentation.management.rename(created.sessionId, "later", BACKGROUND_CONTEXT);
			expect(renamed.name).toBe("later");
			await waitFor(
				() =>
					presentation.directory.state.value?.sessions.some(
						(session) => session.sessionId === "carried-name" && session.name === "later",
					) === true,
				"the rename after the worker was already running",
			);
			await attached.dispose();
			await presentation.dispose();
		},
		180_000,
	);

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
		"a second web launch attaches to the running server instead of starting one",
		async () => {
			const { host: first, directory, sessionDir } = await startHostWithDirectories();
			const second = await startWebHost({ port: 0, directory, sessionDir });
			hosts.add(second);

			// One server: the second launch forwards its pages to the first host's server.
			expect(first.ownsServer).toBe(true);
			expect(second.ownsServer).toBe(false);
			expect(second.serverId).toBe(first.serverId);
			expect(second.socketPath).toBe(first.socketPath);
			// The page endpoint is still per-launch, so a stale document cannot keep a closed host alive.
			expect(second.webSocketUrl).not.toBe(first.webSocketUrl);

			// A session created through the first launch is in the second launch's roster: both pages
			// read one session directory from one server.
			const tabA = await openPresentation(first);
			const tabB = await openPresentation(second);
			const created = await tabA.management.create({ id: "shared-host" }, BACKGROUND_CONTEXT);
			await waitFor(() => listedSessions(tabB).includes(created.sessionId), "the session in the second tab");

			// And one session carries one live state: a prompt from the first tab reaches the second.
			const attachedA = await attachSession(tabA, created.sessionId);
			const attachedB = await attachSession(tabB, created.sessionId);
			const marker = `shared-host-${Date.now()}`;
			const accepted = await attachedA.controller.prompt({ message: marker, images: null }, BACKGROUND_CONTEXT);
			expect(accepted).toMatchObject({ accepted: true });
			await waitFor(() => sawUserText(attachedB.transcript.state.value, marker), "the marker across the bridge");

			await attachedA.controller.abort(BACKGROUND_CONTEXT);
			await attachedB.dispose();
			await attachedA.dispose();
			await tabB.dispose();
			await tabA.dispose();
		},
		240_000,
	);

	test(
		"the page's own boot sequence binds against a bridged host",
		async () => {
			const { host: first, directory, sessionDir } = await startHostWithDirectories();
			const second = await startWebHost({ port: 0, directory, sessionDir });
			hosts.add(second);
			expect(second.ownsServer).toBe(false);

			// The same client and the same service list the page's entry point opens, against the
			// bridged endpoint: a binding that fails here is the page's "cannot boot" line.
			const client = await Client.connect({
				serverId: second.serverId,
				transportFactory: createWebSocketTransportFactory({ url: second.webSocketUrl }),
			});
			const source = createServerServiceSource(client);
			const services = source.open({
				services: [SessionDirectory, SessionManagement, Settings, Skills, Plugins, Feedback, Schedules],
				assertAccess(): void {},
				onError(): void {},
			});
			try {
				await services.ready(BACKGROUND_CONTEXT);
				// Each service's state replicates on its own, so wait for the ones the page's panels
				// read rather than assuming one arrival means all of them.
				const settings = services.use(Settings);
				const skills = services.use(Skills);
				const plugins = services.use(Plugins);
				const feedback = services.use(Feedback);
				const schedules = services.use(Schedules);
				await waitFor(
					() =>
						settings.state.value !== undefined &&
						skills.state.value !== undefined &&
						plugins.state.value !== undefined &&
						feedback.state.value !== undefined &&
						schedules.state.value !== undefined,
					"the administration state over the bridge",
					30_000,
				);
				expect(settings.state.value?.descriptors.length).toBeGreaterThan(0);
				// The first host's server is what answered: its directory lists its sessions.
				const created = await services.use(SessionManagement).create({ id: "bridged-boot" }, BACKGROUND_CONTEXT);
				expect(created.sessionId).toBe("bridged-boot");
			} finally {
				await services.dispose(BACKGROUND_CONTEXT);
				await client.dispose();
			}
			expect(first.ownsServer).toBe(true);
		},
		240_000,
	);

	test(
		"the terminal client attaches to the same host and its prompt lands in the page",
		async () => {
			const { host, directory } = await startHostWithDirectories();
			const tab = await openPresentation(host);
			const created = await tab.management.create({ id: "terminal-shared" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(tab, created.sessionId);

			// The real client command: it discovers the host's server in the server directory and
			// attaches the page's session. Without credentials the turn fails, so the journey is
			// accepted either way; the user entry is what the page must show.
			const marker = `terminal-${Date.now()}`;
			await runClient(
				{ command: "client", sessionId: created.sessionId, prompt: marker },
				{ directory },
			).catch(() => undefined);
			await waitFor(() => sawUserText(attached.transcript.state.value, marker), "the terminal client's prompt");

			await attached.controller.abort(BACKGROUND_CONTEXT);
			await attached.dispose();
			await tab.dispose();
		},
		240_000,
	);

	describe("session handoff", () => {
		test(
			"a terminal session appears in the host's roster and continues there",
			async () => {
				const { host } = await startHostWithDirectories();
				// The terminal's own writer makes the session, the way the TUI would: a user prompt, a
				// reply, and a tool result. A host lists the terminal sessions of its own working
				// directory, so this session is made in the host's.
				const manager = SessionManager.create(process.cwd(), undefined, { id: "terminal-made" });
				manager.appendMessage({ role: "user", content: "from the terminal session", timestamp: Date.now() });
				manager.appendMessage({
					role: "assistant",
					content: [
						{ type: "text", text: "terminal reply" },
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.md" } },
					],
					provider: "test",
					model: "test",
					api: "test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
				manager.appendMessage({
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "tool output" }],
					isError: false,
					timestamp: Date.now(),
				});
				const file = manager.getSessionFile();
				expect(file).toBeDefined();

				const tab = await openPresentation(host);
				await waitFor(() => listedSessions(tab).includes("terminal-made"), "the terminal session in the roster");
				const listed = (tab.directory.state.value?.sessions ?? []).find(
					(session) => session.sessionId === "terminal-made",
				);
				expect(listed?.source).toBe("local");

				// Attaching it adopts it: the host stores the session and seeds it from the transcript.
				const attached = await attachSession(tab, "terminal-made");
				await waitFor(
					() => sawUserText(attached.transcript.state.value, "from the terminal session"),
					"the terminal prompt in the hosted transcript",
				);
				const blocks = transcriptBlocks("en", attached.transcript.state.value);
				expect(blocks.map((block) => block.text).join("\n")).toContain("terminal reply");
				// The tool result travels as its own entry, so the hosted transcript has a tool row
				// whose result is the terminal's.
				expect(blocks.some((block) => block.kind === "tool")).toBe(true);
				expect(JSON.stringify(attached.transcript.state.value)).toContain("tool output");

				// The host owns it now, and the terminal's file is the mirror of that same session.
				await waitFor(
					() =>
						(tab.directory.state.value?.sessions ?? []).find((session) => session.sessionId === "terminal-made")
							?.source === "host",
					"the adopted session in the roster",
				);
				await waitFor(() => existsSync(file ?? ""), "the terminal file the host mirrors into");

				await attached.dispose();
				await tab.dispose();
			},
			240_000,
		);

		test(
			"a client reconnects to a restarted host and finds the same session",
			async () => {
				// A host that owns the server can be closed and started again on the same port and
				// directories, which is what a restart looks like to a page that stayed open.
				const directory = await makeDirectory("web-loop-restart-server-");
				const sessionDir = await makeDirectory("web-loop-restart-sessions-");
				process.env.AMAZME_CODING_AGENT_DIR = await makeDirectory("web-loop-restart-agent-");
				const first = await startWebHost({ port: 0, directory, sessionDir });
				hosts.add(first);
				const port = Number(new URL(first.url).port);

				const before = await openPresentation(first);
				const created = await before.management.create({ id: "restart-me" }, BACKGROUND_CONTEXT);
				const attached = await attachSession(before, created.sessionId);
				const marker = `before-restart-${Date.now()}`;
				await attached.controller.prompt({ message: marker, images: null }, BACKGROUND_CONTEXT);
				await waitFor(() => sawUserText(attached.transcript.state.value, marker), "the prompt before the restart");
				await attached.dispose();

				// The host goes away: the client says so, and the page's own loop keeps the session.
				await first.close();
				await waitFor(() => before.client.connectionState === "disconnected", "the client to notice the host left");
				await before.dispose();

				const second = await startWebHost({ port, directory, sessionDir });
				hosts.add(second);
				expect(second.serverId).toBe(first.serverId);

				// A fresh page on the restarted host sees the committed transcript, and going on from
				// there commits into the same session.
				const after = await openPresentation(second);
				await waitFor(() => listedSessions(after).includes("restart-me"), "the session after the restart");
				const reattached = await attachSession(after, "restart-me");
				await waitFor(
					() => sawUserText(reattached.transcript.state.value, marker),
					"the prompt to survive the restart",
				);
				const next = `after-restart-${Date.now()}`;
				// The interrupted turn is recovered by the durable runtime, so the session stays busy
				// until it settles; a prompt during that window is refused, and taken once it is free.
				let accepted = await reattached.controller.prompt({ message: next, images: null }, BACKGROUND_CONTEXT);
				const deadline = Date.now() + 60_000;
				while (!accepted.accepted && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 500));
					accepted = await reattached.controller.prompt({ message: next, images: null }, BACKGROUND_CONTEXT);
				}
				expect(accepted, JSON.stringify(accepted)).toMatchObject({ accepted: true });
				await waitFor(() => sawUserText(reattached.transcript.state.value, next), "the prompt after the restart");

				await reattached.controller.abort(BACKGROUND_CONTEXT);
				await reattached.dispose();
				await after.dispose();
			},
			240_000,
		);

		test(
			"a session made on the host lands in the terminal's store and reads back",
			async () => {
				const { host } = await startHostWithDirectories();
				const tab = await openPresentation(host);
				const created = await tab.management.create({ id: "host-made" }, BACKGROUND_CONTEXT);
				const attached = await attachSession(tab, created.sessionId);

				const marker = `host-made-${Date.now()}`;
				const accepted = await attached.controller.prompt({ message: marker, images: null }, BACKGROUND_CONTEXT);
				expect(accepted).toMatchObject({ accepted: true });
				await waitFor(() => sawUserText(attached.transcript.state.value, marker), "the prompt in the transcript");

				// The mirror appears where the terminal lists its sessions, under the same id, and the
				// terminal's own reader reads the prompt back from it.
				let found = (await SessionManager.listAll()).find((session) => session.id === "host-made");
				const deadline = Date.now() + 90_000;
				while (found === undefined && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 200));
					found = (await SessionManager.listAll()).find((session) => session.id === "host-made");
				}
				expect(found).toBeDefined();
				expect(JSON.stringify(SessionManager.open(found!.path).getEntries())).toContain(marker);

				await attached.controller.abort(BACKGROUND_CONTEXT);
				await attached.dispose();
				await tab.dispose();
			},
			240_000,
		);

		test(
			"removes a session the host mirrored into the terminal's store, and the roster does not list it again",
			async () => {
				const { host, sessionDir } = await startHostWithDirectories();
				const tab = await openPresentation(host);
				const created = await tab.management.create({ id: "host-removed" }, BACKGROUND_CONTEXT);
				const attached = await attachSession(tab, created.sessionId);
				const marker = `host-removed-${Date.now()}`;
				expect(await attached.controller.prompt({ message: marker, images: null }, BACKGROUND_CONTEXT)).toMatchObject({
					accepted: true,
				});
				await waitFor(() => sawUserText(attached.transcript.state.value, marker), "the prompt in the transcript");

				// The committed transcript is mirrored into the terminal's store under the same id.
				let mirror = (await SessionManager.listAll()).find((session) => session.id === created.sessionId)?.path;
				const deadline = Date.now() + 90_000;
				while (mirror === undefined && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 200));
					mirror = (await SessionManager.listAll()).find((session) => session.id === created.sessionId)?.path;
				}
				expect(mirror).toBeDefined();
				await attached.dispose();

				await tab.management.remove(created.sessionId, BACKGROUND_CONTEXT);
				await waitFor(
					() => !listedSessions(tab).includes(created.sessionId),
					"the removed session to leave the roster",
					15_000,
				);
				expect(existsSync(join(sessionDir, created.sessionId))).toBe(false);
				expect(existsSync(mirror!)).toBe(false);

				await tab.dispose();
			},
			240_000,
		);

		test(
			"removes a terminal session the host has not opened, from the roster and from the terminal's store",
			async () => {
				const { host } = await startHostWithDirectories();
				// The terminal made this session in the host's working directory; no host has opened it yet.
				const manager = SessionManager.create(process.cwd(), undefined, { id: "terminal-removed" });
				manager.appendMessage({ role: "user", content: "terminal prompt", timestamp: Date.now() });
				manager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "terminal reply" }],
					provider: "test",
					model: "test",
					api: "test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
				const file = manager.getSessionFile();
				expect(file).toBeDefined();

				const tab = await openPresentation(host);
				await waitFor(() => listedSessions(tab).includes("terminal-removed"), "the terminal session in the roster");

				await tab.management.remove("terminal-removed", BACKGROUND_CONTEXT);
				await waitFor(
					() => !listedSessions(tab).includes("terminal-removed"),
					"the removed terminal session to leave the roster",
					15_000,
				);
				expect(existsSync(file!)).toBe(false);

				await tab.dispose();
			},
			240_000,
		);
	});

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
			const host = await startLoopHost(true);
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
				() =>
					queuedInputs("en", attached.transcript.state.value).some((item) => item.text.includes(queuedMarker)),
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
		"shows each session's working directory, and removes one behind a confirmation",
		async () => {
			const sessionDir = await makeDirectory("web-loop-remove-sessions-");
			const host = await startWebHost({
				port: 0,
				directory: await makeDirectory("web-loop-remove-server-"),
				sessionDir,
			});
			hosts.add(host);
			const first = await openPresentation(host);
			// A second presentation is the other browser tab: it must see the removal too.
			const second = await openPresentation(host);

			const created = await first.management.create({ id: "web-loop-remove" }, BACKGROUND_CONTEXT);
			const onDisk = join(sessionDir, created.sessionId);
			expect(existsSync(onDisk)).toBe(true);
			await waitFor(
				() => (second.directory.state.value?.sessions ?? []).some((session) => session.sessionId === created.sessionId),
				"the session in the second roster",
			);

			// The directory the host publishes carries the working directory the roster shows.
			const summary = first.directory.state.value?.sessions.find((session) => session.sessionId === created.sessionId);
			expect(summary).toMatchObject({ cwd: process.cwd() });

			// The page confirms before it asks: the row it renders names the session it would remove.
			expect(rosterItems("en", first.directory.state.value, created.sessionId, Date.now())[0]?.remove).toMatchObject({
				id: SESSION_REMOVE_ACTION,
				data: created.sessionId,
			});

			await first.management.remove(created.sessionId, BACKGROUND_CONTEXT);
			await waitFor(
				() => !(first.directory.state.value?.sessions ?? []).some((session) => session.sessionId === created.sessionId),
				"the session to leave the first roster",
			);
			await waitFor(
				() => !(second.directory.state.value?.sessions ?? []).some((session) => session.sessionId === created.sessionId),
				"the session to leave the second roster",
			);
			// Its storage is gone from the host's session directory.
			expect(existsSync(onDisk)).toBe(false);

			await second.dispose();
			await first.dispose();
		},
		240_000,
	);

	test(
		"plans a prompt, runs it against its session on demand, and records the outcome",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-schedule" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);
			await waitFor(() => presentation.schedules.state.value !== undefined, "the schedules state");
			expect(presentation.schedules.state.value?.schedules).toEqual([]);
			const path = presentation.schedules.state.value?.path ?? "";
			expect(path.endsWith("schedules.json")).toBe(true);

			// The page's add modal sends the attached session, the prompt, and the gap.
			const marker = `web-loop-schedule-${Date.now()}`;
			expect(
				await presentation.schedules.add(
					{ conversationId: "1", sessionId: created.sessionId, prompt: marker, id: randomUUID(), rule: { kind: "interval", everyMinutes: 60 }, busy: "queue", missed: "latest", graceMinutes: 10, timeoutSeconds: 600 },
					BACKGROUND_CONTEXT,
				),
			).toEqual({ ok: true, code: "added" });
			await waitFor(() => presentation.schedules.state.value?.schedules.length === 1, "the planned prompt");
			const planned = presentation.schedules.state.value?.schedules[0];
			expect(planned).toMatchObject({ conversationId: "1", sessionId: created.sessionId, prompt: marker, rule: { kind: "interval", everyMinutes: 60 }, enabled: true });
			// The file the CLI would read carries it.
			const file = JSON.parse(await readFile(path, "utf8")) as { schedules: readonly { prompt: string }[] };
			expect(file.schedules.map((schedule) => schedule.prompt)).toEqual([marker]);

			// Run now goes through the host's own runner: the prompt reaches the session's transcript.
			const run = await presentation.schedules.runNow(planned?.id ?? "", randomUUID(), BACKGROUND_CONTEXT);
			// The scratch agent directory has no credentials, so the turn settles without an answer;
			// what matters is that the run happened, was reported, and reached the real session.
			expect(run.ok).toBe(false);
			await waitFor(
				() => sawUserText(attached.transcript.state.value, marker),
				"the planned prompt in the session's transcript",
			);
			await waitFor(
				() => (presentation.schedules.state.value?.schedules[0]?.history.length ?? 0) > 0,
				"the recorded outcome",
			);
			const recorded = presentation.schedules.state.value?.schedules[0];
			expect(recorded?.history.at(-1)?.startedAt).toBeGreaterThan(0);
			expect(recorded?.history.at(-1)?.status).toBe("unanswered");
			expect(JSON.parse(await readFile(path, "utf8")).schedules[0].history.at(-1).status).toBe(recorded?.history.at(-1)?.status);

			// Pausing is replicated, and it keeps the outcome the run recorded.
			expect(await presentation.schedules.setEnabled(planned?.id ?? "", false, BACKGROUND_CONTEXT)).toEqual({
				ok: true,
				code: "paused",
			});
			await waitFor(() => presentation.schedules.state.value?.schedules[0]?.enabled === false, "the paused schedule");
			await presentation.schedules.remove(planned?.id ?? "", BACKGROUND_CONTEXT);
			await waitFor(() => presentation.schedules.state.value?.schedules.length === 0, "the removed schedule");
			expect(JSON.parse(await readFile(path, "utf8")).schedules).toEqual([]);
			// A schedule the host does not have is refused rather than silently accepted.
			expect(
				await presentation.schedules.add({ conversationId: "1", sessionId: "", prompt: "x", id: randomUUID(), rule: { kind: "interval", everyMinutes: 5 }, busy: "queue", missed: "latest", graceMinutes: 10, timeoutSeconds: 600 }, BACKGROUND_CONTEXT),
			).toMatchObject({ ok: false });
			expect(await presentation.schedules.add({ conversationId: "1", sessionId: created.sessionId, prompt: "  ", id: randomUUID(), rule: { kind: "interval", everyMinutes: 5 }, busy: "queue", missed: "latest", graceMinutes: 10, timeoutSeconds: 600 }, BACKGROUND_CONTEXT)).toMatchObject({
				ok: false,
			});

			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"removes the session a presentation is attached to, for that tab and for another",
		async () => {
			// A host reads the terminal store of its agent directory, so this test pins one.
			process.env.AMAZME_CODING_AGENT_DIR = await makeDirectory("web-loop-selfremove-agent-");
			const sessionDir = await makeDirectory("web-loop-selfremove-sessions-");
			const host = await startWebHost({
				port: 0,
				directory: await makeDirectory("web-loop-selfremove-server-"),
				sessionDir,
			});
			hosts.add(host);
			const first = await openPresentation(host);
			// The other tab attaches a different session, so only the first one is removing its own.
			const keeper = await first.management.create({ id: "web-loop-keeper" }, BACKGROUND_CONTEXT);
			const second = await openPresentation(host);
			const attachedKeeper = await attachSession(second, keeper.sessionId);

			const created = await first.management.create({ id: "web-loop-self" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(first, created.sessionId);
			expect(existsSync(join(sessionDir, created.sessionId))).toBe(true);
			await waitFor(
				() => (second.directory.state.value?.sessions ?? []).some((session) => session.sessionId === created.sessionId),
				"the session in the second roster",
			);

			// The page detaches the session it is about to delete while it asks the host to remove it,
			// so the two calls are in flight together, the way the page runs them.
			await attached.dispose();
			void first.management.detach(BACKGROUND_CONTEXT);
			await first.management.remove(created.sessionId, BACKGROUND_CONTEXT);
			await waitFor(
				() => !(first.directory.state.value?.sessions ?? []).some((session) => session.sessionId === created.sessionId),
				"the removed session to leave the removing tab's roster",
			);
			expect(first.directory.state.value?.sessions.map((session) => session.sessionId)).toEqual([keeper.sessionId]);
			await waitFor(
				() => !(second.directory.state.value?.sessions ?? []).some((session) => session.sessionId === created.sessionId),
				"the removed session to leave the other tab's roster",
			);
			expect(existsSync(join(sessionDir, created.sessionId))).toBe(false);

			await attachedKeeper.dispose();
			await second.dispose();
			await first.dispose();
		},
		240_000,
	);

	test(
		"rates an answer through the server catalogue and writes it to the agent directory",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-feedback" }, BACKGROUND_CONTEXT);
			await presentation.management.attach(created.sessionId, BACKGROUND_CONTEXT);
			await waitFor(() => presentation.feedback.state.value !== undefined, "the feedback state");

			const request = { sessionId: created.sessionId, conversationId: "1", entryId: "7" };
			expect(presentation.feedback.state.value?.path.endsWith("feedback.json")).toBe(true);
			expect(await presentation.feedback.rate({ ...request, rating: "up" }, BACKGROUND_CONTEXT)).toEqual({ ok: true });
			await waitFor(
				() => (presentation.feedback.state.value?.records ?? []).some((record) => record.entryId === "7"),
				"the rating to replicate",
			);
			// The same answer rated again replaces the record rather than adding one.
			expect(await presentation.feedback.rate({ ...request, rating: "down" }, BACKGROUND_CONTEXT)).toEqual({ ok: true });
			await waitFor(
				() => presentation.feedback.state.value?.records.find((record) => record.entryId === "7")?.rating === "down",
				"the replaced rating",
			);
			expect(presentation.feedback.state.value?.records.filter((record) => record.entryId === "7")).toHaveLength(1);
			// The file the CLI would read carries it.
			const path = presentation.feedback.state.value?.path ?? "";
			const file = JSON.parse(await readFile(path, "utf8")) as { records: readonly { entryId: string }[] };
			expect(file.records.map((record) => record.entryId)).toContain("7");
			expect(await presentation.feedback.retract(request, BACKGROUND_CONTEXT)).toEqual({ ok: true });
			await waitFor(
				() => !(presentation.feedback.state.value?.records ?? []).some((record) => record.entryId === "7"),
				"the withdrawn rating",
			);

			await presentation.dispose();
		},
		240_000,
	);

	test(
		"publishes the approvals surface: nothing pending, and an unknown decision is refused",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-approvals" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			// The service's state reaches the client, and its list starts empty.
			await waitFor(() => attached.approvals.state.value !== undefined, "the approvals state");
			expect(attached.approvals.state.value?.pending).toEqual([]);
			// A decision for a request that is not pending reports that nothing was waiting.
			expect(await attached.approvals.decide("approval-none", true, BACKGROUND_CONTEXT)).toBe(false);

			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"lists the session's conversations, pages its history, and talks to it",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-conversations" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			// The root is the only conversation at first, and it is marked as such.
			await waitFor(
				() => (attached.conversations.state.value?.conversations ?? []).length > 0,
				"the conversation list",
			);
			const list = attached.conversations.state.value?.conversations ?? [];
			expect(list).toHaveLength(1);
			expect(list[0]).toMatchObject({ root: true, label: "main" });
			expect(attached.conversations.state.value?.selected).toBe(list[0]?.id);
			const rootId = list[0]?.id ?? "";

			// Three prompts, one after the other settles: a prompt while one runs is rejected as busy.
			for (const marker of ["first marker", "second marker", "third marker"]) {
				expect(
					await attached.conversations.prompt(rootId, { message: marker, images: null }, BACKGROUND_CONTEXT),
				).toMatchObject({ accepted: true });
				await waitFor(() => sawUserText(attached.transcript.state.value, marker), `the ${marker} to commit`);
				await waitFor(() => !isBusy(attached.transcript.state.value), "the turn to settle");
			}
			// A page that starts below what the transcript shows is empty at the start of a
			// conversation: the oldest entry it shows is the oldest entry there is.
			const shownOldest = attached.transcript.state.value?.entries[0]?.id ?? 0;
			const older = await attached.conversations.older(rootId, String(shownOldest), null, 5, BACKGROUND_CONTEXT);
			expect(older.entries).toEqual([]);
			expect(older.cursor).toBeUndefined();

			// Without that bound a page is the newest slice of the stored history, and it carries what
			// the transcript itself carries: the user entries are the same.
			const page = await attached.conversations.older(rootId, null, null, 10, BACKGROUND_CONTEXT);
			// A page small enough to leave history behind carries a cursor, and the next page walks older.
			const newest = await attached.conversations.older(rootId, null, null, 2, BACKGROUND_CONTEXT);
			expect(newest.entries).toHaveLength(2);
			expect(newest.cursor).toBeDefined();
			const next = await attached.conversations.older(rootId, null, newest.cursor ?? null, 2, BACKGROUND_CONTEXT);
			expect(next.entries.every((entry) => entry.id < newest.entries[0]!.id)).toBe(true);
			const texts = page.entries
				.flatMap((entry) => entry.model ?? [])
				.filter((message) => message.role === "user")
				.map((message) => JSON.stringify(message.content));
			expect(texts.some((text) => text.includes("first marker"))).toBe(true);
			expect(texts.some((text) => text.includes("second marker"))).toBe(true);

			// Focusing the root keeps its own live transcript rather than a second view.
			await attached.conversations.select(rootId, BACKGROUND_CONTEXT);
			expect(attached.conversations.state.value?.selected).toBe(rootId);
			expect(attached.conversations.state.value?.view).toBeNull();

			// The live task graph is published alongside, and asking for a refresh settles.
			expect(Array.isArray(attached.conversations.state.value?.tasks)).toBe(true);
			await attached.conversations.refresh(BACKGROUND_CONTEXT);
			expect((attached.conversations.state.value?.conversations ?? []).length).toBe(1);

			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"browses the session's working directory and runs a command in it",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-workspace" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			// The listing is the Session's working directory, and it activates with real entries.
			await waitFor(
				() => (attached.workspace.state.value?.view.kind === "listing" ? attached.workspace.state.value.view.entries.length : 0) > 0,
				"the working directory listing",
			);
			const workspace = attached.workspace.state.value;
			expect(workspace?.cwd).toBe(process.cwd());
			const listing = workspace?.view;
			if (listing?.kind !== "listing") throw new Error("the workspace did not list its directory");
			// The entries are the real ones on disk, in the directory order the provider sorts.
			const onDisk = await readdir(process.cwd());
			const listed = listing.entries.map((entry) => entry.name);
			expect(listed.length).toBeGreaterThan(0);
			expect(listed.every((name) => onDisk.includes(name))).toBe(true);
			expect(listed.length).toBeLessThanOrEqual(onDisk.length);

			// Reading a file returns its real bytes, and walking into a directory lists that one.
			const target = listing.entries.find((entry) => entry.kind === "file");
			expect(target).toBeDefined();
			for (const entry of listing.entries.filter((candidate) => candidate.kind === "dir").slice(0, 1)) {
				await attached.workspace.open(entry.name, BACKGROUND_CONTEXT);
				await waitFor(
					() =>
						attached.workspace.state.value?.view.kind === "listing" &&
						attached.workspace.state.value.view.path === entry.name,
					`the ${entry.name} listing`,
				);
				const nested = attached.workspace.state.value?.view;
				if (nested?.kind === "listing") {
					expect(nested.parent).toBe(".");
					await attached.workspace.open(".", BACKGROUND_CONTEXT);
				}
			}
			await attached.workspace.read(target?.name ?? "", BACKGROUND_CONTEXT);
			await waitFor(() => attached.workspace.state.value?.view.kind === "text", "the file's text");
			const text = attached.workspace.state.value?.view;
			if (text?.kind !== "text") throw new Error("the workspace did not read the file");
			expect(text.path).toBe(target?.name);
			expect(text.text).toBe(await readFile(join(process.cwd(), target?.name ?? ""), "utf8"));

			// A path above the working directory is refused rather than resolved.
			await attached.workspace.read("../package.json", BACKGROUND_CONTEXT);
			await waitFor(() => attached.workspace.state.value?.view.kind === "denied", "the refusal");
			expect(attached.workspace.state.value?.view).toMatchObject({ kind: "denied", path: "../package.json" });
			await attached.workspace.read("no-such-file-anywhere.txt", BACKGROUND_CONTEXT);
			await waitFor(() => attached.workspace.state.value?.view.kind === "missing", "the missing path");

			// The terminal runs in the same directory and streams its real output.
			const marker = `web-loop-terminal-${Date.now()}`;
			expect(await attached.terminal.run(`echo ${marker}`, BACKGROUND_CONTEXT)).toEqual({ ok: true });
			await waitFor(() => attached.terminal.state.value?.status !== "running", "the command to finish");
			expect(attached.terminal.state.value).toMatchObject({ status: "done", exitCode: 0 });
			expect(attached.terminal.state.value?.output).toContain(marker);

			// A second command is refused while one runs, and stopping leaves it cancelled.
			const slow = attached.terminal.run("sleep 30; echo never", BACKGROUND_CONTEXT);
			await waitFor(() => attached.terminal.state.value?.status === "running", "the slow command");
			expect(await attached.terminal.run("echo too-soon", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });
			await attached.terminal.stop(BACKGROUND_CONTEXT);
			expect(await slow).toEqual({ ok: true });
			await waitFor(() => attached.terminal.state.value?.status === "cancelled", "the cancellation");
			expect(attached.terminal.state.value?.output ?? "").not.toContain("never");

			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"runs the session's own commands through the real client",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-commands" }, BACKGROUND_CONTEXT);
			// A template and a skill in the agent directory become commands of the session the reader
			// attaches: the same two resources the terminal lists, read by the host's own loaders.
			const agentDir = process.env.AMAZME_CODING_AGENT_DIR!;
			await mkdir(join(agentDir, "prompts"), { recursive: true });
			await writeFile(
				join(agentDir, "prompts", "web-loop-report.md"),
				"---\ndescription: Draft the loop report\n---\n\nReport for $1.\n",
				"utf8",
			);
			await mkdir(join(agentDir, "skills", "web-loop-brief"), { recursive: true });
			await writeFile(
				join(agentDir, "skills", "web-loop-brief", "SKILL.md"),
				"---\nname: web-loop-brief\ndescription: Draft a brief\n---\n\n# Steps\n\nWrite it.\n",
				"utf8",
			);
			const attached = await attachSession(presentation, created.sessionId);

			await waitFor(() => (attached.commands.state.value?.commands ?? []).length > 4, "the command catalogue");
			const catalogue = attached.commands.state.value?.commands ?? [];
			// What this host runs and expands comes first; the terminal's own commands follow, marked
			// so a client refuses them with a reason instead of sending the text to the model.
			const runnable = catalogue.filter((command) => command.availability === "all");
			expect(runnable.map((command) => [command.name, command.source])).toEqual([
				["model", "builtin"],
				["thinking", "builtin"],
				["compact", "builtin"],
				["reload", "builtin"],
				["web-loop-report", "template"],
				["skill:web-loop-brief", "skill"],
			]);
			expect(runnable.every((command) => command.source !== "builtin" || command.name !== "export")).toBe(true);
			expect(catalogue.find((command) => command.name === "export")).toMatchObject({
				availability: "terminal",
				source: "builtin",
			});
			expect(await attached.commands.run("export", "", BACKGROUND_CONTEXT)).toEqual({
				ok: false,
				problem: "/export runs in the terminal only.",
			});
			expect(catalogue.find((command) => command.name === "model")?.argumentHint).toBe("<provider/model>");
			// The host expands a resource command with the same code the terminal uses, and the
			// presentation sends the prompt on its own path.
			expect(await attached.commands.expand("web-loop-report", "w34", BACKGROUND_CONTEXT)).toEqual({
				ok: true,
				prompt: "Report for w34.",
			});
			const skillPrompt = await attached.commands.expand("skill:web-loop-brief", "", BACKGROUND_CONTEXT);
			expect(skillPrompt.ok && skillPrompt.prompt).toContain("<skill name=\"web-loop-brief\"");
			expect(skillPrompt.ok && skillPrompt.prompt).toContain("# Steps\n\nWrite it.");
			expect(await attached.commands.expand("nope", "", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });
			// A built-in is not a prompt; the presentation runs it instead.
			expect(await attached.commands.expand("model", "", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });

			await waitFor(() => attached.models.state.value !== undefined, "the models state");
			// /thinking takes a level the attached model reports, and says so when it does not.
			const levels = await attached.models.getThinkingLevels(BACKGROUND_CONTEXT);
			const level = levels[levels.length - 1] ?? "low";
			expect(await attached.commands.run("thinking", level, BACKGROUND_CONTEXT)).toEqual({
				ok: true,
				note: `Thinking level: ${level}.`,
			});
			await waitFor(
				() => attached.models.state.value?.configuration.thinkingLevel === level,
				"the level the command selected",
			);
			const rejected = await attached.commands.run("thinking", "nonsense", BACKGROUND_CONTEXT);
			expect(rejected.ok).toBe(false);
			expect(rejected.ok ? "" : rejected.problem).toContain("Unknown thinking level");

			// /model selects a catalogue entry and completes from the same catalogue.
			const catalog = attached.models.state.value?.catalog.availableModels ?? [];
			if (catalog.length === 0) {
				// Without the repository's model data there is nothing to select; the problem is the answer.
				expect(await attached.commands.run("model", "provider/model", BACKGROUND_CONTEXT)).toMatchObject({
					ok: false,
				});
				expect(await attached.commands.run("model", "", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });
			} else {
				const target = catalog[0]!;
				expect(
					await attached.commands.run("model", `${target.provider}/${target.modelId}`, BACKGROUND_CONTEXT),
				).toEqual({ ok: true, note: `Selected ${target.provider}/${target.modelId}.` });
				await waitFor(
					() => attached.models.state.value?.configuration.model?.modelId === target.modelId,
					"the model the command selected",
				);
				const completions = await attached.commands.complete("model", target.modelId, BACKGROUND_CONTEXT);
				expect(completions.some((completion) => completion.value === `${target.provider}/${target.modelId}`)).toBe(
					true,
				);
			}

			// /compact is the same durable task the header's control reaches.
			expect(await attached.commands.run("compact", "keep the markers", BACKGROUND_CONTEXT)).toEqual({
				ok: true,
				note: "Compacting the conversation.",
			});
			// /reload rebuilds this session's plugin generation and re-reads its command resources,
			// and an unknown name is a problem.
			expect(await attached.commands.run("reload", "", BACKGROUND_CONTEXT)).toEqual({
				ok: true,
				note: "Reloaded this session's plugins and command resources.",
			});
			expect(await attached.commands.run("nope", "", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });

			await attached.controller.abort(BACKGROUND_CONTEXT);
			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"sends an image with a prompt, commits it in the entry, and reads it back",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-images" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			// A real 1x1 PNG: the bytes the page would read out of a picked file.
			const png =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
			expect(Buffer.from(png, "base64").subarray(0, 4).toString("hex")).toBe("89504e47");

			const marker = `web-loop-image-${Date.now()}`;
			const accepted = await attached.controller.prompt(
				{ message: marker, images: [{ type: "image", data: png, mimeType: "image/png" }] },
				BACKGROUND_CONTEXT,
			);
			expect(accepted).toMatchObject({ accepted: true });

			// The committed entry carries the image with its media type, and the projection shows it.
			const blockOf = (): ReturnType<typeof transcriptBlocks>[number] | undefined =>
				transcriptBlocks("en", attached.transcript.state.value).find(
					(block) => block.kind === "user" && block.text.includes(marker),
				);
			await waitFor(() => blockOf() !== undefined, "the image prompt to commit");
			expect(blockOf()?.images).toEqual([{ dataUrl: `data:image/png;base64,${png}`, alt: "image/png" }]);
			// The committed entry itself carries the bytes the page sent, not a re-encoding.
			const committed = attached.transcript.state.value?.entries.find((candidate) => {
				const message = candidate.model?.[0];
				return message?.role === "user" && JSON.stringify(message.content).includes(marker);
			});
			const content = committed?.model?.[0]?.role === "user" ? committed.model[0].content : undefined;
			const image =
				typeof content === "string" ? undefined : content?.find((block) => block.type === "image");
			expect(image).toEqual({ type: "image", data: png, mimeType: "image/png" });

			// A second presentation sees the same image: it is the durable entry, not page state.
			const second = await attachSession(presentation, created.sessionId);
			await waitFor(
				() =>
					transcriptBlocks("en", second.transcript.state.value).some(
						(block) => block.kind === "user" && (block.images ?? []).length === 1,
					),
				"the image in a second presentation",
			);
			expect(
				transcriptBlocks("en", second.transcript.state.value).find((block) => block.kind === "user")?.images,
			).toEqual([{ dataUrl: `data:image/png;base64,${png}`, alt: "image/png" }]);

			await attached.controller.abort(BACKGROUND_CONTEXT);
			await second.dispose();
			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"withdraws one queued input, steers another, compacts, and refreshes the catalog",
		async () => {
			const host = await startLoopHost(true);
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-run-control" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			const marker = `web-loop-run-control-${Date.now()}`;
			const accepted = await attached.controller.prompt({ message: marker, images: null }, BACKGROUND_CONTEXT);
			expect(accepted).toMatchObject({ accepted: true });
			await waitFor(() => isBusy(attached.transcript.state.value), "the run to be in flight");

			// Two queued inputs, then withdraw exactly the one whose strip the page rendered.
			const withdrawnMarker = `web-loop-withdraw-${Date.now()}`;
			const keptMarker = `web-loop-keep-${Date.now()}`;
			await attached.controller.followUp({ message: withdrawnMarker, images: null }, BACKGROUND_CONTEXT);
			await attached.controller.followUp({ message: keptMarker, images: null }, BACKGROUND_CONTEXT);
			await waitFor(
				() => queuedInputs("en", attached.transcript.state.value).length === 2,
				"both follow-ups in the queue",
			);

			const strip = queuedInputs("en", attached.transcript.state.value).find((item) =>
				item.text.includes(withdrawnMarker),
			);
			expect(strip).toBeDefined();
			// The strip's own control names its submission, which is what the page sends back.
			expect(strip?.cancel).toMatchObject({ id: QUEUE_CANCEL_ACTION, data: strip?.id });
			expect(await attached.controller.cancelQueued(strip?.id ?? "", BACKGROUND_CONTEXT)).toMatchObject({
				outcome: "cancelled",
			});
			await waitFor(
				() => queuedInputs("en", attached.transcript.state.value).length === 1,
				"the withdrawn input to leave the queue",
			);
			expect(queuedInputs("en", attached.transcript.state.value)[0]?.text).toContain(keptMarker);

			// A steer is an admission of its own: the durable inbox records its mode.
			const steerMarker = `web-loop-steer-${Date.now()}`;
			expect(
				await attached.controller.steer({ message: steerMarker, images: null }, BACKGROUND_CONTEXT),
			).toMatchObject({ accepted: true });
			await waitFor(
				() =>
					inboxOf(attached.transcript.state.value as ConversationView).items.some((item) => item.mode === "steer"),
				"the steer in the durable inbox",
			);

			// Compaction on demand: the request reaches the durable task the live document shows.
			expect(
				await attached.controller.compact({ customInstructions: "keep the marker" }, BACKGROUND_CONTEXT),
			).toMatchObject({ accepted: true });
			await waitFor(
				() => (liveOf(attached.transcript.state.value as ConversationView).compactions ?? []).length > 0,
				"the compaction task in the live document",
			);

			// A catalog refresh settles instead of staying in flight.
			await attached.models.refresh(BACKGROUND_CONTEXT);
			await waitFor(
				() => attached.models.state.value?.refresh.status !== "refreshing",
				"the catalog refresh to settle",
			);
			expect(["done", "warning"]).toContain(attached.models.state.value?.refresh.status);

			await attached.controller.abort(BACKGROUND_CONTEXT);
			await waitFor(() => !isBusy(attached.transcript.state.value), "the aborted run to settle");
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
