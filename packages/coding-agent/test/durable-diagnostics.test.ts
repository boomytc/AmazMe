import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "@amazme/ai";
import type { EntryRecord } from "@amazme/durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { readCrashLog, recordCrash } from "../src/core/crash-log.ts";
import { computeCacheWaste } from "../src/core/cache-stats.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openDurable, type OpenDurableResult } from "../src/durable/runtime.ts";
import { runDurableInteractive } from "../src/durable/interactive.ts";
import { runDurableTui } from "../src/durable/tui.ts";
import { sessionEntriesFor } from "../src/durable/session-surface.ts";
import { pendingResponse } from "./experimental-durable-support.ts";

vi.mock("../src/durable/tui.ts", () => ({ runDurableTui: vi.fn() }));

/** Read the standard deflated ZIP files emitted by the report exporter. */
async function archive(path: string): Promise<Record<string, string>> {
	const bytes = await readFile(path);
	const files: Record<string, string> = {};
	for (let offset = 0; bytes.readUInt32LE(offset) === 0x04034b50; ) {
		const size = bytes.readUInt32LE(offset + 18);
		const nameLength = bytes.readUInt16LE(offset + 26);
		const extraLength = bytes.readUInt16LE(offset + 28);
		const start = offset + 30 + nameLength + extraLength;
		const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString();
		files[name] = inflateRawSync(bytes.subarray(start, start + size)).toString();
		offset = start + size;
	}
	return files;
}

