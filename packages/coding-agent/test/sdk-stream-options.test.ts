import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	fauxAssistantMessage,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@amazme/ai";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { Harness, LiveDoc, type LiveState, MemoryStorage } from "@amazme/durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createHarnessSettings } from "../src/durable/harness-setup.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(api: Api): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	function createDoneMessage(api: Api, promptTokens = 0): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: promptTokens,
				cacheWrite: 0,
				totalTokens: promptTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function createDoneStream(api: Api, promptTokens = 0) {
		const stream = createAssistantMessageEventStream();
		stream.end(createDoneMessage(api, promptTokens));
		return stream;
	}

	async function captureStreamOptions(
		api: Api,
		settings: Partial<Settings>,
		requestOptions: SimpleStreamOptions = {},
		extensionFactory?: ExtensionFactory,
		providerEvent?: unknown,
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory(settings);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: extensionFactory ? [extensionFactory] : [],
		});
		await resourceLoader.reload();

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			headers: { "x-provider": "provider" },
			streamSimple: (requestModel, _context, providerOptions) => {
				capturedOptions = providerOptions;
				if (providerEvent === undefined) return createDoneStream(api);

				const stream = createAssistantMessageEventStream();
				void (async () => {
					await providerOptions?.onProviderStreamEvent?.(providerEvent, requestModel);
					stream.end(createDoneMessage(api));
				})();
				return stream;
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		try {
			if (providerEvent === undefined) {
				const stream = await session.agent.streamFunction(
					model,
					normalizeContext({ messages: [] }),
					requestOptions,
				);
				await stream.result();
			} else {
				await session.prompt("test");
			}
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	async function createCacheWarmingSession(populate?: (manager: SessionManager, model: Model<Api>) => void) {
		const model: Model<Api> = {
			...createModel("anthropic-messages"),
			cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
			promptCache: { short: 300 },
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let providerCalls = 0;
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: () => {
				providerCalls++;
				return createDoneStream(model.api, 100_000);
			},
		});
		const sessionManager = SessionManager.inMemory(cwd);
		populate?.(sessionManager, model);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory({ cacheWarming: "idle" }),
			sessionManager,
		});
		return {
			session,
			providerCalls: () => providerCalls,
			dispose: () => {
				session.dispose();
				modelRegistry.unregisterProvider(model.provider);
			},
		};
	}

	it("schedules cache warming after a completed session request", async () => {
		const fixture = await createCacheWarmingSession();
		try {
			await fixture.session.prompt("test");
			expect(fixture.session.cacheWarmingStatus?.nextWarmAt).toBeGreaterThan(Date.now());

			// Equivalent shallow copies remain current, but removing the request prefix does not.
			fixture.session.agent.state.messages = [...fixture.session.agent.state.messages];
			fixture.session.agent.state.model = { ...fixture.session.agent.state.model };
			expect(fixture.session.cacheWarmingStatus?.nextWarmAt).toBeGreaterThan(Date.now());
			fixture.session.agent.state.messages = fixture.session.agent.state.messages.slice(1);
			expect(fixture.session.cacheWarmingStatus?.reason).toBe("conversation context changed");
		} finally {
			fixture.dispose();
		}
	});

	it("waits for the next request instead of restoring cache warming", async () => {
		const fixture = await createCacheWarmingSession((manager, model) => {
			manager.appendModelChange(model.provider, model.id);
			manager.appendThinkingLevelChange("off");
			manager.appendMessage({ role: "user", content: "test", timestamp: Date.now() - 60_000 });
			const assistant = { ...createDoneMessage(model.api, 100_000), timestamp: Date.now() - 59_000 };
			manager.appendMessage(assistant);
			manager.appendUsage("cache_warm", model.provider, model.id, assistant.usage);
		});
		try {
			expect(fixture.providerCalls()).toBe(0);
			expect(fixture.session.cacheWarmingStatus).toEqual({
				state: "inactive",
				reason: "waiting for first request",
			});
		} finally {
			fixture.dispose();
		}
	});

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it.each([25, 0])("bounds a real SDK request using httpIdleTimeoutMs=%i and keeps provider timeout separate", async (idle) => {
		const model = createModel("openai-completions");
		const settingsManager = SettingsManager.inMemory({ httpIdleTimeoutMs: idle,
			retry: { provider: { timeoutMs: 9000 } } });
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "local" }));
		const registry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const pending = createAssistantMessageEventStream();
		const entered = Promise.withResolvers<SimpleStreamOptions | undefined>();
		registry.registerProvider(model.provider, { api: model.api, streamSimple: (_model, _context, options) => {
			entered.resolve(options);
			return pending;
		} });
		const { session } = await createAgentSession({ cwd, agentDir, model,
			modelRuntime: getModelRuntime(registry), settingsManager, resourceLoader,
			sessionManager: SessionManager.inMemory(cwd) });
		const caller = new AbortController();
		try {
			const stream = await session.agent.streamFunction(model, normalizeContext({ messages: [] }), { signal: caller.signal });
			const options = await entered.promise;
			expect(options?.timeoutMs).toBe(9000);
			expect(options).not.toHaveProperty("idleTimeoutMs");
			if (idle === 0) caller.abort();
			const result = await stream.result();
			expect(result.stopReason).toBe(idle === 0 ? "aborted" : "error");
			if (idle > 0) expect(result.errorMessage).toContain("idle timeout after 25ms");
			const events = [];
			for await (const event of stream) events.push(event);
			expect(events.at(-1)?.type).toBe("error");
			expect(options?.signal?.aborted).toBe(true);
		} finally {
			pending.end(createDoneMessage(model.api));
			session.dispose();
			registry.unregisterProvider(model.provider);
		}
	});

	it("uses the same idle setting in a Durable request and retries through its existing policy", async () => {
		const model = createModel("openai-completions");
		const manager = SettingsManager.inMemory({ httpIdleTimeoutMs: 100,
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { timeoutMs: 9000 } } });
		const pending = createAssistantMessageEventStream();
		pending.push({ type: "start", partial: { ...createDoneMessage(model.api),
			content: [{ type: "text", text: "stalled partial" }], stopReason: "pending" } });
		let calls = 0;
		const respond = (_model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) => {
			calls++;
			expect(options?.timeoutMs).toBe(9000);
			expect(options).not.toHaveProperty("idleTimeoutMs");
			return calls === 1 ? pending : createDoneStream(model.api);
		};
		const models = createModels();
		models.setProvider(createProvider({ id: model.provider, models: [model],
			auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
			api: { stream: respond, streamSimple: respond } }));
		const harness = await Harness.open(new MemoryStorage(), { models,
			settings: { ...createHarnessSettings(manager), progress: { partialIntervalMs: 1 } } }, BACKGROUND_CONTEXT);
		let publishedPartial = false;
		harness.subscribeCommits(publication => {
			for (const change of publication.changes) {
				if (change.type !== "document" || change.record.kind !== LiveDoc.kind || change.value === null) continue;
				const live = change.value as LiveState;
				publishedPartial ||= live.generation?.message?.content.some(block => block.type === "text"
					&& block.text === "stalled partial") === true;
			}
		});
		try {
			const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id } } });
			const submission = await root.submit({ type: "input", content: "test" }, BACKGROUND_CONTEXT);
			expect(await submission.wait(BACKGROUND_CONTEXT)).toMatchObject({ status: "done" });
			expect(calls).toBe(2);
			expect(publishedPartial).toBe(true);
			expect(await harness.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT)).toEqual({});
			const entries = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
			expect(entries.items.some(entry => entry.model?.some(message => message.role === "assistant"
				&& message.stopReason === "error" && message.errorMessage?.includes("idle timeout")))).toBe(true);
			pending.push({ type: "done", reason: "stop", message: fauxAssistantMessage("late") });
			await new Promise(resolve => setTimeout(resolve, 0));
			expect((await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items).toEqual(entries.items);
		} finally {
			pending.end(createDoneMessage(model.api));
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(3000);
	});

	// Regression test for #9784.
	it("forwards provider stream events to extensions", async () => {
		const providerEvent = { openrouter_metadata: { strategy: "direct" } };
		const extensionEvents: unknown[] = [];

		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{},
			(pi) => {
				pi.on("provider_stream_event", (event) => {
					extensionEvents.push(event);
				});
			},
			providerEvent,
		);

		expect(options?.onProviderStreamEvent).toEqual(expect.any(Function));
		expect(extensionEvents).toEqual([
			{
				data: providerEvent,
				type: "provider_stream_event",
				provider: "capture-provider",
				api: "openai-completions",
				model: "capture-model",
			},
		]);
	});

	it("runs before_provider_headers on assembled headers without forwarding the transform", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{ headers: { "x-explicit": "explicit" } },
			(pi) => {
				pi.on("before_provider_headers", (event) => {
					event.headers["x-hook"] = [
						event.headers["x-provider"],
						event.headers["x-model"],
						event.headers["x-explicit"],
					].join(":");
				});
			},
		);

		expect(options?.headers).toMatchObject({
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-hook": "provider:model:explicit",
		});
		expect(options).not.toHaveProperty("transformHeaders");
	});
});
