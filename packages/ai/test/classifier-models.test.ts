import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels, createProvider, getModelType } from "../src/models.ts";
import {
	builtinModels,
	getAllBuiltinModels,
	getBuiltinClassifierModel,
	getBuiltinClassifierModels,
} from "../src/providers/all.ts";
import type { Api, ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function classifierModel(provider: string, id: string): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id,
		name: id,
		api: "test-classifier",
		provider,
		baseUrl: "https://example.test/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
	};
}

function chatModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "test-chat",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

const context: ClassifierContext = {
	state: { text: "yes" },
	questions: {
		approved: {
			type: "bool",
			instructions: "Does this express approval?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

describe("Models with classifier models", () => {
	it("keeps chat and classifier entries with the same provider and id separate", async () => {
		const chat = chatModel("test", "shared");
		const classifier = classifierModel("test", "shared");
		const provider = createProvider({
			id: "test",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [chat, classifier],
			api: {
				"test-chat": {
					stream: () => new AssistantMessageEventStream(),
					streamSimple: () => new AssistantMessageEventStream(),
				},
			},
			classifiers: {
				"test-classifier": {
					classify: async (model): Promise<ClassifierResult> => ({
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers: { approved: { type: "bool", probability: 0.9 } },
						stopReason: "stop",
						timestamp: Date.now(),
					}),
				},
			},
		});
		const models = createModels();
		models.setProvider(provider);

		const listedChat = models.getModel("test", "shared");
		expect(listedChat && getModelType(listedChat)).toBe("chat");
		expect(models.getModelOfType("classifier", "test", "shared")?.type).toBe("classifier");
		expect(models.getModelsOfType("classifier")).toEqual([classifier]);
		expect(models.getAllModels()).toHaveLength(2);
		expect(await models.getAvailableOfType("classifier")).toEqual([classifier]);
		expect((await models.classify(classifier, context)).answers.approved).toEqual({
			type: "bool",
			probability: 0.9,
		});
	});

	it("rejects chat models at the classifier entry point at runtime", async () => {
		const chat = chatModel("test", "chat");
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "test",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [chat],
				api: {
					stream: () => new AssistantMessageEventStream(),
					streamSimple: () => new AssistantMessageEventStream(),
				},
			}),
		);

		const result = await models.classify(chat as unknown as ClassifierModel<ClassifierApi>, context);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("is not a classifier model");
	});

	it("exposes Jev only through classifier catalog accessors", () => {
		const jev = getBuiltinClassifierModel("typesafe", "jev-latest");
		const jev14 = getBuiltinClassifierModel("typesafe", "jev-1.14.0");
		expect(jev).toMatchObject({
			type: "classifier",
			api: "typesafe-system-one",
			provider: "typesafe",
			contextWindow: 64000,
			input: ["text", "image"],
			cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(jev14).toMatchObject({
			id: "jev-1.14.0",
			input: ["text", "image"],
			api: "typesafe-system-one",
			cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(getBuiltinClassifierModels("typesafe")).toEqual(expect.arrayContaining([jev, jev14]));
		expect(getAllBuiltinModels("typesafe")).toEqual(expect.arrayContaining([jev, jev14]));

		const models = builtinModels();
		expect(models.getModel("typesafe", "jev-latest")).toBeUndefined();
		expect(models.getModelOfType("classifier", "typesafe", "jev-latest")).toEqual(jev);
		expect(models.getModel("typesafe", "jev-1.14.0")).toBeUndefined();
		expect(models.getModelOfType("classifier", "typesafe", "jev-1.14.0")).toEqual(jev14);
	});

	it("routes pinned TypeSafe image and Box requests through the public classifier entry point", async () => {
		const models = builtinModels();
		const jev = models.getModelOfType("classifier", "typesafe", "jev-1.14.0");
		if (!jev) throw new Error("missing TypeSafe Jev 1.14 model");
		const box = { type: "box", box: { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 }, confidence: 0.85 };
		const result = await models.classify(
			jev,
			{
				state: { task: "find the mug" },
				images: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
				questions: {
					present: {
						type: "bool",
						instructions: "Is a mug visible in `images[0]`?",
						criteria: { true: "Visible", false: "Absent" },
					},
					target: { type: "box", instructions: "the mug in `images[0]`" },
				},
			},
			{
				apiKey: "secret",
				fetch: async (_input, init) => {
					expect(JSON.parse(String(init?.body))).toMatchObject({
						model: "jev-1.14.0",
						state: { task: "find the mug", images: [expect.any(String)] },
					});
					expect(new Headers(init?.headers).get("TypeSafe-Danger-Zone-Images")).toBe("true");
					return Response.json({
						answers: { present: { type: "noul", noul: 0.1 }, target: box },
						usage: { input_tokens: 290, output_tokens: 21 },
					});
				},
			},
		);
		expect(result.stopReason).toBe("stop");
		expect(result.answers.present).toEqual({ type: "bool", probability: 0.1 });
		// The adapter preserves the Box even when the presence answer is low; the caller decides whether to use it.
		expect(result.answers.target).toEqual(box);
		expect(result.usage?.cost.input).toBeCloseTo(0.00001218, 12);
		expect(result.usage?.cost.output).toBe(0);
		expect(result.usage?.cost.total).toBeCloseTo(0.00001218, 12);
	});

	it.each([
		["vercel-ai-gateway", "typesafe-ai/jev", "https://ai-gateway.vercel.sh/typesafe/v1/systemone"],
		["opencode", "jev-1.13", "https://opencode.ai/zen/v1/systemone"],
		["opencode", "jev-1.13-free", "https://opencode.ai/zen/v1/systemone"],
	])("routes %s Jev (%s) to its TypeSafe-compatible endpoint", async (provider, id, url) => {
		const models = builtinModels();
		const jev = models.getModelOfType("classifier", provider, id);
		if (!jev) throw new Error(`missing ${provider} Jev model`);
		expect(jev).toMatchObject({ api: "typesafe-system-one", contextWindow: 32000 });
		expect(models.getModel(provider, id)).toBeUndefined();

		const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
		const result = await models.classify(jev, context, {
			apiKey: "secret",
			fetch: async (input, init) => {
				requests.push({
					url: String(input),
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
					authorization: new Headers(init?.headers).get("authorization"),
				});
				return Response.json({ model: id, answers: { approved: { type: "noul", noul: 0.8 } } });
			},
		});

		expect(requests).toEqual([
			{
				url,
				body: expect.objectContaining({ model: id, state: context.state }),
				authorization: "Bearer secret",
			},
		]);
		expect(result.stopReason).toBe("stop");
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.8 });
	});

	it("rejects images for classifier models without image input before calling the provider", async () => {
		const classifier = classifierModel("test", "text-only");
		const classify = vi.fn(
			async (): Promise<ClassifierResult> => ({
				api: classifier.api,
				provider: classifier.provider,
				model: classifier.id,
				answers: {},
				stopReason: "stop",
				timestamp: Date.now(),
			}),
		);
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "test",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [classifier],
				classifiers: { "test-classifier": { classify } },
			}),
		);

		const result = await models.classify(classifier, {
			...context,
			images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		});
		const withoutImages = await models.classify(classifier, { ...context, images: [] });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Model test/text-only does not accept image input");
		expect(withoutImages.stopReason).toBe("stop");
		expect(classify).toHaveBeenCalledOnce();
	});

	it("routes OpenAI GPT-6 Luna through the Decisions API with images", async () => {
		const models = builtinModels();
		const luna = models.getModelOfType("classifier", "openai", "gpt-6-luna");
		if (!luna) throw new Error("missing OpenAI Decisions model");
		expect(luna).toMatchObject({ api: "openai-decisions", input: ["text", "image"], contextWindow: 922000 });
		// The chat entry with the same id stays separate.
		expect(models.getModel("openai", "gpt-6-luna")?.api).toBe("openai-responses");

		const urls: string[] = [];
		const result = await models.classify(
			luna,
			{ ...context, images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] },
			{
				apiKey: "secret",
				fetch: async (input) => {
					urls.push(String(input));
					return Response.json({ answers: [{ type: "predicate", name: "approved", probability: 0.8 }] });
				},
			},
		);

		expect(urls).toEqual(["https://api.openai.com/v1/decisions"]);
		expect(result.stopReason).toBe("stop");
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.8 });
	});

	it("lists OpenAI Decisions models only for API key credentials", async () => {
		const apiKeyStore = new InMemoryCredentialStore();
		await apiKeyStore.modify("openai", async () => ({ type: "api_key", key: "secret" }));
		const oauthStore = new InMemoryCredentialStore();
		await oauthStore.modify("openai", async () => ({
			type: "oauth",
			access: "access",
			refresh: "refresh",
			expires: Date.now() + 3_600_000,
		}));

		const withApiKey = builtinModels({ credentials: apiKeyStore });
		const withOAuth = builtinModels({ credentials: oauthStore });

		expect((await withApiKey.getAvailableOfType("classifier", "openai")).map((model) => model.id)).toEqual([
			"gpt-6-luna",
		]);
		expect(await withOAuth.getAvailableOfType("classifier", "openai")).toEqual([]);
		// Chat models stay available with ChatGPT OAuth.
		expect((await withOAuth.getAvailable("openai")).some((model) => model.id === "gpt-6-luna")).toBe(true);
	});

	it("routes OpenRouter classifier models through the System One API", () => {
		const models = builtinModels();
		for (const model of getBuiltinClassifierModels("openrouter")) {
			expect(model).toMatchObject({ api: "typesafe-system-one", baseUrl: "https://openrouter.ai/api/v1" });
			expect(models.getModel("openrouter", model.id)).toBeUndefined();
			expect(models.getModelOfType("classifier", "openrouter", model.id)).toEqual(model);
		}
	});
});
