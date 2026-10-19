import { crc32, deflateSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@amazme/ai";
import { BACKGROUND_CONTEXT as context } from "@amazme/chord/context";
import { AgentDoc, defineExtension, defineTool, Harness, ToolResultEntry } from "@amazme/durable";
import type { HookApi, ToolExecutionResult, ToolHookCall, ToolHooks } from "@amazme/durable";
import type { NestedToolExecutionResult } from "@amazme/durable";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createCodingRegistry } from "../src/durable/harness-setup.ts";
import type { ToolResultContent } from "../src/utils/tool-result-images.ts";
import { normalizeToolResultImages } from "../src/utils/tool-result-images.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function pngChunk(type: string, body: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(body.length, 0);
	header.write(type, 4, "ascii");
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])), 0);
	return Buffer.concat([header, body, checksum]);
}

/** Build an 8-bit grayscale PNG of arbitrary dimensions without pulling in an encoder. */
function createPng(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // color type: grayscale
	const raw = Buffer.alloc((width + 1) * height);
	for (let row = 0; row < height; row++) {
		raw.fill(row % 256, row * (width + 1) + 1, (row + 1) * (width + 1));
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function readPngDimensions(base64Data: string): { width: number; height: number } {
	const buffer = Buffer.from(base64Data, "base64");
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function createTinyBmp1x1Red24bpp(): Buffer {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(0, 30);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return buffer;
}

function imageBlock(bytes: Buffer, mimeType: string): ToolResultContent {
	return { type: "image", data: bytes.toString("base64"), mimeType };
}

describe("normalizeToolResultImages", () => {
	it("returns the original array when there are no image blocks", async () => {
		const content: ToolResultContent[] = [{ type: "text", text: "no images here" }];

		expect(await normalizeToolResultImages(content)).toBe(content);
	});

	it("returns the original array when images are already within limits", async () => {
		const content: ToolResultContent[] = [
			{ type: "text", text: "screenshot" },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
		];

		expect(await normalizeToolResultImages(content)).toBe(content);
	});

	it("resizes oversized images and reports the original dimensions", async () => {
		const content: ToolResultContent[] = [imageBlock(createPng(2400, 4800), "image/png")];

		const normalized = await normalizeToolResultImages(content);

		expect(normalized).not.toBe(content);
		expect(normalized).toHaveLength(2);
		const image = normalized[0];
		expect(image.type).toBe("image");
		if (image.type !== "image") return;
		const { width, height } = readPngDimensions(image.data);
		expect(width).toBeLessThanOrEqual(2000);
		expect(height).toBeLessThanOrEqual(2000);
		const note = normalized[1];
		expect(note.type).toBe("text");
		if (note.type !== "text") return;
		expect(note.text).toContain("original 2400x4800");
	});

	it("leaves oversized images alone when auto-resize is disabled", async () => {
		const content: ToolResultContent[] = [imageBlock(createPng(2400, 4800), "image/png")];

		const normalized = await normalizeToolResultImages(content, { autoResizeImages: false });

		expect(normalized).toBe(content);
	});

	it("converts unsupported image formats even when auto-resize is disabled", async () => {
		const content: ToolResultContent[] = [imageBlock(createTinyBmp1x1Red24bpp(), "image/bmp")];

		const normalized = await normalizeToolResultImages(content, { autoResizeImages: false });

		expect(normalized).not.toBe(content);
		expect(normalized[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(normalized[1]).toMatchObject({
			type: "text",
			text: "[Image converted from image/bmp to image/png.]",
		});
	});

	it("keeps undecodable images instead of dropping tool output", async () => {
		const content: ToolResultContent[] = [{ type: "image", data: "bm90LWFuLWltYWdl", mimeType: "image/png" }];

		expect(await normalizeToolResultImages(content)).toBe(content);
	});

	it("preserves surrounding text blocks and their order", async () => {
		const content: ToolResultContent[] = [
			{ type: "text", text: "before" },
			imageBlock(createPng(2400, 100), "image/png"),
			{ type: "text", text: "after" },
		];

		const normalized = await normalizeToolResultImages(content);

		expect(normalized.map((block) => block.type)).toEqual(["text", "image", "text", "text"]);
		expect(normalized[0]).toEqual({ type: "text", text: "before" });
		expect(normalized[3]).toEqual({ type: "text", text: "after" });
	});
});

describe("coding registry tool-result image hook", () => {
	const call: ToolHookCall = { type: "toolCall", id: "shot", name: "screenshot", arguments: {} };

	function afterTool(
		autoResize: boolean,
		resize: { maxWidth: number; maxHeight: number; maxBytes: number },
		target: ToolHookCall = call,
	) {
		const settings = {
			getImageAutoResize: () => autoResize,
			getSettings: () => ({}),
		} as SettingsManager;
		const resources = {
			getSystemPrompt: () => "",
			getAppendSystemPrompt: () => [],
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSkills: () => ({ skills: [] }),
		} as unknown as ResourceLoader;
		const extension = createCodingRegistry(settings, "/tmp", resources).snapshot().extension("tool-result-images");
		const handlers = extension?.hooks?.[0]?.handlers as Partial<ToolHooks> | undefined;
		const hook = handlers?.afterTool;
		if (hook === undefined) throw new Error("coding registry does not normalize tool-result images");
		const api = {
			agent: async () => ({ model: { provider: "test", modelId: "vision" } }),
			models: {
				getModel: () => ({ inputLimits: { images: { resize } } }),
			},
		} as unknown as HookApi;
		return (result: ToolExecutionResult) => hook(target, result, api, context);
	}

	it("resizes a model-visible tool image to the conversation model limits", async () => {
		const content = [imageBlock(createPng(2400, 4800), "image/png")];
		const changed = await afterTool(true, { maxWidth: 800, maxHeight: 800, maxBytes: 5_000_000 })({
			output: content,
		});
		expect(changed?.output).not.toBe(content);
		const image = changed?.output?.[0];
		expect(image?.type).toBe("image");
		if (image?.type !== "image") return;
		const { width, height } = readPngDimensions(image.data);
		expect(width).toBeLessThanOrEqual(800);
		expect(height).toBeLessThanOrEqual(800);
	});

	it("keeps the original result when auto-resize is off and there is nothing to convert", async () => {
		const content = [imageBlock(createPng(2400, 4800), "image/png")];
		const changed = await afterTool(false, { maxWidth: 800, maxHeight: 800, maxBytes: 5_000_000 })({
			output: content,
		});
		expect(changed).toBeUndefined();
	});

	it("does not rewrite images from a nested tool call", async () => {
		const content = [imageBlock(createPng(2400, 4800), "image/png")];
		const nested = { ...call, parent: { taskId: "parent-task", callId: "parent" } } as ToolHookCall;
		const changed = await afterTool(
			true,
			{ maxWidth: 800, maxHeight: 800, maxBytes: 5_000_000 },
			nested,
		)({
			output: content,
		});
		expect(changed).toBeUndefined();
	});

	it("persists resized images and reuses them after SQLite reopen while nested callers receive originals", async () => {
		const directory = await mkdtemp(join(tmpdir(), "amazme-tool-images-"));
		const database = join(directory, "session.sqlite");
		const settings = SettingsManager.inMemory({ images: { autoResize: true } });
		const resources = {
			getSystemPrompt: () => "",
			getAppendSystemPrompt: () => [],
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSkills: () => ({ skills: [] }),
		} as unknown as ResourceLoader;
		const registry = createCodingRegistry(
			settings,
			directory,
			resources,
			async () => [directory],
			join(directory, "artifacts"),
		);
		const original = [imageBlock(createPng(2400, 4800), "image/png")];
		let nested: NestedToolExecutionResult | undefined;
		registry.install(
			defineExtension({
				name: "image-fixture",
				tools: [
					defineTool({
						name: "capture",
						description: "Return a large image",
						parameters: Type.Object({}),
						execute: async () => ({ output: original }),
					}),
					defineTool({
						name: "forward",
						description: "Inspect and forward a nested image",
						parameters: Type.Object({}),
						async execute(_args, api, callContext) {
							nested = await api.executeTool("capture", {}, callContext);
							return { output: original };
						},
					}),
				],
			}),
		);
		const faux = fauxProvider({
			models: [
				{
					id: "vision",
					input: ["text", "image"],
					inputLimits: { images: { resize: { maxWidth: 800, maxHeight: 800, maxBytes: 5_000_000 } } },
				},
			],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		const requests: Array<{ width: number; height: number }[]> = [];
		const inspect = (messages: Parameters<typeof models.streamSimple>[1]["messages"]): void => {
			requests.push(
				messages.flatMap((message) =>
					message.role === "toolResult"
						? message.content.flatMap((block) => (block.type === "image" ? [readPngDimensions(block.data)] : []))
						: [],
				),
			);
		};
		const options = { models, registry, env: () => new NodeExecutionEnv({ cwd: directory }) };
		let harness: Harness | undefined;
		try {
			harness = await Harness.open(await openNodeSqliteStorage(database), options, context);
			const root = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "vision" }, cwd: directory },
				init: async (tx, id) => {
					(await tx.doc(AgentDoc, id)).tools = { only: ["capture", "forward"] };
				},
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("capture", {}, { id: "direct" })], { stopReason: "toolUse" }),
				(request) => {
					inspect(request.messages);
					return fauxAssistantMessage([fauxToolCall("forward", {}, { id: "parent" })], { stopReason: "toolUse" });
				},
				(request) => {
					inspect(request.messages);
					return fauxAssistantMessage("done");
				},
			]);
			expect(
				await (await root.submit({ type: "input", content: "capture and forward" }, context)).wait(context),
			).toMatchObject({ status: "done" });
			const results = (await root.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is);
			expect(results).toHaveLength(2);
			for (const entry of results) {
				const message = entry.model?.[0];
				if (message?.role !== "toolResult") throw new Error("expected a persisted tool result");
				const image = message.content.find((block) => block.type === "image");
				if (image?.type !== "image") throw new Error("expected a persisted image");
				expect(readPngDimensions(image.data)).toEqual({ width: 400, height: 800 });
			}
			expect(nested?.structuredOutput).toEqual(original[0]);
			expect(requests).toEqual([
				[{ width: 400, height: 800 }],
				[
					{ width: 400, height: 800 },
					{ width: 400, height: 800 },
				],
			]);
			await harness.close(context);
			harness = await Harness.open(await openNodeSqliteStorage(database), options, context);
			const restored = await harness.root(context);
			faux.setResponses([
				(request) => {
					inspect(request.messages);
					return fauxAssistantMessage("restored");
				},
			]);
			expect(
				await (await restored.submit({ type: "input", content: "after reopen" }, context)).wait(context),
			).toMatchObject({ status: "done" });
			expect(requests.at(-1)).toEqual([
				{ width: 400, height: 800 },
				{ width: 400, height: 800 },
			]);
		} finally {
			await harness?.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps structured output when resizing a model-visible image", async () => {
		const directory = await mkdtemp(join(tmpdir(), "amazme-tool-images-"));
		const database = join(directory, "session.sqlite");
		const settings = SettingsManager.inMemory({ images: { autoResize: true } });
		const resources = {
			getSystemPrompt: () => "",
			getAppendSystemPrompt: () => [],
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSkills: () => ({ skills: [] }),
		} as unknown as ResourceLoader;
		const registry = createCodingRegistry(
			settings,
			directory,
			resources,
			async () => [directory],
			join(directory, "artifacts"),
		);
		const original = [imageBlock(createPng(2400, 4800), "image/png")];
		let nested: NestedToolExecutionResult | undefined;
		registry.install(
			defineExtension({
				name: "labeled-image-fixture",
				tools: [
					defineTool({
						name: "capture",
						description: "Return a large image and a label",
						parameters: Type.Object({}),
						structuredOutputSchema: Type.Object({ label: Type.String() }),
						execute: async () => ({ output: original, structuredOutput: { label: "shot" } }),
					}),
					defineTool({
						name: "forward",
						description: "Forward a nested image with its own label",
						parameters: Type.Object({}),
						structuredOutputSchema: Type.Object({ label: Type.String() }),
						async execute(_args, api, callContext) {
							nested = await api.executeTool("capture", {}, callContext);
							return { output: original, structuredOutput: { label: "forwarded" } };
						},
					}),
				],
			}),
		);
		const faux = fauxProvider({
			models: [
				{
					id: "vision",
					input: ["text", "image"],
					inputLimits: { images: { resize: { maxWidth: 800, maxHeight: 800, maxBytes: 5_000_000 } } },
				},
			],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		const reports: string[] = [];
		let harness: Harness | undefined;
		try {
			harness = await Harness.open(
				await openNodeSqliteStorage(database),
				{
					models,
					registry,
					env: () => new NodeExecutionEnv({ cwd: directory }),
					onReport: (error: unknown) => reports.push(error instanceof Error ? error.message : String(error)),
				},
				context,
			);
			const root = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "vision" }, cwd: directory },
				init: async (tx, id) => {
					(await tx.doc(AgentDoc, id)).tools = { only: ["capture", "forward"] };
				},
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("forward", {}, { id: "parent" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			expect(
				await (await root.submit({ type: "input", content: "forward the shot" }, context)).wait(context),
			).toMatchObject({ status: "done" });
			expect(reports).toEqual([]);
			expect(nested).toMatchObject({ isError: false, structuredOutput: { label: "shot" } });
			const persisted = (await root.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is);
			expect(persisted).toHaveLength(1);
			const message = persisted[0]?.model?.[0];
			if (message?.role !== "toolResult") throw new Error("expected a persisted tool result");
			expect(message.isError).toBe(false);
			const image = message.content.find((block) => block.type === "image");
			if (image?.type !== "image") throw new Error("expected a persisted image");
			expect(readPngDimensions(image.data)).toEqual({ width: 400, height: 800 });
		} finally {
			await harness?.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
