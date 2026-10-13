import { defineExtension, defineTool } from "../harness/define.ts";
import { renderToolSearchResult, searchDeferredTools, TOOL_SEARCH_DESCRIPTION, TOOL_SEARCH_TOOL_NAME, toolSearchSchema } from "./search.ts";

/** Discovery uses the existing exposure and persisted activation filters, including host permission limits. */
export function createToolSearchTool() {
	return defineTool({
		name: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		parameters: toolSearchSchema,
		exposure: "model-only",
		callers: ["model"],
		replay: "safe",
		async execute({ query, limit }, api, context) {
			const agent = await api.agent(context);
			const matches = searchDeferredTools(agent.catalog, agent.tools.map((tool) => tool.name), query, limit);
			const result = renderToolSearchResult(matches);
			return {
				output: result.content,
				details: result.details,
				...(matches.length === 0 ? {} : { control: { addTools: matches.map((tool) => tool.name) } }),
			};
		},
	});
}

export function createToolSearchExtension() {
	return defineExtension({ name: "tool-search", tools: [createToolSearchTool()] });
}
