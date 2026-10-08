import type { Context } from "@amazme/chord";
import { awaitWithContext, withCancel } from "@amazme/chord/context";
import { getOrThrow } from "../env/index.ts";
import { boundOutput } from "../harness/output.ts";
import type { ToolExecutionApi } from "../harness/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../truncate.ts";
import { requireEnv } from "./env.ts";

export interface SearchProgramOptions {
	/** A program in the execution environment, or a host resolver for that environment. */
	readonly program?: string | ((api: ToolExecutionApi, context: Context) => Promise<string>);
}

export function searchLimit(value: number | undefined, fallback: number): number {
	const limit = value ?? fallback;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_MAX_LINES) {
		throw new Error(`limit must be an integer between 1 and ${DEFAULT_MAX_LINES}`);
	}
	return limit;
}

/** Streams a bounded head and cancels only this search when it fills; stderr stays separate from result rows. */
export async function runSearch(
	defaultProgram: string,
	args: readonly string[],
	cwd: string,
	limit: number,
	options: SearchProgramOptions | undefined,
	api: ToolExecutionApi,
	context: Context,
): Promise<{ truncated: boolean }> {
	context.abortSignal?.throwIfAborted();
	const program =
		typeof options?.program === "function"
			? await awaitWithContext(options.program(api, context), context)
			: (options?.program ?? defaultProgram);
	context.abortSignal?.throwIfAborted();
	const child = withCancel(context);
	let bytes = 0;
	let lines = 0;
	let stopped = false;
	let errorText = "";
	const result = await requireEnv(api).exec(
		[program, ...args],
		{
			cwd,
			timeout: 30,
			onOutput: (text, _context, info) => {
				if (info.stream === "stderr") {
					errorText = boundOutput(errorText + text.slice(0, 4096), {
						maxBytes: 4096,
						maxLines: 20,
						retain: "head",
					}).text;
					return;
				}
				if (stopped) return;
				// Bound the temporary input too, before encoding a possibly large environment chunk.
				const remaining = DEFAULT_MAX_BYTES - bytes;
				const slice = boundOutput(text.slice(0, remaining + 1), {
					maxBytes: remaining,
					maxLines: limit - lines,
					retain: "head",
				});
				bytes += slice.bytes;
				for (const character of slice.text) if (character === "\n") lines++;
				if (slice.text.length > 0) api.output(slice.text);
				if (slice.text.length < text.length || bytes >= DEFAULT_MAX_BYTES || lines >= limit) {
					stopped = true;
					child.cancel();
				}
			},
		},
		child.context,
	);
	context.abortSignal?.throwIfAborted();
	if (!result.ok && !(stopped && result.error.code === "aborted")) throw result.error;
	if (result.ok && result.value.exitCode !== 0 && !(defaultProgram === "rg" && result.value.exitCode === 1)) {
		throw new Error(errorText.trim() || `${defaultProgram} exited with code ${result.value.exitCode}`);
	}
	if (stopped)
		api.diagnostic({
			severity: "info",
			code: "result_limit",
			message: `Search stopped at ${limit} output lines or ${DEFAULT_MAX_BYTES} bytes. Narrow the search to see more.`,
		});
	if (bytes === 0) api.output("No results found");
	return { truncated: stopped };
}

/** Keep ignore files outside repositories without extending parent-repository rules through nested repositories. */
export async function insideRepository(path: string, api: ToolExecutionApi, context: Context): Promise<boolean> {
	const env = requireEnv(api);
	let current = getOrThrow(await env.canonicalPath(path, context));
	for (;;) {
		if (getOrThrow(await env.exists(getOrThrow(await env.joinPath([current, ".git"], context)), context))) return true;
		const parent = getOrThrow(
			await env.absolutePath(getOrThrow(await env.joinPath([current, ".."], context)), context),
		);
		if (parent === current) return false;
		current = parent;
	}
}
