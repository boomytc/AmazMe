import { describe, expect, it } from "vitest";
import { getModel, getModels, getProviders, streamSimple } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";

const EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS = [
	"anthropic/claude-fable-5",
	"anthropic/claude-haiku-5-5",
	"anthropic/claude-opus-4-8",
	"anthropic/claude-opus-5",
	"anthropic/claude-sonnet-5",
	"cloudflare-ai-gateway/claude-fable-5",
	"fireworks/accounts/fireworks/models/deepseek-v4p1-flash",
	"fireworks/accounts/fireworks/models/gpt-oss-120b",
	"fireworks/accounts/fireworks/models/qwen3p8-max",
	"minimax-cn/MiniMax-M3.1-Flash",
	"minimax/MiniMax-M3.1-Flash",
	"opencode/claude-opus-4-8",
	"opencode/claude-opus-5",
	"vercel-ai-gateway/anthropic/claude-opus-4.8",
	"vercel-ai-gateway/anthropic/claude-opus-5",
	"vercel-ai-gateway/anthropic/claude-sonnet-5",
];

function getAllModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => getModels(provider) as Model<Api>[]);
}

describe("Anthropic adaptive thinking model metadata", () => {
	it("marks built-in Anthropic Messages models that use adaptive thinking", () => {
		const flaggedModels = getAllModels()
			.filter((model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages")
			.filter((model) => model.compat?.forceAdaptiveThinking === true)
			.map((model) => `${model.provider}/${model.id}`)
			.sort();

		expect(flaggedModels).toEqual(expect.arrayContaining([...EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS].sort()));
		expect(flaggedModels).toEqual(
			flaggedModels.filter(
				(modelId) =>
					// Regression for #9323: Fireworks uses catalog effort metadata and
					// verified fallbacks, not a fixed set of adaptive model names.
					modelId.startsWith("fireworks/") ||
					// #11121: MiniMax models with catalog effort levels require adaptive thinking.
					modelId.startsWith("minimax/") ||
					modelId.startsWith("minimax-cn/") ||
					/(opus[-.](4[-.][678]|5)|sonnet[-.]4[-.]6|sonnet[-.]5|haiku[-.]5[-.]5|fable[-.]5)/.test(modelId),
			),
		);
	});

	it.each(["minimax", "minimax-cn"] as const)("keeps %s current models and sends native Flash effort", async (provider) => {
		const models = getModels(provider);
		for (const id of ["MiniMax-M2", "MiniMax-M2.1", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"]) {
			expect(models.some((model) => model.id === id)).toBe(false);
		}
		const model = getModel(provider, "MiniMax-M3.1-Flash");
		expect(model.compat?.forceAdaptiveThinking).toBe(true);
		expect(model.thinkingLevelMap?.off).toBeNull();
		let payload: unknown;
		await streamSimple(
			{ ...model, baseUrl: "http://127.0.0.1:9" },
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-key",
				env: {},
				reasoning: "high",
				fetch: async () => {
					throw new Error("Unexpected network request");
				},
				onPayload: (value) => {
					payload = value;
					throw new Error("payload captured");
				},
			},
		).result();
		expect(payload).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
		});
	});
});
