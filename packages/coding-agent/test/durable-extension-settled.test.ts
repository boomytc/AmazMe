import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxProvider } from "@amazme/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openDurable, type OpenDurableResult } from "../src/durable/runtime.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";
import { createTempDir } from "./temp-dir.ts";

describe("durable extension settlement", () => {
	let directory: string;
	let cwd: string;
	let runtime: ModelRuntime;
	let settings: SettingsManager;
	let faux: ReturnType<typeof fauxProvider>;
	const sessions = new Set<OpenDurableResult>();

	beforeEach(async () => {
		directory = createTempDir("amazme-extension-settled-");
		cwd = join(directory, "project");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", join(directory, "profile"));
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
		settings = SettingsManager.inMemory({
			defaultProvider: "faux",
			defaultModel: "plain",
			retry: { enabled: false },
		});
	});

	afterEach(async () => {
		await Promise.all([...sessions].map((session) => session.close().catch(() => undefined)));
		sessions.clear();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	async function runner(events: string[]): Promise<ExtensionRunner> {
		const extensionRuntime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.on("agent_start", () => {
					events.push("agent_start");
				});
				pi.on("agent_end", () => {
					events.push("agent_end");
				});
				pi.on("agent_settled", (event) => {
					events.push(`agent_settled:${String(event.aborted)}`);
				});
			},
			cwd,
			createEventBus(),
			extensionRuntime,
		);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		return new ExtensionRunner([extension], extensionRuntime, cwd, registry);
	}

	async function waitFor(check: () => boolean): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (!check()) {
			if (Date.now() > deadline) throw new Error("Condition was not reached");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	it("delivers one agent_settled to an active extension handler after a completed run", async () => {
		faux.setResponses([fauxAssistantMessage("extension answer")]);
		const events: string[] = [];
		const durable = await openDurable({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			noSession: true,
			noExtensions: true,
			noMcp: true,
			extensionRunner: await runner(events),
		});
		sessions.add(durable);
		await durable.controller.submitAndWait("hi", "steer");
		await waitFor(() => events.includes("agent_settled:false"));
		expect(events).toEqual(["agent_start", "agent_end", "agent_settled:false"]);
	});

	it("does not replay an earlier settlement to a runner attached after the run", async () => {
		const sessionDir = join(directory, "sessions");
		faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		const first = await openDurable({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			sessionDir,
			noExtensions: true,
			noMcp: true,
		});
		sessions.add(first);
		await first.controller.submitAndWait("first", "steer");
		await first.close();
		sessions.delete(first);

		const events: string[] = [];
		const reopened = await openDurable({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			sessionDir,
			continueSession: true,
			noExtensions: true,
			noMcp: true,
			extensionRunner: await runner(events),
		});
		sessions.add(reopened);
		// The snapshot is the only history a late attachment gets; settlement is a boundary event.
		await new Promise((wait) => setTimeout(wait, 250));
		expect(events).toEqual([]);
		await reopened.controller.submitAndWait("second", "steer");
		await waitFor(() => events.includes("agent_settled:false"));
		expect(events).toEqual(["agent_start", "agent_end", "agent_settled:false"]);
	});

	it("reports an aborted run to the same handler", async () => {
		const pending = new Promise<AssistantMessage>(() => {});
		faux.setResponses([async (_context, options) => new Promise<AssistantMessage>((_resolve, reject) => {
			options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			return pending;
		})]);
		const events: string[] = [];
		const durable = await openDurable({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			noSession: true,
			noExtensions: true,
			noMcp: true,
			extensionRunner: await runner(events),
		});
		sessions.add(durable);
		void durable.controller.submit("hi", "steer");
		await waitFor(() => events.includes("agent_start"));
		await durable.controller.abort();
		await waitFor(() => events.includes("agent_settled:true"));
		expect(events.filter((event) => event === "agent_settled:true")).toHaveLength(1);
	});
});
