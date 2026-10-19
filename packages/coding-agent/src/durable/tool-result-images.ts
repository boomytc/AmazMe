import type { Context } from "@amazme/chord";
import { defineExtension, hook, ToolTask } from "@amazme/durable";
import type { HookApi, ToolExecutionResult, ToolHookCall } from "@amazme/durable";
import type { SettingsManager } from "../core/settings-manager.ts";
import { normalizeToolResultImages, type ToolResultContent } from "../utils/tool-result-images.ts";

/**
 * Shrink images that tools other than `read` put in a model-visible result.
 * Nested results stay as the tool produced them; a parent that forwards an image is normalized then.
 */
export function createToolResultImages(settings: Pick<SettingsManager, "getImageAutoResize">) {
	return defineExtension({
		name: "tool-result-images",
		hooks: [
			hook(ToolTask, {
				async afterTool(call, result, api, context) {
					const output = await normalizedToolImages(call, result, api, context, settings);
					if (output === undefined) return;
					return { ...result, output };
				},
			}),
		],
	});
}

async function normalizedToolImages(
	call: ToolHookCall,
	result: ToolExecutionResult,
	api: HookApi,
	context: Context,
	settings: Pick<SettingsManager, "getImageAutoResize">,
): Promise<ToolResultContent[] | undefined> {
	if (call.parent !== undefined) return;
	const output = result.output;
	if (output === undefined || !output.some((block) => block.type === "image")) return;
	const ref = (await api.agent(context)).model;
	const model = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
	const normalized = await normalizeToolResultImages(output, {
		autoResizeImages: settings.getImageAutoResize(),
		resizeOptions: model?.inputLimits?.images?.resize,
	});
	return normalized === output ? undefined : normalized;
}
