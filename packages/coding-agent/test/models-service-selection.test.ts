import { createModels, fauxProvider } from "@amazme/ai";
import { replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT as context } from "@amazme/chord/context";
import { AgentDoc, createRegistry, Harness, MemoryStorage, type Conversation } from "@amazme/durable";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelsService, type ModelsServiceRuntime } from "../src/host/services/models-provider.ts";

const harnesses: Harness[] = [];
const runtimes: ModelsServiceRuntime[] = [];
afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(harnesses.splice(0).map((harness) => harness.close(context)));
});

async function setup(settings: SettingsManager) {
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		models: [
			{ id: "first", reasoning: true },
			{ id: "second", reasoning: true },
			{ id: "plain", reasoning: false },
		],
	});
	modelRuntime.registerNativeProvider({
		...faux.provider,
		auth: {
			apiKey: {
				name: "Fixture",
				check: async () => ({ type: "api_key", source: "env" }),
				resolve: async () => ({ auth: {} }),
			},
		},
	});
	await modelRuntime.refresh({ allowNetwork: false });
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry: createRegistry() },
		context,
	);
	harnesses.push(harness);
	const conversation = await harness.root(context);
	await conversation.configure(
		{ model: { provider: "faux", modelId: "first" }, thinkingLevel: "off" },
		context,
	);
	const runtime = createModelsService(
		async () => conversation,
		() => undefined,
		modelRuntime,
		settings,
		replicatedState,
	);
	runtimes.push(runtime);
	await runtime.activate(context);
	return { runtime, service: runtime.service, harness, conversation };
}

async function selected(harness: Harness, conversation: Conversation) {
	const agent = await harness.snapshot(AgentDoc, conversation.id, context);
	return { model: agent?.model, thinkingLevel: agent?.thinkingLevel };
}

describe("hosted model selection", () => {
	it("uses the target model's thinking default and clamps unsupported levels", async () => {
		const { service, harness, conversation } = await setup(
			SettingsManager.inMemory({
				defaultThinkingLevel: "minimal",
				modelThinkingLevels: { "faux/second": "low" },
			}),
		);

		await service.select({ provider: "faux", modelId: "second" }, context);
		expect(await selected(harness, conversation)).toEqual({
			model: { provider: "faux", modelId: "second" },
			thinkingLevel: "low",
		});

		await service.select({ provider: "faux", modelId: "plain" }, context);
		expect(await selected(harness, conversation)).toEqual({
			model: { provider: "faux", modelId: "plain" },
			thinkingLevel: "off",
		});
	});

	it("cycles with scope suffixes first, then the target's defaults", async () => {
		const { service, harness, conversation } = await setup(
			SettingsManager.inMemory({
				enabledModels: ["faux/first", "faux/second:high", "faux/plain"],
				defaultThinkingLevel: "minimal",
				modelThinkingLevels: { "faux/first": "medium", "faux/second": "low" },
			}),
		);

		await service.cycleModel("forward", context);
		expect(await selected(harness, conversation)).toEqual({
			model: { provider: "faux", modelId: "second" },
			thinkingLevel: "high",
		});

		await service.cycleModel("forward", context);
		expect(await selected(harness, conversation)).toEqual({
			model: { provider: "faux", modelId: "plain" },
			thinkingLevel: "off",
		});

		await service.cycleModel("forward", context);
		expect(await selected(harness, conversation)).toEqual({
			model: { provider: "faux", modelId: "first" },
			thinkingLevel: "medium",
		});
	});
});
