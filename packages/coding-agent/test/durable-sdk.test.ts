import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@amazme/ai";
import type { AgentEvent } from "@amazme/durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createDurableSession, type DurableSession } from "../src/durable/sdk.ts";
import { createTempDir } from "./temp-dir.ts";

describe("durable SDK facade", () => {
	let directory: string;
	let cwd: string;
	let profile: string;
	let runtime: ModelRuntime;
	let settings: SettingsManager;
	let faux: ReturnType<typeof fauxProvider>;
	const sessions: DurableSession[] = [];

	beforeEach(async () => {
		directory = createTempDir("amazme-durable-sdk-");
		cwd = join(directory, "project");
		profile = join(directory, "profile");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		const credentials = AuthStorage.inMemory();
		runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		faux = fauxProvider({
			models: [{ id: "reason", reasoning: true, contextWindow: 200000, maxTokens: 8192 }],
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
			defaultModel: "reason",
			defaultThinkingLevel: "low",
			modelThinkingLevels: { "faux/reason": "high" },
			retry: { enabled: false },
		});
	});

	afterEach(async () => {
		await Promise.all(sessions.splice(0).map((session) => session.dispose()));
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("prompts, streams events, selects a model, and reads the committed transcript", async () => {
		faux.setResponses([fauxAssistantMessage("sdk answer")]);
		const session = await createDurableSession({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			noSession: true,
			noExtensions: true,
			noMcp: true,
		});
		sessions.push(session);
		const events: AgentEvent[] = [];
		session.subscribe((batch) => events.push(...batch));

		const answer = await session.prompt("hello");
		expect(answer).toMatchObject({ role: "assistant", content: [{ type: "text", text: "sdk answer" }] });
		expect(session.messages().map((message) => message.role).filter((role) => role === "user" || role === "assistant")).toEqual(["user", "assistant"]);
		expect(session.model).toEqual({ provider: "faux", modelId: "reason" });
		expect(events.some((event) => event.type === "message_end")).toBe(true);

		await session.setThinkingLevel("high");
		expect(session.thinkingLevel).toBe("high");
		await expect(session.setModel({ provider: "missing", modelId: "missing" })).rejects.toThrow("Unknown model");
	});

	it("throws an unanswered prompt without pretending it produced an answer", async () => {
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture failure" })]);
		const session = await createDurableSession({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			noSession: true,
			noExtensions: true,
			noMcp: true,
		});
		sessions.push(session);

		await expect(session.prompt("fail")).rejects.toThrow();
	});

	it("releases the session lock when the initial prompt fails", async () => {
		const sessionDir = join(directory, "sessions");
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture failure" })]);
		await expect(
			createDurableSession({
				cwd,
				sessionDir,
				modelRuntime: runtime,
				settingsManager: settings,
				noExtensions: true,
				noMcp: true,
				initialMessage: "fail first",
			}),
		).rejects.toThrow(/No answer|fixture failure/);

		faux.setResponses([fauxAssistantMessage("retried")]);
		const session = await createDurableSession({
			cwd,
			sessionDir,
			continueSession: true,
			modelRuntime: runtime,
			settingsManager: settings,
			noExtensions: true,
			noMcp: true,
			initialMessage: "try again",
		});
		sessions.push(session);
		const answered = session.messages().some((message) =>
			message.role === "assistant" && JSON.stringify(message.content).includes("retried"));
		expect(answered).toBe(true);
	});
});
