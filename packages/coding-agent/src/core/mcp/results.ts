/** Shared MCP names, schemas and bounded model results; scripts receive the full structured result. */
import { createHash } from "node:crypto";
import type { ImageContent, JsonValue, TextContent } from "@amazme/ai";
import {
	type CallToolResult,
	type ContentBlock,
	type McpRequestOptions,
	type Tool as McpTool,
	toLlmContent,
} from "@amazme/mcp";
import type { TSchema } from "typebox";
import type { ToolAnnotations, ToolExposure, ToolNamespace } from "../extensions/types.ts";
import { READ_MCP_RESOURCE_TOOL, type McpExposure } from "../mcp-servers.ts";
import { formatSize, truncateMiddle } from "../tools/truncate.ts";
import { writeOutputFile } from "../../utils/output-files.ts";

export interface McpToolResult {
	content: (TextContent | ImageContent)[];
	details: McpToolDetails;
	structuredContent: JsonValue;
	isError?: boolean;
}

/**
 * Tool exposure of an MCP exposure. `codemode` and `deferred` both leave tools out of the codemode
 * description; they differ only in which tool the MCP extension activates to reach them.
 */
export function toToolExposure(exposure: McpExposure): ToolExposure {
	return exposure === "codemode" ? "deferred" : exposure;
}

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;
/** Model-facing text of an MCP result beyond this is cut in the middle. */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;
/** Tool that reads the resources named by resource links. */
export { READ_MCP_RESOURCE_TOOL };

export interface McpToolDetails {
	server: string;
	tool: string;
	/** Temp file with the full text output, when the model-facing text was truncated. */
	fullOutputPath?: string;
}

/**
 * Saves the full text of a truncated result, or a binary resource, and returns the file path.
 * `extension` includes the dot, for example `.txt`.
 */
export type McpOutputSaver = (data: string | Uint8Array, extension: string) => Promise<string>;

export function saveToTempFile(data: string | Uint8Array, extension: string): Promise<string> {
	return writeOutputFile("amazme-mcp", extension, data);
}

export interface McpToolCaller {
	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult>;
}

/**
 * `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long. Like Codex,
 * everything but `[A-Za-z0-9_]` becomes `_`, so the name is also the identifier codemode scripts
 * call it by. `isTaken` reports names used by a different MCP tool: sanitizing can map two tools to
 * one name (`a-b` and `a_b`), which then get the hash suffix.
 */
export function createMcpToolName(
	server: string,
	tool: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Output schema of every MCP tool: the `CallToolResult` scripts receive, with the tool's own output
 * schema as `structuredContent`. Codemode detects this shape to render `CallToolResult<T>`
 * declarations.
 */
export function createMcpResultSchema(structuredContentSchema: Record<string, unknown> | undefined): TSchema {
	return {
		type: "object",
		properties: {
			content: { type: "array", items: { type: "object" } },
			...(structuredContentSchema ? { structuredContent: structuredContentSchema } : {}),
			isError: { type: "boolean" },
			_meta: { type: "object" },
		},
		required: ["content"],
	} as unknown as TSchema;
}

/**
 * Keep model-facing text within {@link MCP_OUTPUT_MAX_BYTES}. Longer text becomes one text block in
 * Codex's truncation format, followed by the path of the file with the full text; images follow it.
 */
export async function limitMcpContent(
	content: (TextContent | ImageContent)[],
	saveOutput: McpOutputSaver = saveToTempFile,
): Promise<{ content: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	const combined = textOf(content);
	const truncation = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES);
	if (!truncation.truncated) return { content };
	let fullOutputPath: string | undefined;
	let where: string;
	try {
		fullOutputPath = await saveOutput(combined, ".txt");
		where = `[Full output: ${fullOutputPath} (read it with offset/limit)]`;
	} catch (error) {
		where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
	}
	const tokens = Math.ceil(truncation.totalBytes / 4);
	const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n${where}`;
	return {
		content: [{ type: "text", text }, ...content.filter((block) => block.type === "image")],
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}

export interface ConvertMcpResultOptions {
	/** Saves truncated text and binary resources. Default: a temp file. */
	saveOutput?: McpOutputSaver;
	/** Whether the server's resources can be read with `read_mcp_resource`, which resource links then name. */
	readableResources?: boolean;
}

/** File extension for a saved binary resource: the one its URI ends in, else `.bin`. */
function extensionOf(uri: string): string {
	const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
	return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

/** Blobs of these types are shown as text. */
function isTextMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	const type = mimeType.split(";", 1)[0].trim().toLowerCase();
	return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml");
}

/** Model-facing content of one block of `server`'s result. */
async function blockToContent(
	server: string,
	block: ContentBlock,
	options: ConvertMcpResultOptions,
): Promise<(TextContent | ImageContent)[]> {
	if (block.type === "resource_link") {
		const details = [block.mimeType, block.size === undefined ? undefined : formatSize(block.size)].filter(Boolean);
		const read = options.readableResources ? `. Read it with ${READ_MCP_RESOURCE_TOOL} (server "${server}")` : "";
		const description = block.description ? `: ${block.description}` : "";
		return [
			{
				type: "text",
				text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}${read}]`,
			},
		];
	}
	if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
		const { uri, mimeType, blob } = block.resource;
		const data = Buffer.from(blob, "base64");
		if (isTextMimeType(mimeType)) return [{ type: "text", text: data.toString("utf8") }];
		const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;
		try {
			const path = await (options.saveOutput ?? saveToTempFile)(data, extensionOf(uri));
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) saved to ${path}]` }];
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) could not be saved: ${reason}]` }];
		}
	}
	return toLlmContent({ content: [block] });
}

