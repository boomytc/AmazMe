import { describe, expect, it, vi } from "vitest";
import { classify as typesafe } from "../src/api/typesafe-system-one.ts";
import { classify as cloudflare } from "../src/api/cloudflare-workers-ai-system-one.ts";
import { classify as openai } from "../src/api/openai-decisions.ts";
import { classify as llama } from "../src/api/llama-cpp-classify.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { ClassifierContext, ClassifierModel, ClassifierQuestion, ImageContent } from "../src/types.ts";
import { assertClassifierContext } from "../src/utils/classifier-context.ts";

const model: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	id: "jev-1.14.0",
	name: "Jev",
	api: "typesafe-system-one",
	provider: "typesafe",
	baseUrl: "https://typesafe.test/v1",
	input: ["text", "image"],
	contextWindow: 128000,
	cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const image: ImageContent = { type: "image", data: "cG5n", mimeType: "image/png" };
const question: ClassifierQuestion = {
	type: "bool",
	instructions: "Is the target visible?",
	criteria: { true: "Yes", false: "No" },
};
const context: ClassifierContext = { state: {}, questions: { visible: question } };

describe("System One rich content and asset references", () => {
	it("preserves structured entries and shares one named image across state, instructions and criteria", async () => {
		const reference = "ea70293c-8f86-4ad7-9888-a84235c0d829";
		const input: ClassifierContext = {
			state: { images: "ordinary caller data", history: [{ picture: reference }] },
			assets: { [reference]: image },
			questions: {
				visible: {
					type: "bool",
					instructions: ["Is the target in this reference?", reference],
					criteria: { true: { example: reference, minimum: 1 }, false: null },
				},
				kind: {
					type: "choice",
					instructions: { question: "Choose a matching reference", ignoreMirroring: true },
					criteria: { match: { examples: [reference] }, none: null },
				},
				similarity: {
					type: "score",
					instructions: `Rate similarity to ${reference}`,
					criteria: [null, { example: reference }],
				},
				target: { type: "box", instructions: ["The matching target in history[0].picture", reference] },
			},
		};
		const original = structuredClone(input);
		const fetch = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
			const payload = JSON.parse(String(options?.body));
			expect(payload.state).toEqual(input.state);
			expect(payload.assets).toEqual({ [reference]: { type: "image", format: "png", data_base64: image.data } });
			expect(payload.questions).toEqual({ ...input.questions, visible: { ...input.questions.visible, type: "noul" } });
			expect(new Headers(options?.headers).get("TypeSafe-Danger-Zone-Images")).toBe("true");
			return Response.json({
				answers: {
					visible: { type: "noul", noul: 0.97 },
					kind: { type: "choice", choice: "match", probabilities: { match: 1, none: 0 }, confidence: 1 },
					similarity: { type: "score", score: 0.95, confidence: 0.9 },
					target: { type: "box", box: { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 }, confidence: 0.92 },
				},
			});
		});
		const result = await typesafe(model, input, { apiKey: "fixture", fetch });
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
		expect(input).toEqual(original);
	});

	it("opts in for an asset used only inside a question and combines assets with legacy images", async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
			const payload = JSON.parse(String(options?.body));
			expect(payload.assets.reference.format).toBe("jpg");
			expect(new Headers(options?.headers).get("TypeSafe-Danger-Zone-Images")).toBe("true");
			if (payload.state.images) {
				expect(payload.state.images).toHaveLength(1);
				expect(Object.keys(payload.assets)).toHaveLength(2);
				expect(payload.assets[payload.state.images[0]].format).toBe("png");
			} else expect(Object.keys(payload.assets)).toEqual(["reference"]);
			return Response.json({ answers: { visible: { type: "noul", noul: 0.9 } } });
		});
		const input: ClassifierContext = {
			...context,
			assets: { reference: { ...image, mimeType: "image/jpeg" } },
			questions: { visible: { ...question, instructions: "Is the reference visible?" } },
		};
		expect((await typesafe(model, input, { apiKey: "fixture", fetch })).stopReason).toBe("stop");
		expect((await typesafe(model, { ...input, images: [image] }, { apiKey: "fixture", fetch })).stopReason).toBe(
			"stop",
		);
	});

	it.each([
		["unused", "image asset is not referenced"],
		["question-id-only", "image asset is not referenced"],
		[" ", "invalid image references"],
		["中".repeat(342), "invalid image references"],
	])("rejects unusable asset reference %# before sending", async (reference, error) => {
		const fetch = vi.fn();
		const result = await typesafe(
			model,
			{ state: { [reference]: null }, questions: { [reference]: question }, assets: { [reference]: image } },
			{ apiKey: "fixture", fetch },
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(error);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects named assets at the model capability boundary before calling a custom provider", async () => {
		const classify = vi.fn();
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "typesafe",
				auth: {},
				models: [{ ...model, input: ["text"] }],
				classifiers: { "typesafe-system-one": { classify } },
			}),
		);
		const result = await models.classify(
			{ ...model, input: ["text"] },
			{ ...context, assets: { reference: image }, state: { picture: "reference" } },
		);
		expect(result.errorMessage).toContain("does not accept image input");
		expect(classify).not.toHaveBeenCalled();
	});

	it.each([undefined, Number.NaN, () => "not JSON"])("rejects invalid structured content %#", (invalid) => {
		expect(() =>
			assertClassifierContext({ ...context, questions: { visible: { ...question, instructions: { invalid } } } }),
		).toThrow("JSON");
	});

	it("rejects cycles without mutating caller input", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => assertClassifierContext({ ...context, state: circular })).toThrow("cycles");
	});

	it("keeps a text-only structured request free of image opt-in and assets", async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
			const payload = JSON.parse(String(options?.body));
			expect(payload.assets).toBeUndefined();
			expect(new Headers(options?.headers).get("TypeSafe-Danger-Zone-Images")).toBeNull();
			return Response.json({ answers: { visible: { type: "noul", noul: 0.9 } } });
		});
		const result = await typesafe(
			model,
			{
				...context,
				questions: { visible: { ...question, instructions: { question: "Does text describe a table?" } } },
			},
			{ apiKey: "fixture", fetch },
		);
		expect(result.stopReason, result.errorMessage).toBe("stop");
	});

	it("checks the combined UTF-8 reference-name budget before sending", async () => {
		const references = Array.from({ length: 65 }, (_, index) => `${index}-` + "x".repeat(1010));
		const fetch = vi.fn();
		const result = await typesafe(
			model,
			{
				...context,
				state: { pictures: references },
				assets: Object.fromEntries(references.map((ref) => [ref, image])),
			},
			{ apiKey: "fixture", fetch },
		);
		expect(result.errorMessage).toContain("65536 bytes total");
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("classifier backend capability boundaries", () => {
	it.each([
		["OpenAI", openai, "openai-decisions"],
		["Cloudflare", cloudflare, "cloudflare-workers-ai-system-one"],
		["llama.cpp", llama, "llama-cpp-classify"],
	] as const)("%s rejects rich content and named assets before sending", async (_name, classify, api) => {
		const fetch = vi.fn();
		for (const input of [
			{ ...context, questions: { visible: { ...question, instructions: { question: "Visible?" } } } },
			{ ...context, assets: { reference: image }, state: { picture: "reference" } },
		]) {
			const result = await classify({ ...model, api }, input, { apiKey: "fixture", fetch });
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/does not support/);
		}
		expect(fetch).not.toHaveBeenCalled();
	});
});
