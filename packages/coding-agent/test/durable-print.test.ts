import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@amazme/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runDurablePrint } from "../src/durable/print.ts";
import { openDurable, type OpenDurableResult } from "../src/durable/runtime.ts";

describe("durable print", () => {
	let directory: string;
	let cwd: string;
	let profile: string;
	let runtime: ModelRuntime;
	let settings: SettingsManager;
	let faux: ReturnType<typeof fauxProvider>;
	const sessions = new Set<OpenDurableResult>();
	const writes: string[] = [];
	const originalWrite = process.stdout.write;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "amazme-durable-print-"));
		cwd = join(directory, "project");
		profile = join(directory, "profile");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		const credentials = AuthStorage.inMemory();
		runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		faux = fauxProvider({
			models: [{ id: "plain", reasoning: false, contextWindow: 200000, maxTokens: 8192 }],
		});
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
		settings = SettingsManager.inMemory({
			defaultProvider: "faux",
			defaultModel: "plain",
			retry: { enabled: false },
		});
		writes.length = 0;
		process.stdout.write = ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			writes.push(String(chunk));
			(typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		await Promise.all([...sessions].map((session) => session.close()));
		sessions.clear();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("prints the committed answer and returns zero", async () => {
		faux.setResponses([fauxAssistantMessage("durable answer")]);

		const exitCode = await runDurablePrint({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			noSession: true,
			noExtensions: true,
			noMcp: true,
			initialMessage: "say durable answer",
		});

		expect(exitCode).toBe(0);
		expect(writes.join("")).toContain("durable answer");
	});

	it("keeps the answer in the durable session for --continue", async () => {
		faux.setResponses([fauxAssistantMessage("persisted answer")]);
		const sessionDir = join(directory, "sessions");
		const first = await runDurablePrint({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			sessionDir,
			noExtensions: true,
			noMcp: true,
			initialMessage: "persist this",
		});
		expect(first).toBe(0);

		const reopened = await openDurable({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			sessionDir,
			continueSession: true,
			noExtensions: true,
			noMcp: true,
		});
		sessions.add(reopened);
		const entries = reopened.view.current().conversation.entries;
		const answer = entries.find((entry) => entry.kind === "amazme.assistant")?.model?.[0];
		expect(answer).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "persisted answer" }],
		});
	});

	it("streams the existing JSON event names in json mode", async () => {
		faux.setResponses([fauxAssistantMessage("json answer")]);

		const exitCode = await runDurablePrint({
			mode: "json",
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			noSession: true,
			noExtensions: true,
			noMcp: true,
			initialMessage: "say json answer",
		});

		expect(exitCode).toBe(0);
		const lines = writes.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; message?: { role?: string } });
		expect(lines[0]).toMatchObject({ type: "session", version: 3, storage: "durable" });
		expect(lines.map((line) => line.type)).toEqual(expect.arrayContaining(["agent_start", "message_start", "message_end", "agent_end"]));
		expect(lines.some((line) => line.type === "message_start" && line.message?.role === "assistant")).toBe(true);
	});

	it("returns non-zero when the provider fails", async () => {
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture failure" })]);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runDurablePrint({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			noSession: true,
			noExtensions: true,
			noMcp: true,
			initialMessage: "fail",
		});

		expect(exitCode).toBe(1);
		expect(error.mock.calls.flat().join("\n")).toContain("fixture failure");
	});
});
