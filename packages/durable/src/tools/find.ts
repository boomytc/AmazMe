import { type Static, Type } from "typebox";
import { withoutAbortSignal } from "@amazme/chord/context";
import { getOrThrow } from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import { DEFAULT_MAX_LINES } from "../truncate.ts";
import { requireEnv } from "./env.ts";
import { resolveToolPath } from "../file-operations.ts";
import { insideRepository, runSearch, searchLimit, type SearchProgramOptions } from "./search-output.ts";

const schema = Type.Object({
	pattern: Type.String({ description: "Glob pattern, for example *.ts or src/**/*.test.ts" }),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_LINES, description: "Maximum result paths (default: 1000)" }),
	),
});
export type FindToolInput = Static<typeof schema>;

export function createFindTool(
	options?: SearchProgramOptions,
): ToolRegistration<typeof schema, { truncated: boolean }> {
	return defineTool({
		name: "find",
		description:
			"Find file and directory paths matching a glob with fd. Includes hidden paths and respects ignore files; excludes .git and node_modules. Returns relative paths, bounded to 1000 lines by default and 50KB.",
		parameters: schema,
		replay: "safe",
		async execute(input, api, context) {
			const limit = searchLimit(input.limit, 1000);
			const env = requireEnv(api);
			const path = await resolveToolPath(env, input.path ?? ".", context);
			const directory = getOrThrow(await env.openDirReader(path, context));
			await directory.close(withoutAbortSignal(context));
			const args = ["--glob", "--color=never", "--hidden", "--exclude", ".git", "--exclude", "node_modules"];
			if (!(await insideRepository(path, api, context))) args.push("--no-require-git");
			let pattern = input.pattern;
			if (pattern.includes("/")) {
				args.push("--full-path");
				if (!pattern.startsWith("/") && !pattern.startsWith("**/")) pattern = `**/${pattern}`;
				if (getOrThrow(await env.joinPath(["a", "b"], context)).includes("\\")) pattern = pattern.replaceAll("/", "\\");
			}
			args.push("--", pattern, ".");
			return { details: await runSearch("fd", args, path, limit, options, api, context) };
		},
	});
}