/** Model-facing content of `server`'s content blocks, before the output limit. */
export async function toModelContent(
	server: string,
	blocks: readonly ContentBlock[],
	options: ConvertMcpResultOptions = {},
): Promise<(TextContent | ImageContent)[]> {
	return (await Promise.all(blocks.map((block) => blockToContent(server, block, options)))).flat();
}

/** Convert an MCP result. `isError` results become error results that keep the structured result. */
export async function convertMcpResult(
	server: string,
	tool: string,
	result: CallToolResult,
	options: ConvertMcpResultOptions = {},
): Promise<McpToolResult> {
	// Without content blocks, toLlmContent falls back to the structured content as JSON.
	const converted: (TextContent | ImageContent)[] =
		result.content.length > 0 ? await toModelContent(server, result.content, options) : toLlmContent(result);
	if (result.isError && textOf(converted) === "") {
		converted.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
	}
	const { content, fullOutputPath } = await limitMcpContent(converted, options.saveOutput);
	const { _meta: _ignored, ...scriptResult } = result;
	return {
		content,
		details: { server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
		structuredContent: scriptResult as unknown as JsonValue,
		...(result.isError ? { isError: true } : {}),
	};
}

/**
 * Tool input schemas must be objects. MCP servers may omit `type`, and some providers reject object
 * schemas without `properties`.
 */
export function toParameters(schema: Record<string, unknown>): TSchema {
	return {
		...schema,
		type: schema.type ?? "object",
		...(schema.properties === undefined ? { properties: {} } : {}),
	} as unknown as TSchema;
}

const ANNOTATION_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** The boolean hints of an MCP tool's annotations, or undefined when it has none. */
export function toToolAnnotations(tool: McpTool): ToolAnnotations | undefined {
	const annotations: ToolAnnotations = {};
	for (const hint of ANNOTATION_HINTS) {
		const value = tool.annotations?.[hint];
		if (typeof value === "boolean") annotations[hint] = value;
	}
	return Object.keys(annotations).length > 0 ? annotations : undefined;
}

/** One metadata projection for SDK and persistent tools. Annotation hints do not authorize execution or replay. */
export function createMcpToolMetadata(
	server: string,
	tool: McpTool,
	name: string,
	exposure: McpExposure,
	namespace: ToolNamespace,
) {
	const title = tool.title ?? tool.annotations?.title;
	const annotations = toToolAnnotations(tool);
	return {
		name,
		label: `${server}/${tool.name}`,
		description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
		parameters: toParameters(tool.inputSchema),
		outputSchema: createMcpResultSchema(tool.outputSchema),
		exposure: toToolExposure(exposure),
		namespace,
		...(annotations ? { annotations } : {}),
	};
}
