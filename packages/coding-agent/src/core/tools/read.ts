import type { AgentTool } from "@amazme/agent";
import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@amazme/ai";
import { FileError } from "@amazme/durable/env";
import { canonicalFilePath, resolveReadToolPath } from "@amazme/durable/file-operations";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { createFileRuntime, type FileToolOptions, readObservedBytes, throwIfAborted } from "./file-runtime.ts";
import { readRenderers } from "./renderers/read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({
		description: "Path to the file to read (relative or absolute)",
	}),
	offset: Type.Optional(
		Type.Number({
			description: "Line number to start reading from (1-indexed)",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

/**
 * Result for programmatic callers such as codemode scripts: the text for text files, and an image
 * block for images that codemode's `image()` accepts. `note` is the text that goes with the image,
 * such as resize hints. Property descriptions are left out so the type stays on one line in tool
 * descriptions.
 */
const readOutputSchema = Type.Union([
	Type.String(),
	Type.Object({
		type: Type.Literal("image"),
		data: Type.String(),
		mimeType: Type.String(),
		note: Type.String(),
	}),
]);

export type ReadToolOutput = Static<typeof readOutputSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

export interface ReadToolOptions extends FileToolOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
	/** Fallback resize profile when the execution context has no model metadata. */
	resizeOptions?: ModelImageResizeOptions;
}

/** The image block and its note, or the text for text files and images that could not be processed. */
function toReadOutput(content: (TextContent | ImageContent)[]): ReadToolOutput {
	const text = content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const image = content.find((block) => block.type === "image");
	return image ? { type: "image", data: image.data, mimeType: image.mimeType, note: text } : text;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const fallbackResizeOptions = options?.resizeOptions;
	const runtime = createFileRuntime(cwd, options, ["autoResizeImages", "resizeOptions"]);
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		outputSchema: readOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const { files, context, observations } = runtime(signal, ctx);
			throwIfAborted(context);
			const absolutePath = await resolveReadToolPath(files, path, context);
			let read: Awaited<ReturnType<typeof readObservedBytes>>;
			try {
				read = await readObservedBytes(files, absolutePath, context);
			} catch (error) {
				if (error instanceof FileError && error.code === "not_found")
					await observations.record(files.id, await canonicalFilePath(files, absolutePath, context), {
						kind: "absent",
					});
				throw error;
			}
			const mimeType = detectSupportedImageMimeType(read.buffer);
			let content: (TextContent | ImageContent)[];
			let readable = true;
			let details: ReadToolDetails | undefined;
			const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
			if (mimeType) {
				// Read image as binary.
				const buffer = read.buffer;
				const processed = await processImage(buffer, mimeType, {
					autoResizeImages,
					resizeOptions: ctx?.model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
				});
				if (!processed.ok) {
					readable = false;
					let textNote = `Read image file [${mimeType}]\n${processed.message}`;
					if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
					content = [{ type: "text", text: textNote }];
				} else {
					let textNote = `Read image file [${processed.mimeType}]`;
					if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
					if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
					content = [
						{ type: "text", text: textNote },
						{
							type: "image",
							data: processed.data,
							mimeType: processed.mimeType,
						},
					];
				}
			} else {
				// Read text content.
				const buffer = read.buffer;
				const textContent = buffer.toString("utf-8");
				const allLines = textContent.split("\n");
				const totalFileLines = allLines.length;
				// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
				const startLine = offset ? Math.max(0, offset - 1) : 0;
				const startLineDisplay = startLine + 1;
				// Check if offset is out of bounds.
				if (startLine >= allLines.length) {
					throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
				}
				let selectedContent: string;
				let userLimitedLines: number | undefined;
				// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
				if (limit !== undefined) {
					const endLine = Math.min(startLine + limit, allLines.length);
					selectedContent = allLines.slice(startLine, endLine).join("\n");
					userLimitedLines = endLine - startLine;
				} else {
					selectedContent = allLines.slice(startLine).join("\n");
				}
				// Apply truncation, respecting both line and byte limits.
				const truncation = truncateHead(selectedContent);
				let outputText: string;
				if (truncation.firstLineExceedsLimit) {
					// First line alone exceeds the byte limit. Point the model at a bash fallback.
					const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
					outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
					details = { truncation };
				} else if (truncation.truncated) {
					// Truncation occurred. Build an actionable continuation notice.
					const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
					const nextOffset = endLineDisplay + 1;
					outputText = truncation.content;
					if (truncation.truncatedBy === "lines") {
						outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
					} else {
						outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
					}
					details = { truncation };
				} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
					// User-specified limit stopped early, but the file still has more content.
					const remaining = allLines.length - (startLine + userLimitedLines);
					const nextOffset = startLine + userLimitedLines + 1;
					outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
				} else {
					// No truncation and no remaining user-limited content.
					outputText = truncation.content;
				}
				content = [{ type: "text", text: outputText }];
			}

			throwIfAborted(context);
			await observations.record(
				files.id,
				read.path,
				read.stable && readable ? { kind: "present", version: read.version } : undefined,
			);
			if (!read.stable)
				content.push({
					type: "text",
					text: "[File changed while it was read. Read a stable version before editing or replacing it.]",
				});
			return { content, details, structuredContent: toReadOutput(content) };
		},
		...readRenderers,
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
