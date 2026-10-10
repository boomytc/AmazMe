import { type Static, Type } from "typebox";
import { getOrThrow } from "../env/index.ts";
import { observedWriteIntent } from "../file-observations.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import { requireEnv } from "./env.ts";
import { canonicalFilePath, withFileMutationQueue } from "../file-operations.ts";
import { observeMutation, priorFileObservation } from "./file-observations.ts";
import { resolveToolPath } from "../file-operations.ts";
import { prepareWriteDiff, writeDiffNote } from "./write-diff.ts";
import type { WriteToolDetails } from "./write-diff.ts";

export type { WriteToolDetails } from "./write-diff.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export function createWriteTool(): ToolRegistration<typeof writeSchema, WriteToolDetails> {
	return defineTool({
		name: "write",
		description:
			"Write content to a file. Creates missing files and parent directories. Read an existing file first; replacement requires the observed path and version to remain current.",
		parameters: writeSchema,
		async execute(args, api, context) {
			const { path, content } = args;
			const env = requireEnv(api);
			const absolutePath = await resolveToolPath(env, path, context);
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					const target = await canonicalFilePath(env, absolutePath, context);
					const intent = observedWriteIntent(target, await priorFileObservation(api, env.id, target, context));
					const details = await prepareWriteDiff(env, absolutePath, path, content, intent, context);
					context.abortSignal?.throwIfAborted();
					const outcome = getOrThrow(await env.writeFileChecked(absolutePath, content, intent, context));
					await observeMutation(api, env.id, outcome);
					return {
						output: [
							{
								type: "text",
								text: `Successfully wrote to ${path}${writeDiffNote(details)}`,
							},
						],
						details,
					};
				},
				context,
			);
		},
	});
}
