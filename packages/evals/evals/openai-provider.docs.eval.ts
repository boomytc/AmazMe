import { afterAll, beforeAll, beforeEach } from "vitest";
import { describeEval, StructuredOutputJudge } from "vitest-evals";
import { createDocumentationEvalHarness } from "../src/harness.ts";
import {
	createAcmeServer,
	OPENAI_PROVIDER_ID,
	OPENAI_MODEL_ID,
	OPENAI_PROBE_PROMPT,
	OPENAI_PROBE_RESPONSE,
} from "./acme-server.ts";
import { configuredProvider } from "./configured-runtime.ts";
const server = createAcmeServer("openai");
beforeAll(() => server.start());
beforeEach(() => server.reset());
afterAll(() => server.stop());
const harness = createDocumentationEvalHarness({
	providerProbe: () => ({
		provider: OPENAI_PROVIDER_ID,
		model: OPENAI_MODEL_ID,
		api: "openai-completions",
		base_url: server.baseUrl(),
		api_key: "resolved-acme-key",
		prompt: OPENAI_PROBE_PROMPT,
	}),
	output: (result) => configuredProvider(result, server.validRequestReceived()),
});
describeEval(
	"Add OpenAI-compatible provider",
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
						provider: OPENAI_PROVIDER_ID,
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
		it("configures a provider that works through Python", async ({ run }) => {
			await run(
				`Write provider.json in the workspace for the AmazMe Python backend: provider ${OPENAI_PROVIDER_ID}, model ${OPENAI_MODEL_ID}, OpenAI Chat Completions at ${server.baseUrl()}, max output 4096. Do not include credentials; the account vault supplies them separately.`,
			);
		});
	},
);