describe("durable diagnostic commands", () => {
	let directory: string;
	let cwd: string;
	let runtime: ModelRuntime;
	let settings: SettingsManager;
	let faux: ReturnType<typeof fauxProvider>;
	const sessions: OpenDurableResult[] = [];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "amazme-diagnostics-"));
		cwd = join(directory, "project");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", join(directory, "profile"));
		settings = SettingsManager.inMemory({ defaultProvider: "faux", defaultModel: "plain", retry: { enabled: false } });
		runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		faux = fauxProvider({ models: [{ id: "plain", contextWindow: 200000, maxTokens: 8192 }] });
		runtime.registerNativeProvider({
			...faux.provider,
			auth: {
				apiKey: {
					name: "Fixture",
					check: async () => ({ type: "api_key", source: "env" }),
					resolve: async () => ({ auth: {} }),
				},
			},
		});
		await runtime.refresh({ allowNetwork: false });
	});

	afterEach(async () => {
		await Promise.all(sessions.map((session) => session.close()));
		sessions.length = 0;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	async function open(continueSession = false): Promise<OpenDurableResult> {
		const session = await openDurable({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			continueSession,
			noMcp: true,
			noExtensions: true,
		});
		sessions.push(session);
		return session;
	}

	async function answer(session: OpenDurableResult): Promise<void> {
		faux.setResponses([fauxAssistantMessage("private assistant output")]);
		await session.controller.submitAndWait("private user message", "steer");
	}

	async function exported(): Promise<Record<string, string>> {
		const files = (await readdir(cwd)).filter((name) => name.endsWith(".zip"));
		expect(files).toHaveLength(1);
		return archive(join(cwd, files[0]!));
	}

	it("exports diagnostics without conversation content and persists the report receipt", async () => {
		const session = await open();
		await answer(session);
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await session.controller.reportBug({ content: "diagnostics", delivery: "zip", hint: "unexpected output" });
		const files = await exported();
		expect(Object.keys(files).sort()).toEqual(["diagnostics.json", "report.json"]);
		expect(JSON.stringify(files)).not.toContain("private user message");
		expect(JSON.stringify(files)).not.toContain("private assistant output");
		expect(JSON.parse(files["report.json"]!)).toMatchObject({
			hint: "unexpected output",
			session: { included: false, summaryIncluded: false, messageCount: 2 },
			pluginSources: [],
		});
		expect(fetch).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(session.view.current().conversation.entries.some((entry) => entry.kind === "amazme.bug-report")).toBe(
				true,
			),
		);
	});

	it("includes the full transcript only when explicitly selected", async () => {
		const session = await open();
		await answer(session);
		await session.controller.reportBug({ content: "session", delivery: "zip" });
		const files = await exported();
		expect(files["session.jsonl"]).toContain("private user message");
		expect(files["session.jsonl"]).toContain("private assistant output");
		expect(JSON.parse(files["report.json"]!)).toMatchObject({
			session: { included: true, summaryIncluded: false, cwd: session.view.current().session.cwd },
		});
	});

	it("uses the configured model for an optional summary without attaching the transcript", async () => {
		const session = await open();
		await answer(session);
		let prompt = "";
		faux.setResponses([
			(context) => {
				prompt = JSON.stringify(context);
				return fauxAssistantMessage("A concise bug summary");
			},
		]);
		await session.controller.reportBug({ content: "summary", delivery: "zip" });
		const files = await exported();
		expect(prompt).toContain("private user message");
		expect(files["summary.md"]).toContain("A concise bug summary");
		expect(files).not.toHaveProperty("session.jsonl");
		expect(JSON.parse(files["report.json"]!)).toMatchObject({ session: { summaryIncluded: true, included: false } });
	});

	it("uploads only the selected files and records successful delivery", async () => {
		const session = await open();
		await answer(session);
		vi.stubEnv("AMAZME_OFFLINE", undefined);
		const fetch = vi.fn(
			async () => new Response(JSON.stringify({ ok: true, bug_report: { id: "uploaded-1" } }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetch);
		await session.controller.reportBug({ content: "diagnostics", delivery: "upload" });
		expect(fetch).toHaveBeenCalledOnce();
		const [url, request] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
		expect(url.pathname).toBe("/v1/bug-reports");
		expect(request.method).toBe("POST");
		expect([...(request.body as FormData).keys()].sort()).toEqual(["diagnostics.json", "report.json"]);
		expect(session.view.current().notices.some((notice) => notice.message.includes("uploaded-1"))).toBe(true);
		expect((await readdir(cwd)).filter((name) => name.endsWith(".zip"))).toEqual([]);
	});

	it("preserves diagnostics after upload failure and permits a local export retry", async () => {
		const session = await open();
		recordCrash({ kind: "fatal_error", cwd, error: new Error("retained crash") });
		vi.stubEnv("AMAZME_OFFLINE", undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "unavailable" }), { status: 503 })),
		);
		await session.controller.reportBug({ content: "diagnostics", delivery: "upload" });
		expect(session.view.current().notices.some((notice) => notice.message.includes("Bug report upload failed"))).toBe(
			true,
		);
		expect(session.view.current().conversation.entries.some((entry) => entry.kind === "amazme.bug-report")).toBe(false);
		expect(readCrashLog()).toHaveLength(1);
		await session.controller.reportBug({ content: "diagnostics", delivery: "zip" });
		expect(await exported()).toHaveProperty("diagnostics.json");
		expect(readCrashLog()).toHaveLength(0);
	});

	it("blocks offline upload before generating a summary or contacting the gateway", async () => {
		const session = await open();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await session.controller.reportBug({ content: "summary", delivery: "upload" });
		expect(fetch).not.toHaveBeenCalled();
		expect(faux.state.callCount).toBe(0);
		expect(session.view.current().notices.some((notice) => notice.message.includes("requires online mode"))).toBe(true);
	});

	it("retains a new crash recorded while an upload is in flight", async () => {
		const session = await open();
		recordCrash({ kind: "fatal_error", cwd, error: new Error("included crash") });
		vi.stubEnv("AMAZME_OFFLINE", undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				recordCrash({ kind: "fatal_error", cwd, error: new Error("new crash") });
				return new Response(JSON.stringify({ ok: true, bug_report: { id: "uploaded-2" } }), { status: 200 });
			}),
		);
		await session.controller.reportBug({ content: "diagnostics", delivery: "upload" });
		expect(readCrashLog().map((crash) => crash.message)).toContain("new crash");
	});

	it("cancels summary generation without writing a report", async () => {
		const session = await open();
		const pending = pendingResponse();
		faux.setResponses([pending.step]);
		const report = session.controller.reportBug({ content: "summary", delivery: "zip" });
		await pending.reached;
		await session.controller.abort();
		await report;
		expect((await readdir(cwd)).filter((name) => name.endsWith(".zip"))).toEqual([]);
		expect(session.view.current().conversation.entries.some((entry) => entry.kind === "amazme.bug-report")).toBe(false);
	});

	it("offers a recent crash on startup and attaches it to diagnostics", async () => {
		recordCrash({ kind: "fatal_error", cwd, error: new Error("fixture crash") });
		const session = await open();
		expect(session.view.current().notices.some((notice) => notice.message.includes("fixture crash"))).toBe(true);
		await session.controller.reportBug({ content: "diagnostics", delivery: "zip" });
		const files = await exported();
		expect(JSON.parse(files["diagnostics.json"]!)).toMatchObject({
			crashes: [{ message: "fixture crash", kind: "fatal_error" }],
		});
		expect(readCrashLog()).toHaveLength(0);
	});

	it("records fatal presentation errors and removes the crash monitor after releasing the session", async () => {
		const listeners = process.listenerCount("uncaughtExceptionMonitor");
		const failure = new Error("presentation failed");
		vi.mocked(runDurableTui).mockRejectedValueOnce(failure);
		await expect(
			runDurableInteractive({ cwd, modelRuntime: runtime, settingsManager: settings, noMcp: true, noExtensions: true }),
		).rejects.toBe(failure);
		expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(listeners);
		expect(readCrashLog()).toMatchObject([{ message: "presentation failed", kind: "fatal_error" }]);
		const restored = await open(true);
		expect(restored.view.current().notices.some((notice) => notice.message.includes("presentation failed"))).toBe(true);
	});

	it.each(["amazme.compaction", "amazme.branch-summary", "amazme.reset"])("resets cache comparison at %s", (kind) => {
		const before = structuredClone(fauxAssistantMessage("before"));
		before.usage.cacheWrite = 100000;
		const after = structuredClone(fauxAssistantMessage("after"));
		after.usage.cacheWrite = 20000;
		const entries: EntryRecord[] = [
			{
				id: 1 as EntryRecord["id"],
				conversationId: 1 as EntryRecord["conversationId"],
				kind: "amazme.assistant",
				model: [before],
			},
			{
				id: 2 as EntryRecord["id"],
				conversationId: 1 as EntryRecord["conversationId"],
				kind,
				data: { summary: "summary", from: { entryId: 1 } },
			},
			{
				id: 3 as EntryRecord["id"],
				conversationId: 1 as EntryRecord["conversationId"],
				kind: "amazme.assistant",
				model: [after],
			},
		];
		expect(computeCacheWaste(sessionEntriesFor(entries), runtime).missCount).toBe(0);
	});

	it("recomputes cumulative cache waste after restoring and forking the session", async () => {
		const session = await open();
		const first = fauxAssistantMessage("first");
		first.usage = { ...first.usage, cacheWrite: 100000, cost: { ...first.usage.cost, cacheWrite: 0.375 } };
		const second = fauxAssistantMessage("second");
		second.usage = { ...second.usage, cacheWrite: 110000, cost: { ...second.usage.cost, cacheWrite: 0.4125 } };
		const responses = [first, second];
		// The faux provider estimates its own usage; this fixture must preserve provider-reported counts.
		runtime.registerNativeProvider({
			...runtime.getProvider("faux")!,
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				const message = responses.shift()!;
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			},
		});
		await session.controller.submitAndWait("first", "steer");
		await session.controller.submitAndWait("second", "steer");
		await session.controller.fork();
		await session.close();
		const restored = await open(true);
		await restored.controller.runCommand("session", "");
		expect(
			restored.view
				.current()
				.notices.map((notice) => notice.message)
				.join("\n"),
		).toContain("Cache misses: 1; 100000 tokens re-billed");
	});
});
