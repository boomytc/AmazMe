import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@amazme/ai";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@amazme/chord/context";
import { AgentDoc, createRegistry, Harness, MemoryStorage, type Storage } from "@amazme/durable";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { serviceFacet } from "@amazme/protocol/services";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WEB_SETTINGS, WebPolicy } from "../plugins/web/src/config.ts";
import { configureWeb, WebRetrieval } from "../plugins/web/src/session.ts";
import { createAgentExtensionsFacet } from "../src/core/plugins/agent-extensions.ts";
import { AgentRuntime, createAgentRuntime } from "../src/core/plugins/agent-runtime.ts";
import { createSlashCommandsRuntimeFacet } from "../src/core/plugins/command-registry.ts";
import { createSourcePluginLoader } from "../src/core/plugins/loader.ts";
import { openPluginRuntime } from "../src/core/plugins/runtime.ts";
import { SlashCommands } from "../src/core/plugins/slash-commands.ts";
import { durableToolSelection } from "../src/core/tool-selection.ts";
import { ForkManagementDoc, withConversationAdmission } from "../src/durable/fork-management.ts";
import { Commands } from "../src/host/services/commands.ts";
import { Conversations } from "../src/host/services/conversations.ts";
import { openWorkerTestServices } from "./native-host-support.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.close(context)));
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function open(storage: Storage = new MemoryStorage(), install = true) {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	let key = "fixture-key",
		authCalls = 0;
	models.setProvider({
		...faux.provider,
		id: "deepseek",
		baseUrl: "https://chat.test/never-for-web",
		headers: { "x-chat-identity": "private" },
		auth: {
			apiKey: {
				name: "Fixture",
				async resolve() {
					authCalls++;
					return {
						auth: {
							apiKey: key,
							baseUrl: "https://auth-chat.test/",
							headers: { "x-secret": "private" },
						},
					};
				},
			},
		},
	});
	const registry = createRegistry();
	if (install) registry.install(WebRetrieval);
	const reports: unknown[] = [];
	const harness = await Harness.open(storage, { models, registry, onReport: (error) => reports.push(error) }, context);
	harnesses.push(harness);
	const root = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "faux-1" } },
	});
	let selected = root.id,
		unavailable = false;
	const runtime = createAgentRuntime(
		harness,
		() => selected,
		() => unavailable,
	);
	return {
		harness,
		root,
		registry,
		faux,
		runtime,
		reports,
		authCalls: () => authCalls,
		select: (id: typeof selected) => {
			selected = id;
		},
		unavailable: (value: boolean) => {
			unavailable = value;
		},
		key: (value: string) => {
			key = value;
		},
	};
}

function toolResponse(name: string, args: Parameters<typeof fauxToolCall>[1]) {
	return fauxAssistantMessage([fauxToolCall(name, args)], {
		stopReason: "toolUse",
	});
}

async function ask(
	setup: Awaited<ReturnType<typeof open>>,
	name: string,
	args: Parameters<typeof fauxToolCall>[1],
	input = "user question",
) {
	setup.faux.setResponses([toolResponse(name, args), fauxAssistantMessage("done")]);
	const submission = await setup.root.submit(
		{ type: "input", content: input, entry: { kind: "client.input" } },
		context,
	);
	expect((await submission.wait(context)).status).toBe("done");
}

