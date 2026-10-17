import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@amazme/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createDurableRpcHandler } from "../src/modes/rpc/durable-rpc.ts";
import { openDurable, type OpenDurableResult } from "../src/durable/runtime.ts";
import { pendingResponse } from "./experimental-durable-support.ts";

describe("durable RPC handler", () => {
	let directory: string;
	let cwd: string;
	let profile: string;
	let runtime: ModelRuntime;
	let settings: SettingsManager;
	let faux: ReturnType<typeof fauxProvider>;
	let durable: OpenDurableResult;
	let handle: ReturnType<typeof createDurableRpcHandler>;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "amazme-durable-rpc-"));
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
		durable = await openDurable({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			noSession: true,
			noExtensions: true,
			noMcp: true,
		});
		handle = createDurableRpcHandler(durable);
	});

	afterEach(async () => {
		await durable.close();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("reports state, prompts, and reads the committed transcript", async () => {
		faux.setResponses([fauxAssistantMessage("rpc answer"), fauxAssistantMessage("compact summary")]);
		const state = await handle({ type: "get_state" });
		expect(state).toMatchObject({
			type: "response",
			command: "get_state",
			success: true,
			data: { sessionId: expect.any(String), thinkingLevel: "high", messageCount: 0, pendingMessageCount: 0 },
		});

		const prompted = await handle({ type: "prompt", message: "hello" });
		expect(prompted).toMatchObject({ type: "response", command: "prompt", success: true, data: { disposition: "started" } });

		await vi.waitFor(() => {
			expect(durable.view.current().conversation.entries.some((entry) => entry.kind === "amazme.assistant")).toBe(true);
		});
		const text = await handle({ type: "get_last_assistant_text" });
		expect(text).toMatchObject({ success: true, data: { text: "rpc answer" } });
		const messages = await handle({ type: "get_messages" });
		expect(messages.success).toBe(true);
		if (messages.success && messages.command === "get_messages") {
			expect(messages.data.messages.some((message) => message.role === "assistant")).toBe(true);
		}

		const entries = await handle({ type: "get_entries" });
		expect(entries).toMatchObject({ success: true, command: "get_entries" });
		if (entries.success && entries.command === "get_entries") {
			expect(entries.data.entries.length).toBeGreaterThan(0);
			expect(entries.data.leafId).toBe(entries.data.entries.at(-1)?.id);
		}
		const tree = await handle({ type: "get_tree" });
		expect(tree).toMatchObject({ success: true, command: "get_tree" });
		if (tree.success && tree.command === "get_tree") expect(tree.data.tree).toHaveLength(1);
		const forkMessages = await handle({ type: "get_fork_messages" });
		expect(forkMessages).toMatchObject({ success: true, command: "get_fork_messages" });
		if (forkMessages.success && forkMessages.command === "get_fork_messages") {
			expect(forkMessages.data.messages.some((message) => message.text === "hello")).toBe(true);
		}

		const compacted = await handle({ type: "compact" });
		expect(compacted).toMatchObject({ success: true, command: "compact" });

		const output = join(directory, "rpc-export.html");
		const exported = await handle({ type: "export_html", outputPath: output });
		expect(exported).toMatchObject({ success: true, command: "export_html", data: { path: output } });
		expect(await readFile(output, "utf8")).toContain("<!DOCTYPE html>");
	});

	it("clears queued follow-ups and forks the current conversation", async () => {
		const pending = pendingResponse();
		faux.setResponses([pending.step]);
		await handle({ type: "prompt", message: "start" });
		await vi.waitFor(() => expect(durable.view.current().lane.run).not.toBe("idle"));
		await handle({ type: "follow_up", message: "queued one" });
		await handle({ type: "follow_up", message: "queued two" });
		const cleared = await handle({ type: "clear_queue" });
		expect(cleared).toMatchObject({ success: true, command: "clear_queue", data: { steering: [], followUp: ["queued one", "queued two"] } });
		await handle({ type: "abort" });

		const forkMessages = await handle({ type: "get_fork_messages" });
		if (!forkMessages.success || forkMessages.command !== "get_fork_messages") throw new Error("expected fork messages");
		const firstUser = forkMessages.data.messages[0];
		if (firstUser === undefined) throw new Error("expected a user message");
		const forked = await handle({ type: "fork", entryId: firstUser.entryId });
		expect(forked).toMatchObject({ success: true, command: "fork", data: { text: "start", cancelled: false } });
	});

	it("reports the Durable database as the session file", async () => {
		const persistent = await openDurable({
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			sessionDir: join(directory, "sessions"),
			noExtensions: true,
			noMcp: true,
		});
		try {
			const persistentHandler = createDurableRpcHandler(persistent);
			const state = await persistentHandler({ type: "get_state" });
			expect(state).toMatchObject({ success: true, data: { sessionFile: expect.stringMatching(/session\.sqlite$/) } });
			const stats = await persistentHandler({ type: "get_session_stats" });
			expect(stats).toMatchObject({ success: true, data: { sessionFile: expect.stringMatching(/session\.sqlite$/) } });
		} finally {
			await persistent.close();
		}
	});

	it("delegates session lifecycle to the transport", async () => {
		const control = {
			newSession: vi.fn(async () => ({ cancelled: false })),
			switchSession: vi.fn(async () => ({ cancelled: false })),
		};
		const controlled = createDurableRpcHandler(durable, control);
		expect(await controlled({ type: "new_session" })).toMatchObject({ success: true, command: "new_session", data: { cancelled: false } });
		expect(await controlled({ type: "switch_session", sessionPath: "/tmp/session" })).toMatchObject({ success: true, command: "switch_session", data: { cancelled: false } });
		expect(control.newSession).toHaveBeenCalledWith(undefined);
		expect(control.switchSession).toHaveBeenCalledWith("/tmp/session");
	});

	it("selects models by full identity and reports unsupported commands", async () => {
		const models = await handle({ type: "get_available_models" });
		expect(models).toMatchObject({ success: true, command: "get_available_models" });

		const invalid = await handle({ type: "set_model", provider: "missing", modelId: "missing" });
		expect(invalid).toMatchObject({ success: false, error: expect.stringContaining("Model not found") });

		const renamed = await handle({ type: "set_session_name", name: "renamed" });
		expect(renamed.success).toBe(true);
		expect(durable.view.current().session.name).toBe("renamed");

		const steering = await handle({ type: "set_steering_mode", mode: "all" });
		expect(steering.success).toBe(true);
		const state = await handle({ type: "get_state" });
		expect(state).toMatchObject({ success: true, data: { steeringMode: "all" } });

		const bash = await handle({ type: "bash", command: "printf hi" });
		expect(bash).toMatchObject({ success: true, command: "bash", data: { output: "hi", exitCode: 0 } });
		expect((await handle({ type: "abort_bash" })).success).toBe(true);
	});
});
