/**
 * Tool discovery: a BM25 ranker over tool metadata, shared by `searchTools()` in codemode scripts and
 * the optional `tool_search` tool.
 *
 * `tool_search` searches tools that are not declared to
 * the model (`codemode` and `deferred` exposure) and loads the matches, so they are declared for the
 * next model call. Loading goes through the active tool set, so it is recorded in the transcript
 * like any other tool change and survives `/tree`, resume, and fork on that branch.
 */

import type { ExtensionAPI, ToolDefinition, ToolInfo } from "../../core/extensions/types.ts";

import {
	TOOL_SEARCH_TOOL_NAME,
	toolSearchSchema,
	TOOL_SEARCH_DESCRIPTION,
	searchDeferredTools,
	renderToolSearchResult,
} from "../../core/tool-search.ts";
export {
	TOOL_SEARCH_TOOL_NAME,
	toolSearchSchema,
	TOOL_SEARCH_DESCRIPTION,
	Bm25Ranker,
	createToolSearchDocument,
	DEFAULT_TOOL_SEARCH_LIMIT,
	tokenize,
} from "../../core/tool-search.ts";
export type {
	ToolSearchInput,
	ToolSearchResultTool,
	ToolRanker,
	ToolSearchDocument,
	ToolSearchMatch,
} from "../../core/tool-search.ts";

/** Whether the tool is this `tool_search`, not another extension's tool of the same name. */
export function isToolSearchTool(tool: Pick<ToolInfo, "name" | "parameters">): boolean {
	return tool.name === TOOL_SEARCH_TOOL_NAME && tool.parameters === toolSearchSchema;
}

export interface ToolSearchToolDetails {
	/** Tools loaded by this call. */
	loaded: string[];
}

export interface ToolSearchToolOptions {
	/**
	 * The session's tools. `tool_search` searches the tools that are not declared to the model and
	 * activates the matches. Without it, the tool finds nothing. An `ExtensionAPI` fits.
	 */
	tools?: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
}

export function createToolSearchToolDefinition(
	options: ToolSearchToolOptions = {},
): ToolDefinition<typeof toolSearchSchema, ToolSearchToolDetails> {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		promptSnippet: "Search for tools that are not loaded yet and load the matches",
		parameters: toolSearchSchema,
		// Searching is not something scripts need; it changes what the model sees.
		exposure: "model-only",
		async execute(_toolCallId, { query, limit }) {
			const active = options.tools?.getActiveTools() ?? [];
			const tools = searchDeferredTools(options.tools?.getAllTools() ?? [], active, query, limit);
			if (tools.length > 0) options.tools?.setActiveTools([...active, ...tools.map((tool) => tool.name)]);
			return renderToolSearchResult(tools);
		},
	};
}
