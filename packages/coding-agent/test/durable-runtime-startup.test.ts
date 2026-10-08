import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type SimpleStreamOptions } from "@amazme/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { agentOf, openDurable, type OpenDurableResult } from "../src/durable/runtime.ts";
import { pendingResponse } from "./experimental-durable-support.ts";

describe("durable startup over SQLite", () => {
	let directory: string;
	let cwd: string;
	let profile: string;
	let runtime: ModelRuntime;
	let credentials: AuthStorage;
	let settings: SettingsManager;
	let faux: ReturnType<typeof fauxProvider>;
	const sessions = new Set<OpenDurableResult>();

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "amazme-durable-startup-"));
		cwd = join(directory, "project");
		profile = join(directory, "profile");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		credentials = AuthStorage.inMemory();
		runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		faux = fauxProvider({
			models: [
				{ id: "reason", reasoning: true, contextWindow: 200000, maxTokens: 8192 },
				{ id: "plain", reasoning: false, contextWindow: 200000, maxTokens: 8192 },
			],
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
			modelThinkingLevels: { "faux/reason": "high", "faux/plain": "high" },
			retry: { enabled: false },
		});
	});

	afterEach(async () => {
		await Promise.all([...sessions].map((session) => session.close()));
		sessions.clear();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	async function open(options: Parameters<typeof openDurable>[0] = {}): Promise<OpenDurableResult> {
		const session = await openDurable({ cwd, modelRuntime: runtime, settingsManager: settings, ...options });
		sessions.add(session);
		return session;
	}

	async function answer(session: OpenDurableResult): Promise<void> {
		faux.setResponses([fauxAssistantMessage("answered")]);
		const before = faux.state.callCount;
		await session.controller.submit("question", "steer");
		await vi.waitFor(() => {
			expect(faux.state.callCount).toBe(before + 1);
			expect(session.view.current().lane.run).toBe("idle");
			expect(session.view.current().conversation.entries.some((entry) => entry.kind === "amazme.assistant")).toBe(true);
		});
	}

	it.each([
		[undefined, "reason", "high"],
		["faux/plain", "plain", "off"],
		["faux/reason:low", "reason", "low"],
		["faux/reason:max", "reason", "high"],
	])("selects %s with supported thinking and persists it", async (model, modelId, thinkingLevel) => {
		const session = await open(model === undefined ? {} : { model });
		expect(agentOf(session.view.current().conversation)).toMatchObject({
			model: { provider: "faux", modelId },
			thinkingLevel,
		});
		await session.close();
		const restored = await open({ continueSession: true });
		expect(restored.view.current().session.id).toBe(session.view.current().session.id);
		expect(agentOf(restored.view.current().conversation)).toMatchObject({
			model: { provider: "faux", modelId },
			thinkingLevel,
		});
	});

	it("explicit thinking overrides the model suffix and per-model settings", async () => {
		const session = await open({ provider: "faux", model: "reason:high", thinkingLevel: "low" });
		expect(agentOf(session.view.current().conversation).thinkingLevel).toBe("low");
		let requested: SimpleStreamOptions | undefined;
		faux.setResponses([
			(_context, options) => {
				requested = options;
				return fauxAssistantMessage("answer");
			},
		]);
		await session.controller.submit("question", "steer");
		await vi.waitFor(() => expect(requested?.reasoning).toBe("low"));
	});

	it("thinking alone overrides the default model and remains clamped", async () => {
		const session = await open({ thinkingLevel: "max" });
		expect(agentOf(session.view.current().conversation).thinkingLevel).toBe("high");
	});

	it("restores the focused fork before applying startup overrides", async () => {
		const original = await open({ model: "faux/reason", thinkingLevel: "low" });
		const rootId = original.view.current().conversation.conversation.id;
		await answer(original);
		await original.controller.fork();
		const forkId = original.view.current().conversation.conversation.id;
		expect(forkId).not.toBe(rootId);
		await original.close();

		const restored = await open({ continueSession: true, model: "faux/plain", thinkingLevel: "high" });
		expect(restored.view.current().conversation.conversation.id).toBe(forkId);
		expect(agentOf(restored.view.current().conversation)).toMatchObject({
			model: { provider: "faux", modelId: "plain" },
			thinkingLevel: "off",
		});
		await restored.controller.switchConversation(rootId);
		expect(agentOf(restored.view.current().conversation)).toMatchObject({
			model: { provider: "faux", modelId: "reason" },
			thinkingLevel: "low",
		});
		await restored.controller.switchConversation(forkId);
		await restored.close();
		const reopened = await open({ continueSession: true });
		expect(reopened.view.current().conversation.conversation.id).toBe(forkId);
		expect(agentOf(reopened.view.current().conversation).model?.modelId).toBe("plain");
	});

	it("a resumed model override preserves saved thinking unless explicitly overridden", async () => {
		const original = await open({ thinkingLevel: "low" });
		await original.close();
		const restored = await open({ continueSession: true, model: "faux/reason" });
		expect(agentOf(restored.view.current().conversation).thinkingLevel).toBe("low");
		await restored.close();
		const changed = await open({ continueSession: true, thinkingLevel: "high" });
		expect(agentOf(changed.view.current().conversation).thinkingLevel).toBe("high");
	});

	it("preserves a prepared request on recovery and uses the override for the next generation", async () => {
		const original = await open({ model: "faux/reason", thinkingLevel: "low" });
		const pending = pendingResponse();
		faux.setResponses([pending.step]);
		await original.controller.submit("interrupted question", "steer");
		await pending.reached;
		await original.close();
		const calls: { model: string; thinking: SimpleStreamOptions["reasoning"] }[] = [];
		const reply = (
			_context: unknown,
			options: SimpleStreamOptions | undefined,
			_state: unknown,
			model: { id: string },
		) => {
			calls.push({ model: model.id, thinking: options?.reasoning });
			return fauxAssistantMessage("recovered answer");
		};
		faux.setResponses([reply, reply]);
		const restored = await open({ continueSession: true, model: "faux/plain", thinkingLevel: "high" });
		await vi.waitFor(() => {
			expect(calls).toEqual([{ model: "reason", thinking: "low" }]);
			expect(restored.view.current().lane.run).toBe("idle");
		});
		await restored.controller.submit("next question", "steer");
		await vi.waitFor(() =>
			expect(calls).toEqual([
				{ model: "reason", thinking: "low" },
				{ model: "plain", thinking: undefined },
			]),
		);
	});

	it.each([
		[{ provider: "faux" }, "--provider requires --model"],
		[{ apiKey: "fixture-secret" }, "--api-key requires --model"],
		[{ model: "unavailable-provider/unknown" }, "Could not resolve model"],
	])("rejects invalid startup arguments before creating session storage", async (options, message) => {
		await expect(open(options)).rejects.toThrow(message);
		expect(existsSync(join(profile, "experimental", "durable-sessions"))).toBe(false);
	});

	it("an invalid continuation leaves existing storage and the lock available", async () => {
		const original = await open();
		const sessionDirectory = original.view.current().session.directory;
		await original.close();
		const before = await readdir(sessionDirectory);
		await expect(open({ continueSession: true, model: "unavailable-provider/unknown" })).rejects.toThrow(
			"Could not resolve model",
		);
		expect(await readdir(sessionDirectory)).toEqual(before);
		const restored = await open({ continueSession: true });
		expect(restored.view.current().session.id).toBe(original.view.current().session.id);
	});

	it("uses a runtime API key for generation without persisting it", async () => {
		runtime.registerNativeProvider({
			...faux.provider,
			auth: {
				apiKey: {
					check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
					name: "Fixture key",
					resolve: async ({ credential }) => (credential ? { auth: { apiKey: credential.key } } : undefined),
				},
			},
		});
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.hasConfiguredAuth("faux")).toBe(false);
		const session = await open({ model: "faux/reason", apiKey: "fixture-secret" });
		let requested: SimpleStreamOptions | undefined;
		faux.setResponses([
			(_context, options) => {
				requested = options;
				return fauxAssistantMessage("answer");
			},
		]);
		await session.controller.submit("question", "steer");
		await vi.waitFor(() => expect(requested?.apiKey).toBe("fixture-secret"));
		expect(await credentials.read("faux")).toBeUndefined();
		expect(existsSync(join(profile, "auth.json"))).toBe(false);
		expect(session.settings).toBe(settings);
	});
});
