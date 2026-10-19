/**
 * The `codemode` tool: the model writes JavaScript that calls other tools. Scripts use `tools`,
 * `ALL_TOOLS`, `text()`, `image()`, `exit()`, `store()`/`load()`, `console.*`, and `return <value>`,
 * may start with a `// @options:` line, and reach the model catalog, classifiers, and image models
 * through `models.*`. Results start with a "Script completed" or "Script failed" header.
 *
 * Scripts can call the agent loop's nested tools: active `direct` tools and every `codemode` or
 * `deferred` tool. Nested calls run through the agent loop's tool pipeline (`ctx.executeTool`), so
 * validation, `tool_call`/`tool_result` hooks, and permission checks apply exactly as for direct
 * calls. Only the script's output reaches the model; nested results do not.
 *
 * Nested results are handed to the script as follows:
 * - A tool that declares `outputSchema` resolves to its `structuredContent`, also for error
 *   results that carry one (MCP tools resolve to their `CallToolResult`, including `isError`).
 * - Any other tool resolves to its text content as one string.
 * - A failed, blocked, or invalid call rejects with an Error carrying the tool's error text.
 *
 * A script that fails returns a normal error result that keeps its partial output, followed by
 * "Script error:" and the error. `store(key, value)` and `load(key)` keep JSON values across
 * calls; successful scripts append their writes to the session as `codemode-store` custom entries,
 * so each branch sees the values written on its own path.
 */

import type { AgentTool } from "@amazme/agent";
import { CODEMODE_SOURCE_GRAMMAR } from "@amazme/codemode/source";
import type { ToolDefinition, ToolInfo, ToolNamespace } from "../../core/extensions/types.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { wrapToolDefinition } from "../../core/tools/tool-definition-wrapper.ts";
import {
	CODEMODE_TOOL_NAME,
	codemodeSchema,
	createCodemodeDescription,
	DEFAULT_CODEMODE_INLINE_BUDGET,
	getCodemodeCallableTools,
	prepareCodemodeLoadout,
} from "../../core/codemode/declarations.ts";
import type {
	CodemodeHost,
	CodemodeStoreWrites as CodemodeStoreEntryData,
	CodemodeToolDetails,
	CodemodeToolInfo,
} from "../../core/codemode/types.ts";
import { codemodeRenderers } from "../../core/codemode/renderer.ts";

export {
	CODEMODE_TOOL_NAME,
	CODEMODE_STORE_ENTRY_TYPE,
	CODEMODE_DOCS_PATH,
	codemodeSchema,
	createCodemodeDescription,
	DEFAULT_CODEMODE_INLINE_BUDGET,
	getCodemodeCallableTools,
	toCodemodeDeclaration,
} from "../../core/codemode/declarations.ts";
export type {
	CodemodeModelRuntime,
	CodemodeNestedCall,
	CodemodeToolDetails,
	CodemodeStoreWrites as CodemodeStoreEntryData,
} from "../../core/codemode/types.ts";

export interface CodemodeToolOptions {
	/**
	 * Directory for truncated text and saved images when the tool runs without an
	 * {@link ExtensionToolContext} (standalone {@link createCodemodeTool}). Session-backed
	 * registration obtains the directory from {@link ExtensionContext.artifactDirectory} instead.
	 * There is no OS-temp fallback.
	 */
	artifactDirectory?: string;
	/** Namespace of a tool, for `searchTools()` ranking and its `namespace` filter. */
	getToolNamespace?: (toolName: string) => ToolNamespace | undefined;
	/** Prompt guidelines of every tool, by tool name, shown with declarations by `describeTool()` and `ALL_TOOLS`. */
	getToolGuidelines?: () => ReadonlyMap<string, readonly string[]>;
	/**
	 * Expose the `models` namespace to scripts, backed by the session's model registry
	 * (`ctx.modelRegistry`). Without it, `models` is not declared.
	 */
	models?: boolean;
	/**
	 * Persists `store()` writes as a session custom entry. Without it, writes last only for the
	 * current script; `load()` still reads entries already on the branch.
	 */
	appendEntry?: (customType: string, data: CodemodeStoreEntryData) => void;
	/** How the tool presents the loadout while active (the `codemode.mode` setting). Default: `on`. */
	getMode?: () => CodemodeMode;
	/** Token budget for tool declarations in the description. Default: {@link DEFAULT_CODEMODE_INLINE_BUDGET}. */
	getInlineBudget?: () => number | undefined;
}

