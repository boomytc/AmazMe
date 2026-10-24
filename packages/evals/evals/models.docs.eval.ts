import { afterAll, beforeAll } from "vitest";
import { describeEval, StructuredOutputJudge } from "vitest-evals";
import { createDocumentationEvalHarness } from "../src/harness.ts";
import { createAcmeServer, OPENAI_MODEL_ID, OPENAI_PROBE_PROMPT, OPENAI_PROBE_RESPONSE } from "./acme-server.ts";
import { configuredProvider } from "./configured-runtime.ts";
const server = createAcmeServer("openai");
beforeAll(() => server.start());
afterAll(() => server.stop());
const harness = createDocumentationEvalHarness({
	providerProbe: () => ({
		provider: "openai",
		model: OPENAI_MODEL_ID,
		api: "openai-completions",
		base_url: server.baseUrl(),
		api_key: "resolved-acme-key",
		prompt: OPENAI_PROBE_PROMPT,
	}),
	output: (result) => configuredProvider(result, server.validRequestReceived()),
});
describeEval(
	"Add model to existing provider",
	{
		harness,
		judgeThreshold: null,
		judges: [
			StructuredOutputJudge({
				expected: {
					validRequestReceived: true,
					response: OPENAI_PROBE_RESPONSE,
					existing_models_preserved: true,
					settings: {
						provider: "openai",
						model: OPENAI_MODEL_ID,
						api: "openai-completions",
						max_tokens: 4096,
						key_configured: true,
					},
				},
				match: "strict",
				allowExtras: false,
			}),
		],
	},
	(it) => {
		it("selects a custom model without replacing the catalog", async ({ run }) => {
			await run(
				`Write provider.json in the workspace selecting openai/${OPENAI_MODEL_ID} for the AmazMe Python backend, at ${server.baseUrl()} with max output 4096. Retain the built-in model catalog. Do not include credentials.`,
			);
		});
	},
);
