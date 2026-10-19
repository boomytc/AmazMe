import type { Context, JsonValue } from "@amazme/chord";
import { defineExtension, hook, retainStructuredOutput, ToolTask } from "@amazme/durable";
import type { HookApi, ToolExecutionResult, ToolHookCall } from "@amazme/durable";
import type { SettingsManager } from "../core/settings-manager.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";

/**
 * Shrink images that tools other than `read` put in a model-visible result.
 * Nested results stay as the tool produced them; a parent that forwards an image is normalized then.
 */
export function createToolResultImages(settings: Pick<SettingsManager, "getImageAutoResize">) {
	return defineExtension({
		name: "tool-result-images",
		hooks: [
			hook(ToolTask, {
				afterTool: (call, result, api, context) => normalizedToolResult(call, result, api, context, settings),
			}),
		],
	});
}

async function normalizedToolResult(
	call: ToolHookCall,
	result: ToolExecutionResult,
	api: HookApi,
	context: Context,
	settings: Pick<SettingsManager, "getImageAutoResize">,
): Promise<ToolExecutionResult | undefined> {
	if (call.parent !== undefined) return;
	const output = result.output;
	if (output === undefined || !output.some((block) => block.type === "image")) return;
	const ref = (await api.agent(context)).model;
	const model = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
	const normalized = await normalizeToolResultImages(output, {
		autoResizeImages: settings.getImageAutoResize(),
		resizeOptions: model?.inputLimits?.images?.resize,
	});
	if (normalized === output) return;
	// The image bytes changed. Keep the tool's structured value explicitly: a copied object is a new
	// container, and retainStructuredOutput also keeps a number, string, boolean, or null.
	const structuredOutput = carriedStructuredOutput(result.structuredOutput);
	const rewritten = structuredOutput === undefined
		? { ...result, output: normalized }
		: { ...result, output: normalized, structuredOutput };
	return retainStructuredOutput(rewritten);
}

/** New object or array identity for the same fields. Primitives and null stay the same value. */
function carriedStructuredOutput(value: JsonValue | undefined): JsonValue | undefined {
	if (Array.isArray(value)) return [...value];
	if (typeof value === "object" && value !== null) return { ...value };
	return value;
}
