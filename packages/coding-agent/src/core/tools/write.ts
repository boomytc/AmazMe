import type { AgentTool } from "@amazme/agent";
import { getOrThrow } from "@amazme/durable/env";
import { observedWriteIntent } from "@amazme/durable/file-observations";
import { canonicalFilePath, resolveToolPath, withFileMutationQueue } from "@amazme/durable/file-operations";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { createFileRuntime, type FileToolOptions, observePublished, throwIfAborted } from "./file-runtime.ts";
import { writeRenderers } from "./renderers/write.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({
		description: "Path to the file to write (relative or absolute)",
	}),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: [
		"Use write only for new files or complete rewrites. Read existing files first; replacement requires the observed version to remain current.",
	],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

export type WriteToolOptions = FileToolOptions;

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	const runtime = createFileRuntime(cwd, options);
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates missing files and parent directories. Read an existing file first; replacement requires its observed path and version to remain current.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const { files, context, observations } = runtime(signal, ctx);
			throwIfAborted(context);
			const absolutePath = await resolveToolPath(files, path, context);
			return withFileMutationQueue(
				files,
				absolutePath,
				async () => {
					throwIfAborted(context);
					const target = await canonicalFilePath(files, absolutePath, context);
					const intent = observedWriteIntent(target, observations.get(files.id, target));
					const outcome = getOrThrow(await files.writeFileChecked(absolutePath, content, intent, context));
					const warning = await observePublished(observations, files.id, outcome);
					return {
						content: [{ type: "text", text: `Successfully wrote to ${path}${warning}` }],
						details: undefined,
					};
				},
				context,
			);
		},
		...writeRenderers,
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
