import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@amazme/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { exportDurableSession, runExportCommand } from "../src/durable/export.ts";
import { openDurable, type OpenDurableResult } from "../src/durable/runtime.ts";

describe("durable session export", () => {
	let directory: string;
	let cwd: string;
	let profile: string;
	let runtime: ModelRuntime;
	let settings: SettingsManager;
	let faux: ReturnType<typeof fauxProvider>;
	let durable: OpenDurableResult | undefined;
	let database: string;
	let sessionId: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "amazme-durable-export-"));
		cwd = join(directory, "project");
		profile = join(directory, "profile");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		const credentials = AuthStorage.inMemory();
		runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		faux = fauxProvider({ models: [{ id: "plain", reasoning: false, contextWindow: 200000, maxTokens: 8192 }] });
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
		settings = SettingsManager.inMemory({ defaultProvider: "faux", defaultModel: "plain", retry: { enabled: false } });
		durable = await openDurable({
			cwd,
			sessionDir: join(directory, "sessions"),
			modelRuntime: runtime,
			settingsManager: settings,
			noExtensions: true,
			noMcp: true,
		});
		sessionId = durable.view.current().session.id;
		database = join(durable.view.current().session.directory ?? "", "session.sqlite");
		faux.setResponses([fauxAssistantMessage("exported answer")]);
		await durable.controller.submitAndWait("hello export", "steer");
		await durable.close();
		durable = undefined;
	});

	afterEach(async () => {
		await durable?.close();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("exports the active transcript as JSONL", async () => {
		const output = join(directory, "session-export.jsonl");
		const result = await exportDurableSession(database, { output, format: "jsonl" });
		expect(result.format).toBe("jsonl");
		expect(result.report.carried).toBeGreaterThan(0);
		const lines = (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
		expect(lines[0]).toMatchObject({ type: "session", version: 3 });
		const content = (await readFile(output, "utf8")).toString();
		expect(content).toContain("exported answer");
	});

	it("exports HTML and exposes the CLI handler", async () => {
		const output = join(directory, "session-export.html");
		const result = await exportDurableSession(database, { output, format: "html" });
		expect(result.path).toBe(output);
		expect(await readFile(output, "utf8")).toContain("<!DOCTYPE html>");

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const jsonl = join(directory, "cli-export.jsonl");
		await expect(runExportCommand([database, jsonl])).resolves.toBe(0);
		expect(log.mock.calls.flat().join("\n")).toContain("Exported to:");
		expect(await readFile(jsonl, "utf8")).toContain("exported answer");
		expect(sessionId.length).toBeGreaterThan(0);
	});
});
