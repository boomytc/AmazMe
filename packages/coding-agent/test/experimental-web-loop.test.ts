import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@amazme/client";
import { createWebSocketTransportFactory } from "@amazme/client/websocket";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { ConversationView } from "@amazme/durable";
import { replicatedState, type ReplicatedState } from "@amazme/chord";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
import type { PageRenderer, WebView } from "@amazme/web";
import {
	BOOT_GLOBAL,
	CONVERSATION_RENAME_ACTION,
	CONVERSATION_RENAME_MODAL,
	CONVERSATION_ARCHIVE_ACTION,
	CONVERSATION_ARCHIVE_MODAL,
	CONVERSATION_RESTORE_ACTION,
	DOCK_TAB_ACTION,
	WORKSPACE_OPEN_ACTION,
	WORKSPACE_READ_ACTION,
	WORKSPACE_PAGE_ACTION,
	WORKSPACE_RELOAD_ACTION,
	SESSION_ARCHIVE_OPEN_ACTION,
	SESSION_RESTORE_ACTION,
	SETTINGS_VIEW,
	SETTINGS_FIELD_ACTION,
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
import { afterEach, describe, expect, test, vi } from "vitest";
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
import { createTerminalService, TERMINAL_MAX_BYTES } from "../src/host/services/terminal-provider.ts";
import { Workspace, type Workspace as WorkspaceService } from "../src/host/services/workspace.ts";
import { Models, type Models as ModelsService } from "../src/host/services/models.ts";
import { Plugins, type Plugins as PluginsService } from "../src/host/services/plugins.ts";
import { Schedules, type Schedules as SchedulesService } from "../src/core/plugins/schedules.ts";
import { SessionDirectory, SessionManagement } from "../src/host/services/sessions.ts";
import { isProjectSelection, ProjectManagement, SessionArchive } from "../src/host/services/projects.ts";
import { Settings, type Settings as SettingsService } from "../src/host/services/settings.ts";
import { Skills, type Skills as SkillsService } from "../src/host/services/skills.ts";
import { Transcript } from "../src/host/services/transcript.ts";
import { runClient } from "../src/host/client.ts";
import { FileSettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { SessionWorkerManager } from "../src/host/session-worker-manager.ts";
import { DEFAULT_TYPOGRAPHY } from "@amazme/web/typography";
import { listSessions, readSession, writeSessionName } from "../src/host/session-catalog.ts";
import { startWebHost, type WebHost } from "../src/host/web/host.ts";
import { startPage } from "../src/host/web/page.ts";

interface Presentation {
	readonly client: Client;
	readonly management: SessionManagement;
	readonly directory: SessionDirectory;
	readonly archives: SessionArchive;
	readonly projects: ProjectManagement;
	/** The server-scoped surfaces the page binds: the reader's ratings live here. */
	readonly feedback: FeedbackService;
	/** The planned prompts the host runs on their own. */
	readonly schedules: SchedulesService | undefined;
	readonly sessionSource: SessionServiceSource;
	dispose(): Promise<void>;
}

interface Attached {
	readonly transcript: { readonly state: ReplicatedState<ConversationView> };
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
const pageDisposers = new Set<() => Promise<void>>();

/** Drive the real page lifecycle without a DOM renderer or additional browser dependencies. */
async function openPage(host: WebHost, storage = new Map<string, string>()) {
	const lifetime = new EventTarget();
	vi.stubGlobal(BOOT_GLOBAL, {
		server: { id: host.serverId }, transport: { url: host.webSocketUrl },
		preferences: { locale: "zh", appearance: "light", typography: { ...DEFAULT_TYPOGRAPHY } },
	});
	vi.stubGlobal("navigator", { languages: ["zh-CN"], platform: "" });
	vi.stubGlobal("HTMLButtonElement", class {});
	vi.stubGlobal("document", {
		documentElement: { dataset: {}, style: {}, lang: "" },
		getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
	});
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
	vi.stubGlobal("addEventListener", lifetime.addEventListener.bind(lifetime));
	let rendered: WebView | undefined;
	const noop = () => {};
	const renderer: PageRenderer = {
		render: view => { rendered = view; }, get view() { return rendered; },
		setConnection: vi.fn(), setConnectionState: vi.fn(),
		onSelect: noop, onCreateSession: noop, onSubmit: noop, onAbort: noop,
		onSelectModel: noop, onSelectThinking: noop, onAttachFiles: noop,
		onFilterRoster: noop, onShortcut: noop, onPaletteSelection: noop,
		onDraftChange: noop, onDismissSuggestion: noop, onCommandPick: noop, onPanelAction: noop,
		refreshTranscriptSearch: noop,
		setDraft: text => renderer.onDraftChange(text), insertDraft: noop,
	};
	const releases = new Set<Promise<void>>();
	const subscribe = Client.prototype.openLink;
	const trackSubscription: Client["openLink"] = async function (this: Client, ...args) {
		const subscription = await subscribe.apply(this, args);
		return { ...subscription, close: async () => {
			const releasing = subscription.close();
			releases.add(releasing);
			try { await releasing; } finally { releases.delete(releasing); }
		} };
	};
	// Scope the prototype hook to construction, then track only this page's client.
	// A second page must not capture the first page's mock as its original method.
	const constructionSpy = vi.spyOn(Client.prototype, "openLink").mockImplementation(trackSubscription);
	let client: Client | undefined;
	try { client = await startPage(renderer); } finally { constructionSpy.mockRestore(); }
	if (client === undefined) throw new Error("Page did not connect");
	const connection = client;
	const subscriptionSpy = vi.spyOn(connection, "openLink").mockImplementation(trackSubscription);
	let closed = () => {};
	const closing = new Promise<void>(resolve => { closed = resolve; });
	const disposeClient = connection.dispose.bind(connection);
	vi.spyOn(connection, "dispose").mockImplementation(async () => {
		// The page must join its native channel closes before disposing the transport.
		expect(releases.size).toBe(0);
		await disposeClient();
		closed();
	});
	const dispose = async () => {
		lifetime.dispatchEvent(new Event("pagehide"));
		await closing;
		subscriptionSpy.mockRestore();
		pageDisposers.delete(dispose);
	};
	pageDisposers.add(dispose);
	return { client, renderer, storage, dispose };
}

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
async function startHostWithDirectories(holdModel = false, reply?: (body: string) => string): Promise<LoopHost> {
	process.env.AMAZME_CODING_AGENT_DIR = await makeDirectory("web-loop-agent-");
	if (holdModel || reply) {
		// Hold a local OpenAI-compatible request until cancellation. Queue tests must
		// control the busy interval instead of depending on ambient credentials or remote latency.
		const modelServer = createServer((request, response) => {
			if (request.url !== "/v1/chat/completions") response.writeHead(404).end();
			else if (!reply) request.resume();
			else {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk: string) => { body += chunk; });
				request.on("end", () => {
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "held", choices: [{ index: 0, delta: { role: "assistant", content: reply(body) }, finish_reason: null }] })}\n\n`);
					response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "held", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
				});
			}
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
	// The resource loader also discovers ~/.agents; keep fixture catalogues independent of the developer's skills.
	const settingsPath = join(process.env.AMAZME_CODING_AGENT_DIR, "settings.json");
	const fixtureSettings = existsSync(settingsPath)
		? JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
		: {};
	await writeFile(settingsPath, JSON.stringify({
		...fixtureSettings,
		skills: [`!${join(process.env.HOME ?? homedir(), ".agents", "skills", "**")}`],
	}));
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
	const hasSchedules = (await serverSource.catalogue(BACKGROUND_CONTEXT)).some(entry => entry.serviceId === Schedules.name);
	const serverServices = serverSource.open({
		services: [SessionDirectory, SessionManagement, SessionArchive, ProjectManagement, Feedback, ...(hasSchedules ? [Schedules] : [])],
		assertAccess(): void {},
		onError(): void {},
	});
	await serverServices.ready(BACKGROUND_CONTEXT);
	return {
		client,
		management: serverServices.get(SessionManagement),
		directory: serverServices.get(SessionDirectory),
		archives: serverServices.get(SessionArchive),
		projects: serverServices.get(ProjectManagement),
		feedback: serverServices.get(Feedback),
		schedules: hasSchedules ? serverServices.get(Schedules) : undefined,
		sessionSource,
		async dispose() {
			await Promise.all([serverSource.dispose(BACKGROUND_CONTEXT), sessionSource.dispose(BACKGROUND_CONTEXT)]);
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
		transcript: services.get(Transcript),
		controller: services.get(AgentController),
		models: services.get(Models),
		commands: services.get(Commands),
		workspace: services.get(Workspace),
		conversations: services.get(Conversations),
		approvals: services.get(Approvals),
		terminal: services.get(Terminal),
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
		settings: services.get(Settings),
		skills: services.get(Skills),
		plugins: services.get(Plugins),
		async dispose() {
			await services.dispose(BACKGROUND_CONTEXT);
			await client.dispose();
		},
	};
}

afterEach(async () => {
	await Promise.allSettled([...pageDisposers].map(dispose => dispose()));
	pageDisposers.clear();
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
	vi.unstubAllGlobals();
});

describe("web terminal output retention", () => {
	test.each(["done", "cancelled", "failed"] as const)("keeps a bounded UTF-8 tail through %s settlement", async (ending) => {
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const terminal = createTerminalService({ env, cwd: process.cwd(), settings: SettingsManager.inMemory() }, replicatedState).service;
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const suffix = "终\u{1F600}\n";
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const execute = vi.spyOn(env, "exec").mockImplementation(async (_command, options, context) => {
			options?.onOutput?.("start\n", context, { stream: "stdout" });
			// Both chunks arrive in one publication interval, before the command settles.
			options?.onOutput?.("界".repeat(TERMINAL_MAX_BYTES), context, { stream: "stdout" });
			options?.onOutput?.(suffix, context, { stream: "stderr" });
			const aborted = () => finish.resolve();
			context.abortSignal?.addEventListener("abort", aborted, { once: true });
			started.resolve();
			try {
				await finish.promise;
				if (ending === "failed") throw new Error("terminal failed");
				return { ok: true, value: { exitCode: 0 } };
			} finally {
				context.abortSignal?.removeEventListener("abort", aborted);
			}
		});
		try {
			const run = terminal.run("output-fixture", BACKGROUND_CONTEXT);
			await started.promise;
			expect(terminal.state.value.output).toBe("start\n");
			if (ending === "cancelled") await terminal.stop(BACKGROUND_CONTEXT);
			else finish.resolve();
			expect(await run).toEqual(ending === "failed" ? { ok: false, problem: "terminal failed" } : { ok: true });
			const expected = "界".repeat(Math.floor((TERMINAL_MAX_BYTES - Buffer.byteLength(suffix)) / 3)) + suffix;
			expect(terminal.state.value).toMatchObject({
				status: ending === "cancelled" ? "cancelled" : "done", output: expected, truncated: true,
				error: ending === "failed" ? "terminal failed" : null,
			});
			expect(Buffer.byteLength(terminal.state.value.output)).toBeLessThanOrEqual(TERMINAL_MAX_BYTES);
		} finally {
			finish.resolve();
			await terminal.stop(BACKGROUND_CONTEXT);
			execute.mockRestore();
			clock.mockRestore();
		}
	});

	test("retains all streamed local output when only the executor's line limit truncates its result", async () => {
		const terminal = createTerminalService({ cwd: process.cwd(), settings: SettingsManager.inMemory() }, replicatedState).service;
		const output = "line\n".repeat(2_100) + "最后\n";
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		const command = `${quote(process.execPath)} -e ${quote(`process.stdout.write(${JSON.stringify(output)})`)}`;
		expect(await terminal.run(command, BACKGROUND_CONTEXT)).toEqual({ ok: true });
		expect(terminal.state.value).toMatchObject({ status: "done", exitCode: 0, output, truncated: false });
	});
});

describe("web client interactive loop", () => {
	test("offers one contextual draft through the real host model service without sending it", async () => {
		const requests: string[] = [];
		const suggestion = "请解释两种设计各自适合的使用场景。";
		const { host } = await startHostWithDirectories(false, body => {
			requests.push(body);
			return body.includes("Suggest at most one useful next question")
				? JSON.stringify({ suggestion }) : "两种设计分别侧重灵活性和易用性。";
		});
		const presentation = await openPresentation(host);
		const created = await presentation.management.create({ id: "suggestion-loop" }, BACKGROUND_CONTEXT);
		const page = await openPage(host);
		expect(page.renderer.view?.attachedId).toBe(created.sessionId);
		page.renderer.onSubmit("对比两种设计的主要区别");
		await waitFor(() => page.renderer.view?.suggestion?.text === suggestion, "contextual suggestion through the host", 20_000);
		expect(requests).toHaveLength(2);
		const request = JSON.parse(requests[1]!) as { tools?: unknown[]; messages: unknown[] };
		expect(request.tools ?? []).toHaveLength(0);
		expect(JSON.stringify(request.messages)).toContain("两种设计分别侧重灵活性和易用性。");
		expect(page.renderer.view?.blocks.filter(block => block.kind === "user")).toHaveLength(1);
		page.renderer.onDismissSuggestion();
		page.renderer.onDraftChange(suggestion);
		expect(page.renderer.view?.suggestion).toBeUndefined();
		expect(page.renderer.view?.blocks.filter(block => block.kind === "user")).toHaveLength(1);
		page.renderer.onDraftChange("");
		await new Promise(resolve => setTimeout(resolve, 100));
		expect(requests).toHaveLength(2);
		await page.dispose(); await presentation.dispose();
	}, 60_000);

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
		const renamed = await first.management.rename(created.sessionId, "人工名称", BACKGROUND_CONTEXT);
		expect(renamed.sessionId).toBe(created.sessionId);
		expect(renamed.name).toBe("人工名称");
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

	test("archiving stops root and fork work, clears queues and terminal commands, and restores without replay", async () => {
		const { host, sessionDir } = await startHostWithDirectories(true);
		const presentation = await openPresentation(host);
		const created = await presentation.management.create({ id: "archive-running-work" }, BACKGROUND_CONTEXT);
		const attached = await attachSession(presentation, created.sessionId);
		expect(await attached.controller.prompt({ message: "keep this history", images: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: true });
		await waitFor(() => isBusy(attached.transcript.state.value) && sawUserText(attached.transcript.state.value, "keep this history"), "the root task");
		expect(await attached.controller.followUp({ message: "must not replay", images: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: true });
		await waitFor(() => queuedInputs("en", attached.transcript.state.value).length === 1, "the queued input");
		const rootId = attached.conversations.state.value?.conversations.find(item => item.root)?.id;
		if (rootId === undefined) throw new Error("Missing root conversation");
		const fork = await attached.conversations.fork(rootId, null, BACKGROUND_CONTEXT);
		if (fork.conversationId === null) throw new Error(fork.error.message);
		expect(await attached.conversations.prompt(fork.conversationId, { message: "fork work", images: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: true });
		await waitFor(() => isBusy(attached.conversations.state.value?.view ?? undefined), "the fork task");
		const terminal = attached.terminal.run("sleep 30; echo must-not-finish", BACKGROUND_CONTEXT);
		await waitFor(() => attached.terminal.state.value?.status === "running", "the terminal command");

		await presentation.archives.set(created.sessionId, true, BACKGROUND_CONTEXT);
		await waitFor(() => !isBusy(attached.transcript.state.value)
			&& !isBusy(attached.conversations.state.value?.view ?? undefined)
			&& queuedInputs("en", attached.transcript.state.value).length === 0
			&& attached.terminal.state.value?.status === "cancelled", "archived work to settle");
		expect(await terminal).toEqual({ ok: true });
		expect(attached.terminal.state.value?.output).not.toContain("must-not-finish");
		expect(sawUserText(attached.transcript.state.value, "keep this history")).toBe(true);
		expect(sawUserText(attached.transcript.state.value, "must not replay")).toBe(false);
		const archived = await readSession(sessionDir, created.sessionId);
		if (archived === undefined) throw new Error("Missing archived metadata");
		expect(archived.archivedAt).toEqual(expect.any(Number));
		expect(archived.workEndedAt).toEqual(expect.any(Number));

		// Old ordinary archives have no end-work marker; archive state alone must block every entry point.
		const { workEndedAt: _compatibilityMarker, ...legacy } = archived;
		await writeFile(join(archived.path, "meta.json"), JSON.stringify(legacy));
		expect(await attached.controller.prompt({ message: "blocked", images: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: false, error: { code: "session_ended" } });
		expect(await attached.controller.compact({ customInstructions: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: false, error: { code: "session_ended" } });
		expect(await attached.conversations.prompt(fork.conversationId, { message: "blocked fork", images: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: false, error: { code: "session_ended" } });
		expect(await attached.terminal.run("echo blocked", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });

		await presentation.archives.set(created.sessionId, false, BACKGROUND_CONTEXT);
		expect(await readSession(sessionDir, created.sessionId)).toMatchObject({ id: created.sessionId });
		expect((await readSession(sessionDir, created.sessionId))?.archivedAt).toBeUndefined();
		expect((await readSession(sessionDir, created.sessionId))?.workEndedAt).toBeUndefined();
		expect(queuedInputs("en", attached.transcript.state.value)).toEqual([]);
		expect(isBusy(attached.transcript.state.value)).toBe(false);
		expect(await attached.terminal.run("echo restored", BACKGROUND_CONTEXT)).toEqual({ ok: true });
		await waitFor(() => attached.terminal.state.value?.status === "done", "the restored terminal");
		expect(await attached.controller.prompt({ message: "new work after restore", images: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: true });
		await attached.controller.abort(BACKGROUND_CONTEXT);
		await attached.dispose();
		await presentation.dispose();
	}, 240_000);

	test("removing a project uses the same stopping archive semantics for all its sessions", async () => {
		const { host, sessionDir } = await startHostWithDirectories(true);
		const first = await openPresentation(host);
		const second = await openPresentation(host);
		const projectId = first.directory.state.value?.defaultProjectId;
		if (projectId === undefined) throw new Error("Missing default project");
		const one = await first.management.create({ id: "archive-project-one", projectId }, BACKGROUND_CONTEXT);
		const two = await second.management.create({ id: "archive-project-two", projectId }, BACKGROUND_CONTEXT);
		const attachedOne = await attachSession(first, one.sessionId);
		const attachedTwo = await attachSession(second, two.sessionId);
		for (const attached of [attachedOne, attachedTwo]) {
			expect(await attached.controller.prompt({ message: "project work", images: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: true });
			await waitFor(() => isBusy(attached.transcript.state.value), "the project task");
		}
		await first.projects.remove(projectId, BACKGROUND_CONTEXT);
		await waitFor(() => !isBusy(attachedOne.transcript.state.value) && !isBusy(attachedTwo.transcript.state.value), "all project work to stop");
		for (const session of [one, two]) {
			expect(await readSession(sessionDir, session.sessionId)).toMatchObject({ archivedAt: expect.any(Number), workEndedAt: expect.any(Number) });
		}
		expect(existsSync(process.cwd())).toBe(true);
		await first.archives.set(one.sessionId, false, BACKGROUND_CONTEXT);
		await waitFor(() => first.directory.state.value?.projects?.find(item => item.id === projectId)?.removed !== true, "the project to restore");
		expect((await readSession(sessionDir, two.sessionId))?.archivedAt).toEqual(expect.any(Number));
		await attachedOne.dispose();
		await attachedTwo.dispose();
		await first.dispose();
		await second.dispose();
	}, 240_000);

	test("the page manages a fork without stopping the main line or shared terminal and rejects a stale modal", async () => {
		const host = await startLoopHost(true);
		const presentation = await openPresentation(host);
		const session = await presentation.management.create({ id: "page-fork-management" }, BACKGROUND_CONTEXT);
		const attached = await attachSession(presentation, session.sessionId);
		await waitFor(() => attached.conversations.state.value?.conversations.some(item => item.root) === true, "the root to publish");
		const rootId = attached.conversations.state.value?.conversations.find(item => item.root)?.id;
		if (!rootId) throw new Error("Missing root");
		await attached.controller.prompt({ conversationId: rootId, message: "root stays running", images: null }, BACKGROUND_CONTEXT);
		await waitFor(() => isBusy(attached.transcript.state.value), "the main line to run");
		const forkId = (await attached.conversations.fork(rootId, null, BACKGROUND_CONTEXT)).conversationId;
		if (!forkId) throw new Error("Missing fork");
		await waitFor(() => attached.conversations.state.value?.conversations.some(item => item.id === forkId) === true, "the fork to publish");
		const page = await openPage(host);
		page.renderer.onPanelAction({ kind: "command", id: CONVERSATION_RENAME_ACTION, data: forkId });
		expect(page.renderer.view?.panel.modal?.id).toBe(CONVERSATION_RENAME_MODAL);
		const other = await presentation.management.create({ id: "page-fork-neighbor" }, BACKGROUND_CONTEXT);
		page.renderer.onSelect(other.sessionId);
		await waitFor(() => page.renderer.view?.attachedId === other.sessionId, "the second session to attach");
		page.renderer.onPanelAction({ kind: "modal-submit", id: CONVERSATION_RENAME_MODAL, data: forkId, fields: { name: "stale mutation" } });
		expect(attached.conversations.state.value?.conversations.find(item => item.id === forkId)?.label).not.toBe("stale mutation");
		page.renderer.onSelect(session.sessionId);
		await waitFor(() => page.renderer.view?.attachedId === session.sessionId, "the fork session to return");
		page.renderer.onPanelAction({ kind: "command", id: DOCK_TAB_ACTION, data: "conversations" });
		page.renderer.onPanelAction({ kind: "command", id: CONVERSATION_RENAME_ACTION, data: forkId });
		page.renderer.onPanelAction({ kind: "modal-submit", id: CONVERSATION_RENAME_MODAL, data: forkId, fields: { name: "方案 A" } });
		await waitFor(() => page.renderer.view?.focus === "方案 A", "the fork name to update");
		page.renderer.onPanelAction({ kind: "command", id: CONVERSATION_RENAME_ACTION, data: forkId });
		await attached.conversations.setArchived(forkId, true, BACKGROUND_CONTEXT);
		await waitFor(() => page.renderer.view?.readOnly === true && page.renderer.view.panel.modal === undefined, "external archiving to dismiss rename");
		page.renderer.onPanelAction({ kind: "modal-submit", id: CONVERSATION_RENAME_MODAL, data: forkId, fields: { name: "archived stale rename" } });
		expect(attached.conversations.state.value?.conversations.find(item => item.id === forkId)?.label).toBe("方案 A");
		await attached.conversations.setArchived(forkId, false, BACKGROUND_CONTEXT);
		await waitFor(() => page.renderer.view?.readOnly !== true, "the external restoration");
		page.renderer.onSubmit("fork work");
		await waitFor(() => page.renderer.view?.busy === true, "the fork to run");
		page.renderer.onSubmit("queued fork input");
		await waitFor(() => (page.renderer.view?.queue.length ?? 0) === 1, "the fork queue");
		const terminal = attached.terminal.run("sleep 120", BACKGROUND_CONTEXT);
		void terminal.catch(() => {});
		await waitFor(() => attached.terminal.state.value?.status === "running", "the shared terminal to run");
		page.renderer.onPanelAction({ kind: "command", id: CONVERSATION_ARCHIVE_ACTION, data: forkId });
		expect(page.renderer.view?.panel.modal?.id).toBe(CONVERSATION_ARCHIVE_MODAL);
		page.renderer.onPanelAction({ kind: "modal-submit", id: CONVERSATION_ARCHIVE_MODAL, data: forkId, fields: {} });
		await waitFor(() => page.renderer.view?.readOnly === true && page.renderer.view.panel.modal === undefined, "the fork archive to finish");
		expect(page.renderer.view?.queue).toEqual([]);
		expect(page.renderer.view?.run.fork.disabled).toBe(true);
		expect(page.renderer.view?.dock.panel.groups.some(group => group.id === "conversations:archived")).toBe(true);
		expect(isBusy(attached.transcript.state.value)).toBe(true);
		expect(attached.terminal.state.value?.status).toBe("running");
		page.renderer.onPanelAction({ kind: "command", id: CONVERSATION_RESTORE_ACTION, data: forkId });
		await waitFor(() => page.renderer.view?.readOnly !== true && page.renderer.view?.focus === "方案 A", "the fork to restore");
		expect(page.renderer.view?.busy).toBe(false);
		expect(page.renderer.view?.queue).toEqual([]);
		await attached.terminal.stop(BACKGROUND_CONTEXT);
		await terminal;
		await attached.conversations.abort(rootId, BACKGROUND_CONTEXT);
		await page.dispose();
		await attached.dispose();
		await presentation.dispose();
	}, 240_000);

	test("accepts current and legacy archive selections without trusting malformed archive stamps", () => {
		expect(isProjectSelection({ projectId: "p", sessionId: "s", archivedAt: 3 })).toBe(true);
		expect(isProjectSelection({ projectId: "p" })).toBe(true);
		expect(isProjectSelection({ projectId: "p", sessionId: "s", archivedAt: 3, showArchived: true })).toBe(true);
		expect(isProjectSelection({ showArchived: false })).toBe(true);
		expect(isProjectSelection({ showArchived: "true" })).toBe(false);
		expect(isProjectSelection({ archivedAt: Infinity })).toBe(false);
		expect(isProjectSelection({ archivedAt: "3" })).toBe(false);
	});

	test("the page opens an archive through settings and reveals the restored session despite an old filter", async () => {
		const host = await startLoopHost();
		const presentation = await openPresentation(host);
		const active = await presentation.management.create({ id: "page-active" }, BACKGROUND_CONTEXT);
		const stored = await presentation.management.create({ id: "page-archived" }, BACKGROUND_CONTEXT);
		await presentation.archives.set(stored.sessionId, true, BACKGROUND_CONTEXT);
		const page = await openPage(host);
		expect(page.renderer.view?.attachedId).toBe(active.sessionId);
		page.renderer.onFilterRoster("does-not-match");
		page.renderer.onPanelAction({ kind: "open", panel: SETTINGS_VIEW });
		page.renderer.onPanelAction({ kind: "command", id: SESSION_ARCHIVE_OPEN_ACTION, data: stored.sessionId });
		await waitFor(() => page.renderer.view?.archivedAttached?.id === stored.sessionId, "the page to open the archive");
		expect(page.renderer.view?.readOnly).toBe(true);
		expect(page.renderer.view?.rosterFilter).toBe("does-not-match");

		page.renderer.onPanelAction({ kind: "command", id: SESSION_RESTORE_ACTION, data: stored.sessionId });
		await waitFor(() => page.renderer.view?.attachedId === stored.sessionId && page.renderer.view.readOnly !== true, "the page to restore the archive");
		expect(page.renderer.view?.rosterFilter).toBe("");
		expect(page.renderer.view?.roster.find(item => item.id === stored.sessionId)?.attached).toBe(true);
		expect(page.renderer.view?.projects?.some(project => project.selected && project.items.some(item => item.id === stored.sessionId))).toBe(true);
		await page.dispose();
		await presentation.dispose();
	}, 240_000);

	test("the page does not reattach a session archived while disconnected", async () => {
		const host = await startLoopHost();
		const presentation = await openPresentation(host);
		const active = await presentation.management.create({ id: "page-offline-archive" }, BACKGROUND_CONTEXT);
		const page = await openPage(host);
		expect(page.renderer.view?.attachedId).toBe(active.sessionId);
		let release = () => {};
		const gate = new Promise<void>(resolve => { release = resolve; });
		const reconnect = page.client.reconnect.bind(page.client);
		vi.spyOn(page.client, "reconnect").mockImplementation(async () => { await gate; return reconnect(); });
		page.client.disconnect();
		await presentation.archives.set(active.sessionId, true, BACKGROUND_CONTEXT);
		expect(page.client.connected).toBe(false);
		release();
		await waitFor(() => page.client.connected && page.renderer.view?.empty === "归档会话在设置 → 已归档。", "the refreshed archive directory");
		await expect.poll(async () => (await presentation.projects.selection(BACKGROUND_CONTEXT))?.sessionId, { timeout: 2000 }).toBeUndefined();
		expect(page.renderer.view?.attachedId).toBeUndefined();
		expect(page.renderer.view?.archivedAttached).toBeUndefined();
		await page.dispose();
		await presentation.dispose();
	}, 240_000);

	test("the page keeps an online archive read-only across reload and reconnect, then follows restoration", async () => {
		const host = await startLoopHost();
		const presentation = await openPresentation(host);
		const active = await presentation.management.create({ id: "page-online-archive" }, BACKGROUND_CONTEXT);
		// Keep a second attachment so this test isolates selection from idle-worker retirement.
		const anchor = await attachSession(presentation, active.sessionId);
		const first = await openPage(host);
		await presentation.archives.set(active.sessionId, true, BACKGROUND_CONTEXT);
		await waitFor(() => first.renderer.view?.archivedAttached?.id === active.sessionId, "the online archive to remain open");
		expect(first.renderer.view?.readOnly).toBe(true);
		await first.dispose();
		expect(JSON.parse(first.storage.get(`amazme.selection.${host.serverId}`) ?? "null")).toMatchObject({ sessionId: active.sessionId, archivedAt: expect.any(Number) });
		const page = await openPage(host, first.storage);
		expect(page.renderer.view?.archivedAttached?.id).toBe(active.sessionId);
		page.client.disconnect();
		await waitFor(() => page.client.connected && page.renderer.view?.archivedAttached?.id === active.sessionId, "the same archive to reconnect");
		expect(page.renderer.view?.readOnly).toBe(true);
		page.renderer.onFilterRoster("does-not-match");
		expect(page.renderer.view?.archivedAttached?.id).toBe(active.sessionId);
		await presentation.archives.set(active.sessionId, false, BACKGROUND_CONTEXT);
		await waitFor(() => page.renderer.view?.attachedId === active.sessionId && page.renderer.view.readOnly !== true, "the external restoration to publish");
		expect(page.renderer.view?.rosterFilter).toBe("");
		expect(page.renderer.view?.archivedAttached).toBeUndefined();
		expect(page.renderer.view?.projects?.some(project => project.selected && project.items.some(item => item.id === active.sessionId))).toBe(true);
		await page.dispose();
		await anchor.dispose();
		await presentation.dispose();
	}, 240_000);

	test("the page opens a removed project's archive, restores its project, and clears a deleted archive", async () => {
		const host = await startLoopHost();
		const presentation = await openPresentation(host);
		const active = await presentation.management.create({ id: "page-neighbor" }, BACKGROUND_CONTEXT);
		const folder = await makeDirectory("page-removed-project-");
		const project = await presentation.projects.create({ cwd: folder, name: "旧项目" }, BACKGROUND_CONTEXT);
		const stored = await presentation.management.create({ id: "page-removed-archive", projectId: project.id }, BACKGROUND_CONTEXT);
		await presentation.projects.remove(project.id, BACKGROUND_CONTEXT);
		const page = await openPage(host);
		expect(page.renderer.view?.attachedId).toBe(active.sessionId);
		page.renderer.onPanelAction({ kind: "open", panel: SETTINGS_VIEW });
		expect(page.renderer.view?.panel.panel?.groups.find(group => group.id === "settings:archives")?.rows.find(row => row.id === `settings:archive:${stored.sessionId}`)?.description).toContain("旧项目");
		page.renderer.onPanelAction({ kind: "command", id: SESSION_ARCHIVE_OPEN_ACTION, data: stored.sessionId });
		await waitFor(() => page.renderer.view?.archivedAttached?.id === stored.sessionId, "the removed project's archive to open");
		expect(page.renderer.view?.readOnly).toBe(true);
		expect(page.renderer.view?.projects?.some(group => group.id === project.id)).toBe(false);
		page.renderer.onPanelAction({ kind: "command", id: SESSION_RESTORE_ACTION, data: stored.sessionId });
		await waitFor(() => page.renderer.view?.attachedId === stored.sessionId && page.renderer.view.readOnly !== true, "the removed project to return");
		expect(page.renderer.view?.projects?.find(group => group.id === project.id)?.selected).toBe(true);
		await presentation.archives.set(stored.sessionId, true, BACKGROUND_CONTEXT);
		await waitFor(() => page.renderer.view?.archivedAttached?.id === stored.sessionId, "the restored session to archive again");
		await presentation.management.remove(stored.sessionId, BACKGROUND_CONTEXT);
		await waitFor(() => page.renderer.view?.attachedId === undefined && page.renderer.view?.archivedAttached === undefined, "the deleted archive to clear");
		expect(page.renderer.view?.roster.map(item => item.id)).toContain(active.sessionId);
		await page.dispose();
		await presentation.dispose();
	}, 240_000);

	test("attaches an already archived session read-only without archiving its neighbor, then restores it", async () => {
		const host = await startLoopHost(true);
		const presentation = await openPresentation(host);
		const active = await presentation.management.create({ id: "archive-open-active" }, BACKGROUND_CONTEXT);
		const stored = await presentation.management.create({ id: "archive-open-stored" }, BACKGROUND_CONTEXT);
		await waitFor(
			() => {
				const sessions = presentation.directory.state.value?.sessions ?? [];
				return sessions.some(session => session.sessionId === active.sessionId) && sessions.some(session => session.sessionId === stored.sessionId);
			},
			"both sessions to publish",
		);
		const projectId = presentation.directory.state.value?.sessions.find(session => session.sessionId === active.sessionId)?.projectId;
		if (projectId === undefined) throw new Error("Missing session project");
		await presentation.archives.set(stored.sessionId, true, BACKGROUND_CONTEXT);
		await waitFor(
			() => presentation.directory.state.value?.sessions.find(session => session.sessionId === stored.sessionId)?.archivedAt !== undefined,
			"the archive to publish",
		);
		const sessions = presentation.directory.state.value?.sessions ?? [];
		expect(sessions.find(session => session.sessionId === active.sessionId)?.archivedAt).toBeUndefined();
		expect(sessions.find(session => session.sessionId === stored.sessionId)?.projectId).toBe(projectId);

		const attached = await attachSession(presentation, stored.sessionId);
		expect(await attached.controller.prompt({ message: "blocked", images: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: false, error: { code: "session_ended" } });

		await presentation.archives.set(stored.sessionId, false, BACKGROUND_CONTEXT);
		await waitFor(
			() => presentation.directory.state.value?.sessions.find(session => session.sessionId === stored.sessionId)?.archivedAt === undefined,
			"the session to return",
		);
		expect(presentation.directory.state.value?.projects?.find(project => project.id === projectId)?.removed).not.toBe(true);
		expect(await attached.controller.prompt({ message: "new work after restore", images: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: true });
		await attached.controller.abort(BACKGROUND_CONTEXT);
		await attached.dispose();
		await presentation.dispose();
	}, 240_000);

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
			await waitFor(() => presentation.schedules!.state.value !== undefined, "the schedules state");
			expect(presentation.schedules!.state.value?.schedules).toEqual([]);
			const path = presentation.schedules!.state.value?.path ?? "";
			expect(path.endsWith("schedules.json")).toBe(true);

			// The page's add modal sends the attached session, the prompt, and the gap.
			const marker = `web-loop-schedule-${Date.now()}`;
			expect(
				await presentation.schedules!.add(
					{ conversationId: "1", sessionId: created.sessionId, prompt: marker, id: randomUUID(), rule: { kind: "interval", everyMinutes: 60 }, busy: "queue", missed: "latest", graceMinutes: 10, timeoutSeconds: 600 },
					BACKGROUND_CONTEXT,
				),
			).toEqual({ ok: true, code: "added" });
			await waitFor(() => presentation.schedules!.state.value?.schedules.length === 1, "the planned prompt");
			const planned = presentation.schedules!.state.value?.schedules[0];
			expect(planned).toMatchObject({ conversationId: "1", sessionId: created.sessionId, prompt: marker, rule: { kind: "interval", everyMinutes: 60 }, enabled: true });
			// The file the CLI would read carries it.
			const file = JSON.parse(await readFile(path, "utf8")) as { schedules: readonly { prompt: string }[] };
			expect(file.schedules.map((schedule) => schedule.prompt)).toEqual([marker]);

			// Run now goes through the host's own runner: the prompt reaches the session's transcript.
			const run = await presentation.schedules!.runNow(planned?.id ?? "", randomUUID(), BACKGROUND_CONTEXT);
			// The scratch agent directory has no credentials, so the turn settles without an answer;
			// what matters is that the run happened, was reported, and reached the real session.
			expect(run.ok).toBe(false);
			await waitFor(
				() => sawUserText(attached.transcript.state.value, marker),
				"the planned prompt in the session's transcript",
			);
			await waitFor(
				() => (presentation.schedules!.state.value?.schedules[0]?.history.length ?? 0) > 0,
				"the recorded outcome",
			);
			const recorded = presentation.schedules!.state.value?.schedules[0];
			expect(recorded?.history.at(-1)?.startedAt).toBeGreaterThan(0);
			expect(recorded?.history.at(-1)?.status).toBe("unanswered");
			expect(JSON.parse(await readFile(path, "utf8")).schedules[0].history.at(-1).status).toBe(recorded?.history.at(-1)?.status);

			// Pausing is replicated, and it keeps the outcome the run recorded.
			expect(await presentation.schedules!.setEnabled(planned?.id ?? "", false, BACKGROUND_CONTEXT)).toEqual({
				ok: true,
				code: "paused",
			});
			await waitFor(() => presentation.schedules!.state.value?.schedules[0]?.enabled === false, "the paused schedule");
			await presentation.schedules!.remove(planned?.id ?? "", BACKGROUND_CONTEXT);
			await waitFor(() => presentation.schedules!.state.value?.schedules.length === 0, "the removed schedule");
			expect(JSON.parse(await readFile(path, "utf8")).schedules).toEqual([]);
			// A schedule the host does not have is refused rather than silently accepted.
			expect(
				await presentation.schedules!.add({ conversationId: "1", sessionId: "", prompt: "x", id: randomUUID(), rule: { kind: "interval", everyMinutes: 5 }, busy: "queue", missed: "latest", graceMinutes: 10, timeoutSeconds: 600 }, BACKGROUND_CONTEXT),
			).toMatchObject({ ok: false });
			expect(await presentation.schedules!.add({ conversationId: "1", sessionId: created.sessionId, prompt: "  ", id: randomUUID(), rule: { kind: "interval", everyMinutes: 5 }, busy: "queue", missed: "latest", graceMinutes: 10, timeoutSeconds: 600 }, BACKGROUND_CONTEXT)).toMatchObject({
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

	test("file paging and refresh retain displayed targets after another client switches the shared workspace", async () => {
		const host = await startLoopHost();
		const presentation = await openPresentation(host);
		const first = await realpath(await makeDirectory("file-target-a-"));
		const second = await realpath(await makeDirectory("file-target-b-"));
		for (const root of [first, second]) await mkdir(join(root, "src"));
		await Promise.all(Array.from({ length: 101 }, (_, index) => writeFile(join(first, "src", `file-${String(index).padStart(3, "0")}.txt`), "first")));
		await writeFile(join(second, "src", "file-000.txt"), "second");
		const project = await presentation.projects.create({ cwd: first, workspaces: [first, second] }, BACKGROUND_CONTEXT);
		const session = await presentation.management.create({ id: "file-bound-targets", projectId: project.id }, BACKGROUND_CONTEXT);
		const attached = await attachSession(presentation, session.sessionId);
		const page = await openPage(host);
		page.renderer.onSelect(session.sessionId);
		page.renderer.onPanelAction({ kind: "command", id: DOCK_TAB_ACTION, data: "files" });
		await waitFor(() => page.renderer.view?.attachedId === session.sessionId && page.renderer.view.dock.panel.files !== undefined, "the bound file browser", 5_000);
		await attached.workspace.open(join(first, "src"), BACKGROUND_CONTEXT);
		await waitFor(() => page.renderer.view?.dock.panel.files?.cwd === project.cwd && page.renderer.view.dock.panel.files.path === "src", "the first workspace listing", 5_000);
		const next = page.renderer.view?.dock.panel.groups.at(-1)?.actions?.find(action => action.id === WORKSPACE_PAGE_ACTION);
		if (!next?.data) throw new Error("Missing bound directory page");
		await attached.workspace.open(join(second, "src"), BACKGROUND_CONTEXT);
		await waitFor(() => page.renderer.view?.dock.panel.files?.cwd !== project.cwd, "the other client's workspace switch", 5_000);
		page.renderer.onPanelAction({ kind: "command", id: next.id, data: next.data });
		await waitFor(() => page.renderer.view?.dock.panel.files?.cwd === project.cwd && page.renderer.view.dock.panel.files.filterScope?.includes("100") === true && page.renderer.view.dock.panel.pending === undefined, "the original workspace's second page", 5_000);
		await attached.workspace.read(join(first, "src", "file-000.txt"), BACKGROUND_CONTEXT);
		await waitFor(() => page.renderer.view?.dock.panel.texts?.[0]?.text === "first", "the first file preview", 5_000);
		const reload = page.renderer.view?.dock.panel.groups.at(-1)?.actions?.find(action => action.id === WORKSPACE_RELOAD_ACTION);
		if (!reload?.data) throw new Error("Missing bound refresh");
		await attached.workspace.read(join(second, "src", "file-000.txt"), BACKGROUND_CONTEXT);
		await waitFor(() => page.renderer.view?.dock.panel.texts?.[0]?.text === "second", "the other file preview", 5_000);
		page.renderer.onPanelAction({ kind: "command", id: reload.id, data: reload.data });
		await waitFor(() => page.renderer.view?.dock.panel.files?.cwd === project.cwd && page.renderer.view.dock.panel.texts?.[0]?.text === "first" && page.renderer.view.dock.panel.pending === undefined, "the original file refresh", 5_000);
		await page.dispose(); await attached.dispose(); await presentation.dispose();
	});

	test("file navigation coordinates pending state, preview, return paths and session switching", async () => {
		const host = await startLoopHost();
		const presentation = await openPresentation(host);
		const first = await presentation.management.create({ id: "file-page-first" }, BACKGROUND_CONTEXT);
		const second = await presentation.management.create({ id: "file-page-second" }, BACKGROUND_CONTEXT);
		await presentation.management.attach(first.sessionId, BACKGROUND_CONTEXT);
		const page = await openPage(host);
		page.renderer.onSelect(first.sessionId);
		await waitFor(() => page.renderer.view?.attachedId === first.sessionId, "the first file browser");
		page.renderer.onPanelAction({ kind: "command", id: DOCK_TAB_ACTION, data: "files" });
		await waitFor(() => page.renderer.view?.dock.panel.files?.cwd === process.cwd(), "the file navigation root");
		page.renderer.onPanelAction({ kind: "command", id: WORKSPACE_OPEN_ACTION, data: join(process.cwd(), "src") });
		expect(page.renderer.view?.dock.panel.pending?.id).toBe(WORKSPACE_OPEN_ACTION);
		await waitFor(() => page.renderer.view?.dock.panel.files?.path === "src" && page.renderer.view.dock.panel.pending === undefined, "the opened directory");
		expect(page.renderer.view?.dock.panel.files?.breadcrumbs.at(-1)?.label).toBe("src");
		const target = join(process.cwd(), "src", "index.ts");
		page.renderer.onPanelAction({ kind: "command", id: WORKSPACE_READ_ACTION, data: target });
		expect(page.renderer.view?.dock.panel.pending?.id).toBe(WORKSPACE_READ_ACTION);
		await waitFor(() => page.renderer.view?.dock.panel.texts?.[0]?.source === true && page.renderer.view.dock.panel.pending === undefined, "the source preview");
		expect(page.renderer.view?.dock.panel.files?.breadcrumbs.at(-1)?.path).toBe(target);
		expect(page.renderer.view?.dock.panel.groups[0]?.rows[0]?.file?.action.data).toBe(join(process.cwd(), "src"));
		page.renderer.onPanelAction({ kind: "command", id: WORKSPACE_OPEN_ACTION, data: join(process.cwd(), "src") });
		await waitFor(() => page.renderer.view?.dock.panel.files?.path === "src" && page.renderer.view.dock.panel.pending === undefined, "return to the source folder");
		page.renderer.onPanelAction({ kind: "command", id: WORKSPACE_READ_ACTION, data: target });
		page.renderer.onSelect(second.sessionId);
		await waitFor(() => page.renderer.view?.attachedId === second.sessionId && page.renderer.view.dock.panel.files?.path === ".", "the second file browser");
		expect(page.renderer.view?.dock.panel.pending).toBeUndefined();
		expect(page.renderer.view?.dock.panel.texts).toBeUndefined();
		expect(page.renderer.view?.dock.panel.notices).toEqual([]);
		await page.dispose(); await presentation.dispose();
	});

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
			expect(listing.page).toMatchObject({ limit: 100, total: onDisk.length });
			const revision = attached.workspace.state.value!.revision;
			await attached.workspace.open({ path: ".", offset: Number.MAX_SAFE_INTEGER }, BACKGROUND_CONTEXT);
			await waitFor(() => attached.workspace.state.value!.revision > revision, "the remote directory page");
			const paged = attached.workspace.state.value!.view;
			if (paged.kind !== "listing") throw new Error("Expected a remote directory page");
			expect(paged.page?.offset).toBe(Math.max(0, Math.ceil(onDisk.length / 100) - 1) * 100);
			await attached.workspace.open({ path: ".", offset: 0 }, BACKGROUND_CONTEXT);
			await waitFor(() => attached.workspace.state.value!.view.kind === "listing" && attached.workspace.state.value!.view.page?.offset === 0, "the first remote page");

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

			await waitFor(() => (attached.commands.state.value?.commands ?? []).length >= 4, "the command catalogue");
			const catalogue = attached.commands.state.value?.commands ?? [];
			// The shared catalog contains work actions and prompt resources.
			const runnable = catalogue;
			expect(runnable.map((command) => [command.name, command.source])).toEqual([
				["compact", "builtin"],
				["reload", "builtin"],
				["share", "plugin"],
				["web-loop-report", "template"],
				["skill:web-loop-brief", "skill"],
			]);
			expect(catalogue.some((command) => command.name === "export")).toBe(false);
			expect(catalogue.some(command => command.name === "older" || command.name === "model")).toBe(false);
			expect(await attached.commands.run("older", "", BACKGROUND_CONTEXT)).toEqual({ ok: false, problem: "Unknown command: /older" });
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
			// Settings changes use the Models service, independently of task commands.
			const levels = await attached.models.getThinkingLevels(BACKGROUND_CONTEXT);
			const level = levels[levels.length - 1] ?? "off";
			await attached.models.selectThinking(level, BACKGROUND_CONTEXT);
			await waitFor(() => attached.models.state.value?.configuration.thinkingLevel === level, "the selected effort");
			await expect(attached.models.selectThinking("nonsense" as typeof level, BACKGROUND_CONTEXT)).rejects.toThrow();
			const catalog = attached.models.state.value?.catalog.availableModels ?? [];
			if (catalog.length > 0) {
				const target = catalog[0]!;
				await attached.models.select(target, BACKGROUND_CONTEXT);
				await waitFor(() => attached.models.state.value?.configuration.model?.modelId === target.modelId, "the selected model");
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

			// Observe the admitted task before requesting it; a short-lived live state may finish between polls.
			const observedCompactions = new Set<string>();
			const stopCompactions = attached.transcript.state.subscribe((view) => {
				for (const status of liveOf(view).compactions ?? []) observedCompactions.add(String(status.taskId));
			});
			try {
				const compacted = await attached.controller.compact({ customInstructions: "keep the marker" }, BACKGROUND_CONTEXT);
				expect(compacted).toMatchObject({ accepted: true });
				await waitFor(() => compacted.operationId !== null && observedCompactions.has(compacted.operationId), "the admitted compaction task in the live document");
			} finally { stopCompactions(); }

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
	test("keeps startup-project diagnostics out of an attached project's settings", async () => {
		const drainErrors = SettingsManager.prototype.drainErrors;
		const startupPath = join(process.cwd(), ".amazme", "settings.json");
		const diagnostic = vi.spyOn(SettingsManager.prototype, "drainErrors").mockImplementation(function (this: SettingsManager) {
			return [...drainErrors.call(this), { scope: "project", path: startupPath, error: new Error("Startup project settings are unreadable") }];
		});
		const host = await startLoopHost();
		diagnostic.mockRestore();
		const administration = await openAdministration(host);
		const presentation = await openPresentation(host);
		const page = await openPage(host);
		try {
			await waitFor(() => administration.settings.state.value !== undefined, "startup settings");
			expect(administration.settings.state.value?.errors).toContainEqual({
				scope: "project", path: startupPath, message: "Startup project settings are unreadable",
			});
			const folder = await makeDirectory("settings-diagnostic-owner-");
			const project = await presentation.projects.create({ cwd: folder, name: "Healthy project" }, BACKGROUND_CONTEXT);
			const session = await presentation.management.create({ id: "settings-diagnostic-owner", projectId: project.id }, BACKGROUND_CONTEXT);
			page.renderer.onSelect(session.sessionId);
			page.renderer.onPanelAction({ kind: "open", panel: SETTINGS_VIEW });
			await waitFor(() => page.renderer.view?.attachedId === session.sessionId && page.renderer.view.panel.panel?.groups.some(group => group.id === "settings:interface") === true, "attached project settings");
			expect(page.renderer.view?.panel.panel?.notices.filter(notice => notice.tone === "error")).toEqual([]);
		} finally {
			await page.dispose();
			await presentation.dispose();
			await administration.dispose();
		}
	}, 30_000);

	test("keeps failed global edits retryable before and after session attachment when settings cannot be read", async () => {
		const host = await startLoopHost();
		const administration = await openAdministration(host);
		const presentation = await openPresentation(host);
		const page = await openPage(host);
		const original = FileSettingsStorage.prototype.withLock;
		let readable = true;
		const failure = vi.spyOn(FileSettingsStorage.prototype, "withLock").mockImplementation(function (this: FileSettingsStorage, scope, fn) {
			if (scope === "global" && !readable) throw new Error("EACCES: settings access refused");
			return original.call(this, scope, fn);
		});
		const value = () => administration.settings.state.value?.descriptors.find(field => field.id === "textFont")?.value;
		const notices = () => page.renderer.view?.panel.panel?.notices.filter(notice => notice.tone === "error") ?? [];
		try {
			await waitFor(() => page.renderer.view !== undefined && value() !== undefined, "settings startup", 5000);
			page.renderer.onPanelAction({ kind: "open", panel: SETTINGS_VIEW });
			for (const [index, font] of ["Georgia", "Palatino"].entries()) {
				if (index === 1) {
					const created = await presentation.management.create({ id: "settings-retry" }, BACKGROUND_CONTEXT);
					page.renderer.onSelect(created.sessionId);
					await waitFor(() => page.renderer.view?.attachedId === created.sessionId, "attached settings");
					page.renderer.onPanelAction({ kind: "open", panel: SETTINGS_VIEW });
				}
				readable = false;
				page.renderer.onPanelAction({ kind: "control", id: SETTINGS_FIELD_ACTION, data: "textFont", value: font });
				await waitFor(() => notices().length > 0 && page.renderer.view?.panel.panel?.pending === undefined, "visible failed settings edit");
				expect(notices()).toHaveLength(1);
				expect(value()).toBe(index === 0 ? "" : "Georgia");
				readable = true;
				page.renderer.onPanelAction({ kind: "control", id: SETTINGS_FIELD_ACTION, data: "textFont", value: font });
				await waitFor(() => value() === font && notices().length === 0 && page.renderer.view?.panel.panel?.pending === undefined, "same-value settings retry");
				expect(SettingsManager.create(process.cwd()).getTypography().textFont).toBe(font);
			}
			readable = false;
			await expect(administration.settings.adjustFontSizes("increase", BACKGROUND_CONTEXT)).rejects.toThrow();
			expect(administration.settings.state.value?.descriptors.find(field => field.id === "textSize")?.value).toBe("15");
			readable = true;
			await administration.settings.adjustFontSizes("increase", BACKGROUND_CONTEXT);
			expect(SettingsManager.create(process.cwd()).getTypography()).toMatchObject({ textSize: 16, codeSize: 14, terminalSize: 13 });
		} finally {
			failure.mockRestore();
			await page.dispose();
			await presentation.dispose();
			await administration.dispose();
		}
	}, 30_000);

	test("reports a font shortcut save failure to its caller and the chat page", async () => {
		const host = await startLoopHost();
		const administration = await openAdministration(host);
		const page = await openPage(host);
		const path = join(process.env.AMAZME_CODING_AGENT_DIR!, "settings.json");
		const saved = await readFile(path, "utf8");
		await rm(path);
		await mkdir(path);
		vi.stubGlobal("window", { amazmeDesktop: { pickDirectories: async () => [] } });
		try {
			await expect(administration.settings.adjustFontSizes("increase", BACKGROUND_CONTEXT)).rejects.toThrow();
			await waitFor(() => (administration.settings.state.value?.errors.length ?? 0) > 0, "published settings write failure");
			page.renderer.onShortcut("font.increase");
			await waitFor(() => vi.mocked(page.renderer.setConnection).mock.calls.some(([text, kind]) => kind === "error" && typeof text === "string" && text.includes("无法调整字号")), "visible shortcut write failure");
		} finally {
			await rm(path, { recursive: true });
			await writeFile(path, saved);
			await page.dispose();
			await administration.dispose();
		}
	}, 240_000);

	test("replicates global typography across pages and serializes concurrent relative size changes", async () => {
		const host = await startLoopHost();
		const first = await openAdministration(host);
		const second = await openAdministration(host);
		const pageA = await openPage(host);
		const pageB = await openPage(host);
		const presentation = await openPresentation(host);
		try {
			await waitFor(() => first.settings.state.value !== undefined && second.settings.state.value !== undefined, "both settings subscriptions");
			const created = await presentation.management.create({ id: "typography-attached" }, BACKGROUND_CONTEXT);
			pageA.renderer.onSelect(created.sessionId);
			await waitFor(() => pageA.renderer.view?.attachedId === created.sessionId, "the first page's session settings to hydrate");
			expect(pageB.renderer.view?.attachedId).toBeUndefined();
			const revision = first.settings.state.value!.revision;
			await Promise.all([
				first.settings.adjustFontSizes("increase", BACKGROUND_CONTEXT),
				second.settings.adjustFontSizes("increase", BACKGROUND_CONTEXT),
			]);
			await waitFor(() => pageA.renderer.view?.typography.textSize === 17 && pageB.renderer.view?.typography.textSize === 17, "both pages' font updates");
			expect(pageA.renderer.view?.typography).toMatchObject({ textSize: 17, codeSize: 15, terminalSize: 14 });
			expect(pageA.renderer.view?.attachedId).toBe(created.sessionId);
			expect(pageB.renderer.view?.attachedId).toBeUndefined();
			expect(first.settings.state.value!.revision).toBe(revision + 2);
			await first.settings.set("textFont", "Arial", BACKGROUND_CONTEXT);
			await second.settings.adjustFontSizes("reset", BACKGROUND_CONTEXT);
			await waitFor(() => pageA.renderer.view?.typography.textSize === 15 && pageB.renderer.view?.typography.textFont === "Arial", "reset with retained fonts");
			expect(pageA.renderer.view?.typography).toEqual({ ...DEFAULT_TYPOGRAPHY, textFont: "Arial" });
			expect(SettingsManager.create(process.cwd()).getTypography()).toEqual({ ...DEFAULT_TYPOGRAPHY, textFont: "Arial" });
		} finally {
			await presentation.dispose();
			await pageB.dispose();
			await pageA.dispose();
			await second.dispose();
			await first.dispose();
		}
	}, 240_000);

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
