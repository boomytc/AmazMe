/**
 * Custom model selection.
 *
 * Shows how to select a specific model and thinking level.
 */

import { createDurableSession, ModelRuntime } from "@amazme/coding-agent";

const modelRuntime = await ModelRuntime.create();

const opus = modelRuntime.getModel("anthropic", "claude-opus-4-5");
if (opus) console.log(`Found model: ${opus.provider}/${opus.id}`);

const customModel = modelRuntime.getModel("my-provider", "my-model");
if (customModel) console.log(`Found custom model: ${customModel.provider}/${customModel.id}`);

const available = await modelRuntime.getAvailable();
console.log(
	"Available models:",
	available.map((model) => `${model.provider}/${model.id}`),
);

const selected = available[0];
if (selected) {
	const session = await createDurableSession({
		modelRuntime,
		provider: selected.provider,
		model: selected.id,
		thinkingLevel: "medium",
	});
	try {
		await session.prompt("Say hello in one sentence.");
		console.log();
	} finally {
		await session.dispose();
	}
}
