import { type Static, Type } from "typebox";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import { DEFAULT_MAX_LINES } from "../truncate.ts";
import { requireEnv } from "./env.ts";
import { resolveToolPath } from "../file-operations.ts";
import { runSearch, searchLimit, type SearchProgramOptions } from "./search-output.ts";

const schema = Type.Object({
	pattern: Type.String({ description: "Regex or literal search pattern" }),
	path: Type.Optional(Type.String({ description: "File or directory to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "File glob filter, for example *.ts" })),
	ignoreCase: Type.Optional(Type.Boolean()),
	literal: Type.Optional(Type.Boolean()),
	context: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "Lines before and after a match" })),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: DEFAULT_MAX_LINES,
			description: "Maximum output lines, including context (default: 100)",
		}),
	),
});
export type GrepToolInput = Static<typeof schema>;

/** Portable ripgrep execution through the selected environment; no host filesystem or shell interpolation. */
export function createGrepTool(
	options?: SearchProgramOptions,
): ToolRegistration<typeof schema, { truncated: boolean }> {
	return defineTool({
		name: "grep",
		description:
			"Search file contents with ripgrep. Respects .gitignore, includes hidden files, and reports paths and line numbers. Returns at most 100 output lines by default, including requested context, and 50KB; narrow searches when bounded.",
		parameters: schema,
		replay: "safe",
		async execute(input, api, context) {
			const limit = searchLimit(input.limit, 100);
			const surrounding = input.context ?? 0;
			if (!Number.isSafeInteger(surrounding) || surrounding < 0 || surrounding > 100)
				throw new Error("context must be an integer between 0 and 100");
			const path = await resolveToolPath(requireEnv(api), input.path ?? ".", context);
			const args = [
				"--line-number",
				"--with-filename",
				"--no-heading",
				"--color=never",
				"--hidden",
				"--max-columns=500",
				"--max-columns-preview",
			];
			if (input.ignoreCase) args.push("--ignore-case");
			if (input.literal) args.push("--fixed-strings");
			if (input.glob !== undefined) args.push("--glob", input.glob);
			if (surrounding > 0) args.push("--context", String(surrounding));
			args.push("--", input.pattern, path);
			return { details: await runSearch("rg", args, requireEnv(api).cwd, limit, options, api, context) };
		},
	});
}
