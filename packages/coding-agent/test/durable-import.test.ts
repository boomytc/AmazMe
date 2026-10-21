import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxProvider } from "@amazme/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { importSessionFile, runImportCommand } from "../src/durable/import.ts";
import { openDurable, type OpenDurableResult } from "../src/durable/runtime.ts";
import { createTempDir } from "./temp-dir.ts";

describe("durable session import", () => {
	let directory: string;
	let cwd: string;
	let profile: string;
	let sessionDir: string;
	let runtime: ModelRuntime;
	let settings: SettingsManager;
	const sessions = new Set<OpenDurableResult>();

	beforeEach(async () => {
		directory = createTempDir("amazme-durable-import-");
		cwd = join(directory, "project");
		profile = join(directory, "profile");
		sessionDir = join(directory, "sessions");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		const credentials = AuthStorage.inMemory();
		runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		runtime.registerNativeProvider({
			...fauxProvider({ models: [{ id: "plain", reasoning: false, contextWindow: 200000, maxTokens: 8192 }] }).provider,
			auth: {
				apiKey: {
					name: "Fixture",
					check: async () => ({ type: "api_key", source: "env" }),
					resolve: async () => ({ auth: {} }),
				},
			},
		});
		await runtime.refresh({ allowNetwork: false });
		settings = SettingsManager.inMemory({ defaultProvider: "faux", defaultModel: "plain", retry: { enabled: false } });
	});

	afterEach(async () => {
		await Promise.all([...sessions].map((session) => session.close()));
		sessions.clear();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	async function writeSession(): Promise<string> {
		const timestamp = new Date().toISOString();
		const records = [
			{ type: "session", version: 3, id: "terminal-session", timestamp, cwd },
			{ type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "hello durable", timestamp: Date.now() } },
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "imported answer" }],
					api: "faux",
					provider: "faux",
					model: "plain",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				},
			},
			{ type: "model_change", id: "m1", parentId: "a1", timestamp, provider: "faux", modelId: "plain" },
		];
		const file = join(directory, "terminal.jsonl");
		await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n"));
		return file;
	}

	it("imports the representable transcript and reports skipped records", async () => {
		const file = await writeSession();
		const imported = await importSessionFile(file, { sessionDir });
		expect(imported.report).toEqual({ carried: 2, skipped: { model_change: 1 } });
		expect(imported.directory).toBeDefined();

		const reopened = await openDurable({
			cwd,
			sessionDir,
			continueSession: true,
			noExtensions: true,
			noMcp: true,
			modelRuntime: runtime,
			settingsManager: settings,
		});
		sessions.add(reopened);
		const entries = reopened.view.current().conversation.entries;
		expect(entries.map((entry) => entry.kind)).toEqual(["amazme.user", "amazme.assistant"]);
		expect(entries[1]?.model?.[0]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "imported answer" }] });
	});

	it("imports a legacy v1 session after migrating it", async () => {
		const timestamp = new Date().toISOString();
		const file = join(directory, "legacy-v1.jsonl");
		const records = [
			{ type: "session", version: 1, id: "legacy-v1", timestamp, cwd },
			{ type: "message", timestamp, message: { role: "user", content: "legacy hello", timestamp: Date.now() } },
			{
				type: "message",
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "legacy answer" }],
					api: "faux",
					provider: "faux",
					model: "plain",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				},
			},
		];
		await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n"));

		const imported = await importSessionFile(file, { sessionDir });
		expect(imported.report).toEqual({ carried: 2, skipped: {} });
	});

	it("rejects a branched terminal history instead of flattening it", async () => {
		const timestamp = new Date().toISOString();
		const file = join(directory, "branched.jsonl");
		const records = [
			{ type: "session", version: 3, id: "branched", timestamp, cwd },
			{ type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "root", timestamp: Date.now() } },
			{ type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "one" }], api: "faux", provider: "faux", model: "plain", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } },
			{ type: "message", id: "u2", parentId: "u1", timestamp, message: { role: "user", content: "branch", timestamp: Date.now() } },
		];
		await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n"));
		await expect(importSessionFile(file, { sessionDir })).rejects.toThrow("Branched terminal sessions");
	});

	it("prints the import result through the CLI handler", async () => {
		const file = await writeSession();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(runImportCommand([file, "--session-dir", sessionDir])).resolves.toBe(0);
		expect(log.mock.calls.flat().join("\n")).toContain("Imported 2 entries");
	});
});
