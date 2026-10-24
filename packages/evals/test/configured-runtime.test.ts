import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createAcmeServer,
	OPENAI_MODEL_ID,
	OPENAI_PROVIDER_ID,
	OPENAI_PROBE_PROMPT,
	OPENAI_PROBE_RESPONSE,
	ANTHROPIC_MODEL_ID,
	ANTHROPIC_PROVIDER_ID,
	ANTHROPIC_PROBE_PROMPT,
	ANTHROPIC_PROBE_RESPONSE,
} from "../evals/acme-server.ts";
import { configuredProvider } from "../evals/configured-runtime.ts";
import { runNativeEval, type ProviderProbe } from "../src/harness.ts";
const openai = createAcmeServer("openai");
const anthropic = createAcmeServer("anthropic");
beforeAll(async () => {
	await openai.start();
	await anthropic.start();
});
beforeEach(() => {
	openai.reset();
	anthropic.reset();
});
afterAll(async () => {
	await openai.stop();
	await anthropic.stop();
});
const model = { provider: "faux", id: "faux" };
function configured(probe: ProviderProbe, overrides = {}) {
	return runNativeEval("hello", {
		model,
		noTools: "all",
		workspaceFiles: {
			"provider.json": JSON.stringify({
				provider: probe.provider,
				model: probe.model,
				api: probe.api,
				base_url: probe.base_url,
				max_tokens: 128,
				...overrides,
			}),
		},
		providerProbe: () => probe,
	});
}
describe("native provider configuration", () => {
	it.each(["openai", "anthropic"] as const)(
		"applies %s configuration and makes a real fixture request",
		async (api) => {
			const probe: ProviderProbe =
				api === "openai"
					? {
							provider: OPENAI_PROVIDER_ID,
							model: OPENAI_MODEL_ID,
							api: "openai-completions",
							base_url: openai.baseUrl(),
							api_key: "resolved-acme-key",
							prompt: OPENAI_PROBE_PROMPT,
						}
					: {
							provider: ANTHROPIC_PROVIDER_ID,
							model: ANTHROPIC_MODEL_ID,
							api: "anthropic-messages",
							base_url: anthropic.baseUrl(),
							api_key: "resolved-messages-key",
							prompt: ANTHROPIC_PROBE_PROMPT,
						};
			const result = await configured(probe);
			expect(result.errors).toEqual([]);
			expect(configuredProvider(result, (api === "openai" ? openai : anthropic).validRequestReceived())).toEqual({
				validRequestReceived: true,
				existing_models_preserved: true,
				response: api === "openai" ? OPENAI_PROBE_RESPONSE : ANTHROPIC_PROBE_RESPONSE,
				settings: {
					provider: probe.provider,
					model: probe.model,
					api: probe.api,
					max_tokens: 128,
					key_configured: true,
				},
			});
			expect(JSON.stringify(result)).not.toContain(probe.api_key);
		},
	);
	it("rejects an endpoint mismatch before sending the fixture credential", async () => {
		const probe: ProviderProbe = {
			provider: OPENAI_PROVIDER_ID,
			model: OPENAI_MODEL_ID,
			api: "openai-completions",
			base_url: openai.baseUrl(),
			api_key: "resolved-acme-key",
			prompt: OPENAI_PROBE_PROMPT,
		};
		const result = await configured(probe, { base_url: "https://other.example/v1" });
		expect(result.errors).toEqual(["eval_provider_identity"]);
		expect(openai.validRequestReceived()).toBe(false);
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	});
});
