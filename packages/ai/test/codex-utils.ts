import { getSupportedThinkingLevels } from "../src/models.ts";
import { getBuiltinModels } from "../src/providers/all.ts";

// Keep live account tests independent of historical model fixtures. An explicit
// override must fail visibly if it cannot exercise the suite's capabilities.
export function getCodexTestModel(modelId = process.env.AMAZME_CODEX_TEST_MODEL ?? "gpt-6-luna") {
	const model = getBuiltinModels("openai-codex").find((candidate) => candidate.id === modelId);
	if (!model) {
		throw new Error(`Unknown Codex test model: ${modelId}. Set AMAZME_CODEX_TEST_MODEL to a catalog model ID.`);
	}
	if (!model.input.includes("image") || !getSupportedThinkingLevels(model).includes("xhigh")) {
		throw new Error(`Codex test model ${modelId} must support image input and xhigh reasoning.`);
	}
	return model;
}

export const codexTestModel = getCodexTestModel();
