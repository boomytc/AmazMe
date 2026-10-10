import { copyJson } from "@amazme/chord";
import type { JsonValue } from "@amazme/chord";
import { withAbortSignal } from "@amazme/chord/context";
import { CODEMODE_SOURCE_GRAMMAR, MAX_STORE_TOTAL_CHARS } from "@amazme/codemode";
import { defineDoc, defineExtension, defineTool } from "@amazme/durable";
import type { ToolRegistration } from "@amazme/durable";
import { Type } from "typebox";
import {
	CODEMODE_TOOL_NAME,
	codemodeSchema,
	createCodemodeDescription,
	getCodemodeCallableTools,
	prepareCodemodeLoadout,
} from "../core/codemode/declarations.ts";
import type { CodemodeHost } from "../core/codemode/types.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import {
	TOOL_SEARCH_TOOL_NAME,
	toolSearchSchema,
	TOOL_SEARCH_DESCRIPTION,
	searchDeferredTools,
	renderToolSearchResult,
} from "../core/tool-search.ts";

const ImageOutput = Type.Object({
	type: Type.Literal("image"),
	mimeType: Type.String(),
	data: Type.String(),
});
const DefaultOutput = Type.Union([
	Type.String(),
	ImageOutput,
	Type.Array(Type.Union([Type.Object({ type: Type.Literal("text"), text: Type.String() }), ImageOutput])),
]);

/** Declare the values native nested calls return, without adding a second schema to the registration. */
function scriptTool(tool: ToolRegistration) {
	return {
		...tool,
		outputSchema: tool.structuredOutputSchema ?? DefaultOutput,
	};
}

/** Script state follows the conversation's actual history; a fork receives its as-of values. */
export const CodemodeStoreDoc = defineDoc<{
	values: Record<string, JsonValue>;
}>({
	kind: "amazme.codemode-store",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ values: {} }),
	checkpointWhen: () => true,
});

/** SDK and Durable share the sandbox, discovery, model calls and output projection; only ownership differs. */
export function createDurableCodemode(settings: SettingsManager) {
	return defineExtension({
		name: "codemode",
		tools: [
			defineTool({
				name: CODEMODE_TOOL_NAME,
				description: createCodemodeDescription([], { models: true }),
				parameters: codemodeSchema,
				exposure: "model-only",
				defaultActive: false,
				constrainedSampling: {
					type: "grammar",
					variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR },
				},
				prepareLoadout: (loadout) =>
					prepareCodemodeLoadout(
						{
							...loadout,
							declared: loadout.declared.map(scriptTool),
							callable: loadout.callable.map(scriptTool),
						},
						{
							mode: settings.getSettings().codemode?.mode,
							inlineBudget: settings.getSettings().codemode?.inlineBudget,
							models: true,
						},
					),
				async execute(input, api, context) {
					const agent = await api.agent(context);
					const tools = getCodemodeCallableTools(agent.callable).map(scriptTool);
					const store = await api.snapshot(CodemodeStoreDoc, api.conversationId, context);
					let calls = 0;
					const host: CodemodeHost = {
						tools,
						models: api.models,
						store: store?.values,
						executeTool: async (name, args, signal) => {
							const parameters = copyJson(args);
							if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters))
								throw new TypeError("Tool arguments must be a JSON object");
							const id = `${api.callId}/${++calls}`;
							const result = await api.executeTool(name, parameters, withAbortSignal(signal, context));
							const diagnostics = result.isError ? (result.diagnostics ?? []) : [];
							return {
								toolCall: { id },
								result: {
									content: [
										...diagnostics.map((item) => ({
											type: "text" as const,
											text: item.message,
										})),
									],
									value:
										result.isError &&
										agent.callable.find((tool) => tool.name === name)?.structuredOutputSchema === undefined
											? undefined
											: result.structuredOutput,
								},
								isError: result.isError ?? false,
							};
						},
						saveStore: async (writes) => {
							await api.commit(async (tx) => {
								const state = await tx.doc(CodemodeStoreDoc, api.conversationId);
								const values = new Map(Object.entries(state.values));
								for (const key of writes.delete) values.delete(key);
								for (const [key, value] of Object.entries(writes.set)) values.set(key, copyJson(value));
								const next = Object.fromEntries(values);
								if (JSON.stringify(next).length > MAX_STORE_TOTAL_CHARS)
									throw new Error("Codemode store exceeds its size limit");
								state.values = next;
							}, context);
						},
					};
					const result = await (await import("../core/codemode/execute.ts")).executeCodemode(
						api.callId,
						input,
						context.abortSignal,
						(progress) => {
							void api.details(copyJson(progress.details), context).catch(() => {});
						},
						host,
						{
							getToolNamespace: (name) => tools.find((tool) => tool.name === name)?.namespace,
							getToolGuidelines: () => new Map(tools.map((tool) => [tool.name, tool.promptGuidelines ?? []])),
						},
					);
					return {
						output: result.content,
						isError: result.isError,
						details: copyJson(result.details),
					};
				},
			}),
			defineTool({
				name: TOOL_SEARCH_TOOL_NAME,
				description: TOOL_SEARCH_DESCRIPTION,
				parameters: toolSearchSchema,
				exposure: "model-only",
				defaultActive: false,
				replay: "safe",
				async execute({ query, limit }, api, context) {
					const agent = await api.agent(context);
					const matches = searchDeferredTools(
						agent.catalog,
						agent.tools.map((tool) => tool.name),
						query,
						limit,
					);
					return {
						output: renderToolSearchResult(matches).content,
						control: { addTools: matches.map((tool) => tool.name) },
					};
				},
			}),
		],
	});
}
