import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fauxProvider } from "@amazme/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openDurable } from "../src/durable/runtime.ts";
import { createTempDir } from "./temp-dir.ts";

describe("durable session reopen", () => {
	let directory: string;
	let cwd: string;
	let runtime: ModelRuntime;
	let settings: SettingsManager;

	beforeEach(async () => {
		directory = createTempDir("amazme-durable-reopen-");
		cwd = join(directory, "project");
		await mkdir(cwd);
		runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false });
		const faux = fauxProvider({ models: [{ id: "reason", reasoning: true }] });
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
		settings = SettingsManager.inMemory({ defaultProvider: "faux", defaultModel: "reason" });
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("recovers the project cwd when opened by session directory", async () => {
		const first = await openDurable({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			sessionDir: join(directory, "sessions"),
			noExtensions: true,
			noMcp: true,
		});
		const sessionDirectory = first.view.current().session.directory;
		expect(sessionDirectory).toBeDefined();
		await first.close();

		const reopened = await openDurable({
			modelRuntime: runtime,
			settingsManager: settings,
			sessionDirectory: sessionDirectory!,
			noExtensions: true,
			noMcp: true,
		});
		try {
			expect(reopened.view.current().session.directory).toBe(await realpath(sessionDirectory!));
			expect(reopened.view.current().session.cwd).toBe(await realpath(cwd));
		} finally {
			await reopened.close();
		}
	});
});
