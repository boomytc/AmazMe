import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@amazme/ai";
import { BACKGROUND_CONTEXT as context } from "@amazme/chord/context";
import {
	AgentDoc,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	type NestedToolExecutionResult,
	ToolResultEntry,
} from "@amazme/durable";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
import { type CallToolResult, LATEST_PROTOCOL_VERSION } from "@amazme/mcp";
import { createInMemoryTransportPair } from "@amazme/mcp/testing";
import { expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openDurableMcp, type DurableMcp } from "../src/durable/mcp.ts";
import * as mcpRuntime from "../src/extensions/mcp/runtime.ts";

it("projects invalid images through the actual Durable MCP connection while preserving nested results", async () => {
	const directory = await mkdtemp(join(tmpdir(), "amazme-durable-mcp-images-"));
	const pair = createInMemoryTransportPair();
	const remote: CallToolResult = {
		content: [
			{ type: "text", text: "before" },
			{ type: "image", data: "AB==", mimeType: "image/png" },
			{ type: "resource", resource: { uri: "images://shot", mimeType: "image/png", blob: "AQ==\n" } },
			{ type: "text", text: "after" },
		],
		structuredContent: { captured: true },
	};
	const calls: string[] = [];
	const toolName = "mcp__images__shot";
	let mcp: DurableMcp | undefined;
	let harness: Harness | undefined;
	let received: NestedToolExecutionResult | undefined;
	const transport = vi.spyOn(mcpRuntime, "createDefaultTransport").mockImplementation(() => pair.client);
	vi.stubEnv("AMAZME_CODING_AGENT_DIR", directory);
	try {
		pair.server.onMessage((request) => {
			if (!("id" in request) || !("method" in request)) return;
			let result: unknown = {};
			if (request.method === "initialize") {
				result = {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "images", version: "1" },
				};
			} else if (request.method === "tools/list") {
				result = { tools: [{ name: "shot", inputSchema: { type: "object", properties: {} } }] };
			} else if (request.method === "tools/call") {
				calls.push("shot");
				result = remote;
			}
			void pair.server.send({ jsonrpc: "2.0", id: request.id, result });
		});
		await pair.server.start();
		await writeFile(join(directory, "mcp.json"), JSON.stringify({
			mcpServers: { images: { url: "http://unused.invalid", exposure: "direct" } },
		}));
		const models = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false,
		});
		const registry = createRegistry();
		const errors: unknown[] = [];
		mcp = await openDurableMcp({
			registry, cwd: directory, settings: SettingsManager.inMemory(), models,
			report: (error) => errors.push(error),
		});
		expect(errors).toEqual([]);
		registry.install(defineExtension({ name: "probe", tools: [defineTool({
			name: "probe",
			description: "Inspect the raw MCP result from a nested tool call",
			parameters: Type.Object({}),
			async execute(_args, api, callContext) {
				received = await api.executeTool(toolName, {}, callContext);
				return { output: [{ type: "text", text: "inspected" }] };
			},
		})] }));
		const faux = fauxProvider();
		const chatModels = createModels();
		chatModels.setProvider(faux.provider);
		harness = await Harness.open(new MemoryStorage(), {
			models: chatModels, registry, env: () => new NodeExecutionEnv({ cwd: directory, artifactDirectory: directory }),
		}, context);
		const root = await harness.root(context, {
			agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory },
			init: async (tx, id) => { (await tx.doc(AgentDoc, id)).tools = { only: [toolName, "probe"] }; },
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(toolName, {}, { id: "direct" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("probe", {}, { id: "nested" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const settled = await (await root.submit({ type: "input", content: "inspect" }, context)).wait(context);

		expect(settled.status).toBe("done");
		const entries = (await root.entries({}, 100, undefined, context)).items;
		const direct = entries.filter(ToolResultEntry.is).find((entry) =>
			entry.model?.[0]?.role === "toolResult" && entry.model[0].toolCallId === "direct")?.model?.[0];
		const omitted = { type: "text", text: "[MCP image from images omitted: image data is not canonical base64.]" };
		expect(direct).toMatchObject({ role: "toolResult", isError: false, content: [
			{ type: "text", text: "before" }, omitted, omitted, { type: "text", text: "after" },
		] });
		expect(received).toMatchObject({ isError: false, structuredOutput: remote });
		expect(calls).toEqual(["shot", "shot"]);
	} finally {
		try {
			await harness?.close(context);
		} finally {
			try {
				await mcp?.close();
			} finally {
				await pair.server.close();
				transport.mockRestore();
				vi.unstubAllEnvs();
				await rm(directory, { recursive: true, force: true });
			}
		}
	}
});
