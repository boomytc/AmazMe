import { afterAll, beforeAll, beforeEach } from "vitest";
import { describeEval, StructuredOutputJudge } from "vitest-evals";
import { createDocumentationEvalHarness } from "../src/harness.ts";
import {
	createAcmeServer,
	ANTHROPIC_PROVIDER_ID,
	ANTHROPIC_MODEL_ID,
	ANTHROPIC_PROBE_PROMPT,
	ANTHROPIC_PROBE_RESPONSE,
} from "./acme-server.ts";
import { configuredProvider } from "./configured-runtime.ts";
const server = createAcmeServer("anthropic");
beforeAll(() => server.start());
beforeEach(() => server.reset());
afterAll(() => server.stop());
const harness = createDocumentationEvalHarness({
	providerProbe: () => ({
		provider: ANTHROPIC_PROVIDER_ID,
		model: ANTHROPIC_MODEL_ID,
		api: "anthropic-messages",
		base_url: server.baseUrl(),
		api_key: "resolved-messages-key",
		prompt: ANTHROPIC_PROBE_PROMPT,
	}),
	output: (result) => configuredProvider(result, server.validRequestReceived()),
});
describeEval(
	"Add custom Messages endpoint",
	{
		harness,
		judgeThreshold: null,
		judges: [
			StructuredOutputJudge({
				expected: {
					validRequestReceived: true,
					response: ANTHROPIC_PROBE_RESPONSE,
					existing_models_preserved: true,
					settings: {
						provider: ANTHROPIC_PROVIDER_ID,
						model: ANTHROPIC_MODEL_ID,
						api: "anthropic-messages",
						max_tokens: 2048,
						key_configured: true,
					},
				},
				match: "strict",
				allowExtras: false,
			}),
		],
	},
	(it) => {
		it("configures the existing native Messages protocol", async ({ run }) => {
			await run(
				`Write provider.json in the workspace for the AmazMe Python backend: provider ${ANTHROPIC_PROVIDER_ID}, model ${ANTHROPIC_MODEL_ID}, Anthropic Messages streaming API at ${server.baseUrl()}, max output 2048. The account vault supplies credentials separately. Reuse the backend protocol without adding a provider runtime.`,
			);
		});
	},
);
