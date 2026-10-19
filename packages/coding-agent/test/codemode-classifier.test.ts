import { createModels, createProvider, type ClassifierModel } from "@amazme/ai";
import { classify } from "@amazme/ai/api/typesafe-system-one";
import { describe, expect, it, vi } from "vitest";
import { executeCodemode } from "../src/core/codemode/execute.ts";
import { createTempDir } from "./temp-dir.ts";

const model: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	id: "jev-1.14.0",
	name: "Jev",
	provider: "typesafe",
	api: "typesafe-system-one",
	baseUrl: "https://typesafe.test/v1",
	input: ["text", "image"],
	contextWindow: 128000,
	cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const box = { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 };

function setup() {
	const artifactDirectory = createTempDir("amazme-test-artifact-");

	const fetch = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) =>
		Response.json({
			answers: { present: { type: "noul", noul: 0.98 }, target: { type: "box", box, confidence: 0.91 } },
			usage: { input_tokens: 1000, output_tokens: 30 },
		}),
	);
	const models = createModels();
	models.setProvider(
		createProvider({
			id: "typesafe",
			models: [model],
			auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture-key" } }) } },
			classifiers: {
				"typesafe-system-one": {
					classify: (model, context, options) =>
						classify(model, context, {
							...options,
							apiKey: "fixture-key",
							fetch,
						}),
				},
			},
		}),
	);
	const run = (context: unknown) =>
		executeCodemode(
			"classifier",
			{
				code: `return await models.classify({ provider: "typesafe", id: "jev-1.14.0" }, ${JSON.stringify(context)});`,
			},
			undefined,
			undefined,
			{
				tools: [],
				models,
				executeTool: async () => {
					throw new Error("No tools");
				},
			},
			{ artifactDirectory },
		);
	return { run, fetch };
}

describe("codemode classifier protocol", () => {
	it("carries Box and presence questions through the sandbox to System One and accounts for usage", async () => {
		const { run, fetch } = setup();
		const result = await run({
			state: { target: "the save button" },
			images: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
			questions: {
				present: {
					type: "bool",
					instructions: "Is target visible in images[0]?",
					criteria: { true: "Visible", false: "Absent" },
				},
				target: { type: "box", instructions: "The target in images[0]" },
			},
		});
		expect(result.isError).toBeUndefined();
		expect(fetch).toHaveBeenCalledOnce();
		expect(result.content).toContainEqual({ type: "text", text: expect.stringContaining(JSON.stringify(box)) });
		expect(result.usage?.input).toBe(1000);
		expect(result.details.calls).toMatchObject([{ name: "models.classify", status: "ok" }]);
	});

	it("rejects Box criteria before invoking the provider", async () => {
		const { run, fetch } = setup();
		const result = await run({
			state: {},
			questions: { target: { type: "box", instructions: "target", criteria: [] } },
		});
		expect(result.isError).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("preserves named assets and structured questions across the sandbox boundary", async () => {
		const { run, fetch } = setup();
		const reference = "ba65c630-7515-4e7f-b83f-56f423625626";
		const questions = {
			present: {
				type: "bool",
				instructions: { question: "Is the target visible?", image: reference },
				criteria: { true: { visible: true }, false: null },
			},
			target: { type: "box", instructions: ["Locate the target in this image", reference] },
		};
		const result = await run({
			state: { history: [{ frame: reference }] },
			assets: { [reference]: { type: "image", data: "cG5n", mimeType: "image/png" } },
			questions,
		});
		expect(result.isError).toBeUndefined();
		expect(fetch).toHaveBeenCalledOnce();
		const request = fetch.mock.calls[0][1];
		const payload = JSON.parse(String(request?.body));
		expect(payload.assets).toEqual({ [reference]: { type: "image", format: "png", data_base64: "cG5n" } });
		expect(payload.questions.target).toEqual(questions.target);
		expect(new Headers(request?.headers).get("TypeSafe-Danger-Zone-Images")).toBe("true");
	});

	it.each([
		{ assets: [] },
		{ assets: { ref: { type: "image", data: "cG5n" } } },
		{ questions: { present: { type: "bool", instructions: 1, criteria: { true: "yes", false: "no" } } } },
	])("rejects malformed rich input before invoking the provider %#", async (invalid) => {
		const { run, fetch } = setup();
		const result = await run({
			state: {},
			questions: { present: { type: "bool", instructions: "Visible?", criteria: { true: "yes", false: "no" } } },
			...invalid,
		});
		expect(result.isError).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});
});