describe("optional DeepSeek web plugin", () => {
	it("is inactive without selection, loads from its real package, reloads once and releases both registrations", async () => {
		const setup = await open(undefined, false);
		expect((await setup.root.agent(context)).tools).toEqual([]);
		const plugins = await openPluginRuntime(
			[
				createAgentExtensionsFacet(setup.registry),
				createSlashCommandsRuntimeFacet(),
				serviceFacet("web-test-agent-runtime", AgentRuntime, [], () => ({
					value: setup.runtime,
				})),
			],
			createSourcePluginLoader([resolve("plugins/web")]),
		);
		try {
			await plugins.services.scope.ready();
			const commands = plugins.services.get(SlashCommands);
			expect(commands.list().map((command) => command.name)).toEqual(["web"]);
			expect((await setup.root.agent(context)).tools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
			expect(await commands.list()[0]!.run("on", context)).toMatchObject({
				note: expect.stringContaining('"enabled":true'),
			});
			await plugins.reload();
			expect(commands.list().map((command) => command.name)).toEqual(["web"]);
			expect((await setup.root.agent(context)).tools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
		} finally {
			await plugins.close();
		}
		expect(setup.registry.snapshot().extension("web-retrieval")).toBeUndefined();
	});

	it("defaults off, keeps tool allowlists effective and never resolves credentials for disabled or invalid requests", async () => {
		const setup = await open();
		const fetch = vi.fn<typeof globalThis.fetch>();
		vi.stubGlobal("fetch", fetch);
		await ask(setup, "web_search", { query: "hello" });
		await configureWeb(setup.runtime, "on", context);
		await ask(setup, "web_search", { query: "😀".repeat(129) });
		await ask(setup, "web_fetch", { url: "file:///etc/passwd" });
		expect(fetch).not.toHaveBeenCalled();
		expect(setup.authCalls()).toBe(0);
		await setup.root.commit(async (tx) => {
			(await tx.doc(AgentDoc, setup.root.id)).tools = durableToolSelection({
				noTools: "all",
			});
		}, context);
		expect((await setup.root.agent(context)).tools).toEqual([]);
		expect(setup.reports).toEqual([]);
	});

	it("executes one direct request per tool without auxiliary generations, passes only actual user input and rotates keys", async () => {
		const setup = await open();
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						results: [
							{
								url: "https://source.test/",
								title: "source",
								snippet: "excerpt",
								date: null,
							},
						],
					}),
				),
		);
		vi.stubGlobal("fetch", fetch);
		await configureWeb(
			setup.runtime,
			'{"enabled":true,"count":3,"baseURL":"https://gateway.test/prefix/tools"}',
			context,
		);
		await setup.root.submit(
			{
				type: "write",
				entry: {
					kind: "injected.context",
					model: [{ role: "user", content: "injected-not-human", timestamp: 1 }],
				},
			},
			context,
		);
		await ask(setup, "web_search", { query: " query ", count: 20 }, "  actual\n question  ");
		expect(setup.faux.state.callCount).toBe(2);
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]).toMatchObject([
			"https://gateway.test/prefix/tools/search",
			{
				body: JSON.stringify({
					query: "query",
					count: 3,
					need_content: false,
					ori_question: "actual question",
				}),
				headers: {
					authorization: "Bearer fixture-key",
					"content-type": "application/json",
					accept: "application/json",
				},
			},
		]);
		await configureWeb(setup.runtime, '{"sendOriginalQuestion":false}', context);
		setup.key("rotated-key");
		fetch.mockImplementation(async () => new Response('{"content":"markdown","title":"page"}'));
		await ask(setup, "web_fetch", { url: "https://page.test" });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(setup.faux.state.callCount).toBe(4);
		expect(fetch.mock.lastCall?.[1]?.headers).toMatchObject({
			authorization: "Bearer rotated-key",
		});
		expect(fetch.mock.lastCall?.[1]?.body).toBe('{"url":"https://page.test"}');
		fetch.mockImplementation(async () => new Response('{"results":[]}'));
		await ask(setup, "web_search", { query: "again" });
		expect(fetch.mock.lastCall?.[1]?.body).not.toContain("ori_question");
		expect(setup.reports).toEqual([]);
	});

	it("does not share a queued follow-up as the active tool's original question", async () => {
		const setup = await open();
		await configureWeb(setup.runtime, "on", context);
		const bodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
				bodies.push(String(init?.body));
				return new Response('{"results":[]}');
			}),
		);
		setup.faux.setResponses([
			async () => {
				await setup.root.submit(
					{
						type: "input",
						content: "queued-private-question",
						whenBusy: "followUp",
					},
					context,
				);
				return toolResponse("web_search", { query: "active" });
			},
			fauxAssistantMessage("first"),
			fauxAssistantMessage("follow-up"),
		]);
		await (await setup.root.submit({ type: "input", content: "😀".repeat(129) }, context)).wait(context);
		await setup.root.waitForIdle(context);
		expect(bodies).toEqual([
			JSON.stringify({
				query: "active",
				count: 10,
				need_content: false,
				ori_question: "😀".repeat(128),
			}),
		]);
	});

	it("persists per-conversation settings, forks their historical value and leaves invalid updates unchanged", async () => {
		const directory = await mkdtemp(join(tmpdir(), "amazme-web-policy-"));
		directories.push(directory);
		const path = join(directory, "session.sqlite");
		const first = await open(await openNodeSqliteStorage(path));
		await configureWeb(first.runtime, '{"enabled":true,"count":4,"sendOriginalQuestion":false}', context);
		await first.root.submit({ type: "write", entry: { kind: "marker", data: {} } }, context);
		const at = (await first.root.entries({}, 1, undefined, context)).items[0]!.id;
		await configureWeb(first.runtime, "off", context);
		const fork = await first.root.fork(at, { ownership: { kind: "ownerless" } }, context);
		expect(await first.harness.snapshot(WebPolicy, fork.id, context)).toMatchObject({
			enabled: true,
			count: 4,
			sendOriginalQuestion: false,
		});
		first.select(fork.id);
		await expect(configureWeb(first.runtime, '{"apiKey":"must-not-persist"}', context)).rejects.toThrow();
		expect(await configureWeb(first.runtime, "status", context)).toMatchObject({
			enabled: true,
			count: 4,
		});
		await first.harness.close(context);
		const second = await open(await openNodeSqliteStorage(path));
		expect(await configureWeb(second.runtime, "status", context)).toMatchObject({ enabled: false, count: 4 });
		expect(JSON.stringify(await second.harness.snapshot(WebPolicy, fork.id, context))).not.toContain(
			"must-not-persist",
		);
	});

	it("captures focus once and fences queued setting changes against archive, reload and cancellation", async () => {
		const setup = await open();
		await setup.root.submit({ type: "write", entry: { kind: "marker", data: {} } }, context);
		const at = (await setup.root.entries({}, 1, undefined, context)).items[0]!.id;
		const fork = await setup.root.fork(at, { ownership: { kind: "ownerless" } }, context);
		let release!: () => void;
		const gate = withConversationAdmission(
			setup.harness,
			context,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		const update = configureWeb(setup.runtime, "on", context);
		await new Promise((resolve) => setImmediate(resolve));
		setup.select(fork.id);
		release();
		await gate;
		await update;
		expect(await setup.harness.snapshot(WebPolicy, setup.root.id, context)).toMatchObject({ enabled: true });
		expect(await setup.harness.snapshot(WebPolicy, fork.id, context)).toBeUndefined();
		await setup.harness.commit(async (tx) => {
			(await tx.doc(ForkManagementDoc)).forks[String(fork.id)] = {
				archivedAt: 1,
			};
		}, context);
		await expect(configureWeb(setup.runtime, "on", context)).rejects.toThrow("归档");
		setup.unavailable(true);
		await expect(configureWeb(setup.runtime, "on", context)).rejects.toThrow("unavailable");
		setup.unavailable(false);
		const controller = new AbortController();
		controller.abort(new Error("stop"));
		await expect(configureWeb(setup.runtime, "on", withAbortSignal(controller.signal, context))).rejects.toThrow(
			"stop",
		);
		expect(await setup.harness.snapshot(WebPolicy, fork.id, context)).toBeUndefined();
	});

	it("does not repeat a billable interrupted HTTP tool after SQLite reopen", async () => {
		const directory = await mkdtemp(join(tmpdir(), "amazme-web-recovery-"));
		directories.push(directory);
		const path = join(directory, "session.sqlite");
		const first = await open(await openNodeSqliteStorage(path));
		await configureWeb(first.runtime, "on", context);
		const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {}));
		vi.stubGlobal("fetch", fetch);
		first.faux.setResponses([toolResponse("web_search", { query: "once" })]);
		await first.root.submit({ type: "input", content: "search" }, context);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		await first.harness.close(context);
		const second = await open(await openNodeSqliteStorage(path));
		second.faux.setResponses([fauxAssistantMessage("interrupted retrieval was not verified")]);
		await second.root.waitForIdle(context);
		expect(fetch).toHaveBeenCalledOnce();
		expect(second.authCalls()).toBe(0);
		expect(await second.harness.snapshot(WebPolicy, second.root.id, context)).toMatchObject({
			...DEFAULT_WEB_SETTINGS,
			enabled: true,
		});
		expect([...first.reports, ...second.reports]).toEqual([]);
	});

	it("keeps one settings snapshot in flight and returns bounded usable tool evidence", async () => {
		const setup = await open();
		await configureWeb(setup.runtime, '{"enabled":true,"maxContentChars":5}', context);
		let deliver!: (response: Response) => void;
		const fetch = vi.fn<typeof globalThis.fetch>(
			() =>
				new Promise((resolve) => {
					deliver = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetch);
		setup.faux.setResponses([
			toolResponse("web_fetch", { url: "https://page.test" }),
			(request) => {
				const result = request.messages.findLast((message) => message.role === "toolResult");
				if (result?.role !== "toolResult") throw new Error("Missing tool result");
				expect(result.isError).toBe(false);
				expect(result.content).toEqual([
					{
						type: "text",
						text: JSON.stringify({
							provider: "deepseek-fetch-api",
							url: "https://page.test",
							content: "abcde",
							truncated: true,
						}),
					},
				]);
				return fauxAssistantMessage("verified bounded evidence");
			},
		]);
		const submission = await setup.root.submit({ type: "input", content: "fetch" }, context);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		await configureWeb(setup.runtime, '{"enabled":false,"maxContentChars":100}', context);
		deliver(new Response('{"content":"abcdef","title":"page"}'));
		expect((await submission.wait(context)).status).toBe("done");
		await ask(setup, "web_search", { query: "disabled next call" });
		expect(fetch).toHaveBeenCalledOnce();
		expect(setup.authCalls()).toBe(1);
		expect(setup.reports).toEqual([]);
	});

	it.each(["archive", "reload", "cancel"] as const)("rechecks %s after waiting for host admission", async (reason) => {
		const setup = await open();
		await setup.root.submit({ type: "write", entry: { kind: "marker", data: {} } }, context);
		const at = (await setup.root.entries({}, 1, undefined, context)).items[0]!.id;
		const fork = await setup.root.fork(at, { ownership: { kind: "ownerless" } }, context);
		setup.select(fork.id);
		let release!: () => void;
		const gate = withConversationAdmission(setup.harness, context, async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			if (reason === "archive")
				await setup.harness.commit(async (tx) => {
					(await tx.doc(ForkManagementDoc)).forks[String(fork.id)] = {
						archivedAt: 1,
					};
				}, context);
		});
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		const controller = new AbortController();
		const update = configureWeb(setup.runtime, "on", withAbortSignal(controller.signal, context));
		const rejected = expect(update).rejects.toThrow(
			reason === "archive" ? "归档" : reason === "reload" ? "unavailable" : "stop",
		);
		await new Promise((resolve) => setImmediate(resolve));
		if (reason === "reload") setup.unavailable(true);
		if (reason === "cancel") controller.abort(new Error("stop"));
		release();
		await gate;
		await rejected;
		expect(await setup.harness.snapshot(WebPolicy, fork.id, context)).toBeUndefined();
	});

	it("does not write settings when reload starts during the asynchronous archive check", async () => {
		const setup = await open();
		const snapshot = setup.harness.snapshot.bind(setup.harness);
		let release!: () => void;
		vi.spyOn(setup.harness, "snapshot").mockImplementation(async (...args) => {
			if (args[0].definition.kind === ForkManagementDoc.definition.kind)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			return snapshot(...args);
		});
		const update = configureWeb(setup.runtime, "on", context);
		const rejected = expect(update).rejects.toThrow("unavailable");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		setup.unavailable(true);
		release();
		await rejected;
		expect(await snapshot(WebPolicy, setup.root.id, context)).toBeUndefined();
	});

	it("routes the real worker command to its selected conversation across reload and archive", async () => {
		const setup = await open(undefined, false);
		const worker = await openWorkerTestServices({
			cwd: process.cwd(),
			harness: setup.harness,
			conversation: setup.root,
			registry: setup.registry,
			modelRuntime: undefined,
			facetLoader: createSourcePluginLoader([resolve("plugins/web")]),
		});
		try {
			const commands = worker.services.get(Commands);
			const conversations = worker.services.get(Conversations);
			await worker.services.ready();
			expect(commands.state.value?.commands.filter((command) => command.name === "web")).toMatchObject([
				{ source: "plugin" },
			]);
			expect(await commands.run("web", "on", context)).toMatchObject({
				ok: true,
				note: expect.stringContaining('"enabled":true'),
			});
			await setup.root.submit({ type: "write", entry: { kind: "marker", data: {} } }, context);
			const fork = await conversations.fork(String(setup.root.id), null, context);
			if (fork.conversationId === null) throw new Error("Fork was not created");
			expect(await commands.run("web", "off", context)).toMatchObject({
				ok: true,
				note: expect.stringContaining('"enabled":false'),
			});
			expect(await setup.harness.snapshot(WebPolicy, setup.root.id, context)).toMatchObject({ enabled: true });
			expect(await commands.run("reload", "", context)).toMatchObject({ ok: true });
			expect(commands.state.value?.commands.filter((command) => command.name === "web")).toHaveLength(1);
			await conversations.setArchived(fork.conversationId, true, context);
			await expect(commands.run("web", "on", context)).rejects.toThrow("归档");
			expect(await commands.run("web", "status", context)).toMatchObject({
				ok: true,
				note: expect.stringContaining('"enabled":false'),
			});
			expect(setup.authCalls()).toBe(0);
		} finally {
			await worker.close();
		}
		expect(setup.registry.snapshot().extension("web-retrieval")).toBeUndefined();
	});
});