export const codemodeToolSystemPromptContribution = {
	snippet: "Run JavaScript that calls other tools",
	guidelines: [
		"Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.",
	],
} as const;

/** Script globals that list or look up tools and namespaces, which the script may then call by any name. */
const DISCOVERY_GLOBALS = /\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/;

/**
 * The tools a script may call (`ToolDefinition.reachesTools`): every tool when it uses a discovery
 * global, else the words of its source, so `tools.mcp__docs__search` and
 * `tools["mcp__docs__" + name]` both name the `mcp__docs` namespace.
 */
function getScriptReach(code: unknown): "all" | readonly string[] {
	if (typeof code !== "string") return [];
	return DISCOVERY_GLOBALS.test(code) ? "all" : (code.match(/\w+/g) ?? []);
}

export function createCodemodeToolDefinition(
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	const appendEntry = options.appendEntry;
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		// Replaced with the declarations of the callable tools when the tool is activated.
		description: createCodemodeDescription([], {
			models: options.models === true,
		}),
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		parameters: codemodeSchema,
		// Scripts must not start other scripts.
		exposure: "model-only",
		reachesTools: (input) => getScriptReach(input.code),
		prepareLoadout: (loadout) =>
			prepareCodemodeLoadout(loadout, {
				mode: options.getMode?.(),
				inlineBudget: options.getInlineBudget?.(),
				models: options.models,
			}),
		// Capable models write the script as raw text instead of a JSON-escaped string.
		constrainedSampling: {
			type: "grammar",
			variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR },
		},
		// The sandbox (worker, QuickJS wasm) loads on the first call, not at startup.
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			// Session tools always receive ExtensionToolContext with artifactDirectory by type.
			// Standalone createCodemodeTool requires options.artifactDirectory.
			const artifactDirectory =
				ctx !== undefined
					? ctx.artifactDirectory
					: options.artifactDirectory;
			if (artifactDirectory === undefined) {
				throw new Error(
					"codemode requires artifactDirectory; pass it to createCodemodeTool or run inside a session",
				);
			}
			return (await import("../../core/codemode/execute.ts")).executeCodemode(
				toolCallId,
				params,
				signal,
				onUpdate,
				{
					tools: ctx ? getCodemodeCallableTools(ctx.tools) : [],
					...(options.models && ctx ? { models: ctx.modelRegistry } : {}),
					store: {},
					executeTool: (name, args, callSignal) => {
						if (!ctx) throw new Error("Tool calls need a session");
						return ctx.executeTool(name, args, { signal: callSignal }).then((outcome) => ({
							...outcome,
							result: {
								content: outcome.result.content,
								value: ctx.tools.find((tool) => tool.name === name)?.outputSchema
									? outcome.result.structuredContent
									: undefined,
							},
						}));
					},
					saveStore: appendEntry ? (writes) => appendEntry("codemode-store", writes) : undefined,
				} satisfies CodemodeHost,
				{
					getToolNamespace: options.getToolNamespace,
					getToolGuidelines: options.getToolGuidelines,
					artifactDirectory,
				},
			);
		},
		...codemodeRenderers,
	};
}

/**
 * Create the codemode tool as an AgentTool. The description lists the given tools; the script can
 * call whatever tools the agent loop provides at execution time.
 */
export function createCodemodeTool(
	tools: readonly CodemodeToolInfo[] = [],
	options: CodemodeToolOptions & { artifactDirectory: string },
): AgentTool<typeof codemodeSchema> {
	const definition = createCodemodeToolDefinition(options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		description: createCodemodeDescription(tools, {
			models: options.models === true,
		}),
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
