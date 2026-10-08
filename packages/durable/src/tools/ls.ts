import { withoutAbortSignal } from "@amazme/chord/context";
import { type Static, Type } from "typebox";
import { getOrThrow } from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import { DEFAULT_MAX_LINES, truncateHead } from "../truncate.ts";
import { requireEnv } from "./env.ts";
import { resolveToolPath } from "../file-operations.ts";
import { searchLimit } from "./search-output.ts";

const schema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_LINES, description: "Maximum entries (default: 500)" }),
	),
});
export type LsToolInput = Static<typeof schema>;

export function createLsTool(): ToolRegistration<typeof schema, { truncated: boolean }> {
	return defineTool({
		name: "ls",
		description:
			"List directory entries alphabetically, including hidden files. Directories end in /. Keeps at most 500 entries by default and 50KB.",
		parameters: schema,
		replay: "safe",
		async execute(input, api, context) {
			const limit = searchLimit(input.limit, 500);
			const env = requireEnv(api);
			const path = await resolveToolPath(env, input.path ?? ".", context);
			const reader = getOrThrow(await env.openDirReader(path, context));
			const selected: string[] = [];
			let count = 0;
			try {
				for (;;) {
					const page = getOrThrow(await reader.next(256, context));
					for (const entry of page.entries) {
						const name = entry.name + (entry.kind === "directory" ? "/" : "");
						count++;
						let low = 0,
							high = selected.length;
						while (low < high) {
							const mid = (low + high) >>> 1;
							if (selected[mid]! < name) low = mid + 1;
							else high = mid;
						}
						if (low < limit) {
							selected.splice(low, 0, name);
							if (selected.length > limit) selected.pop();
						}
					}
					if (page.done) break;
				}
			} finally {
				await reader.close(withoutAbortSignal(context));
			}
			const bounded = truncateHead(selected.join("\n"), { maxLines: limit });
			const truncated = count > limit || bounded.truncated;
			if (truncated)
				api.diagnostic({
					severity: "info",
					code: "result_limit",
					message: `Listing bounded: ${count} entries exist; narrow the path or increase limit.`,
				});
			return { content: [{ type: "text", text: bounded.content || "Directory is empty" }], details: { truncated } };
		},
	});
}
