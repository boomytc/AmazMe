import assert from "node:assert/strict";
import test from "node:test";
import type { ApiStreamOptions, Model } from "@amazme/ai";
import { createModels } from "@amazme/ai";
import { azureOpenAIResponsesApi } from "@amazme/ai/api/azure-openai-responses";
import { azureOpenAIResponsesProvider } from "@amazme/ai/providers/azure-openai-responses";

const model: Model<"azure-openai-responses"> = {
  id: "catalog-model", name: "recorded", api: "azure-openai-responses", provider: "azure-openai-responses",
  input: ["text"], contextWindow: 8_000, maxTokens: 1_000, cost: { input: 0, output: 0 },
};

async function record(options: ApiStreamOptions<"azure-openai-responses">) {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const api = azureOpenAIResponsesApi({ fetch: async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response([
      'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ].join(""));
  } });
  const message = await api.stream(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
    apiKey: "fixture-key", ...options,
  }).result();
  return { message, requests };
}

test("Azure v1 sends the deployment in the body and API key on its native header", async () => {
  const { message, requests } = await record({ azureResourceName: "east", azureDeploymentName: "deployment-a" });
  assert.equal(message.stopReason, "stop");
  assert.equal(message.model, model.id);
  assert.equal(requests[0]?.url, "https://east.openai.azure.com/openai/v1/responses");
  assert.equal(requests[0]?.body.model, "deployment-a");
  assert.equal(requests[0]?.headers.get("api-key"), "fixture-key");
  assert.equal(requests[0]?.headers.has("authorization"), false);
});

test("Azure normalizes resource, API base, and complete response URLs without duplicating the route", async () => {
  for (const baseUrl of [
    "https://east.openai.azure.com/", "https://east.openai.azure.com/openai/",
    "https://east.openai.azure.com/openai/v1/", "https://east.openai.azure.com/openai/v1/responses",
  ]) {
    const { message, requests } = await record({ baseUrl });
    assert.equal(message.stopReason, "stop");
    assert.equal(requests[0]?.url, "https://east.openai.azure.com/openai/v1/responses", baseUrl);
    assert.equal(requests[0]?.body.model, model.id);
  }
});

test("Azure resolves environment base and deployment overrides", async () => {
  const { message, requests } = await record({ env: {
    AZURE_OPENAI_BASE_URL: "https://east.openai.azure.com/openai/v1",
    AZURE_OPENAI_DEPLOYMENT_NAME: "deployment-env",
  } });
  assert.equal(message.stopReason, "stop");
  assert.equal(requests[0]?.url, "https://east.openai.azure.com/openai/v1/responses");
  assert.equal(requests[0]?.body.model, "deployment-env");
});

test("Azure explicit preview versions keep their own response API route", async () => {
  const preview = await record({ azureResourceName: "east", azureApiVersion: "preview" });
  assert.equal(preview.requests[0]?.url, "https://east.openai.azure.com/openai/v1/responses?api-version=preview");
  const dated = await record({ azureResourceName: "east", azureApiVersion: "2025-04-01-preview" });
  assert.equal(dated.requests[0]?.url, "https://east.openai.azure.com/openai/responses?api-version=2025-04-01-preview");
});

test("missing or invalid Azure endpoints fail before fetch and are not retryable", async () => {
  for (const options of [{}, { azureBaseUrl: "not-an-endpoint" }]) {
    const { message, requests } = await record(options);
    assert.equal(message.stopReason, "error");
    assert.equal(message.retryable, undefined);
    assert.equal(requests.length, 0);
  }
});

test("the Azure preset carries configured environment routes through Models", async () => {
  let url = "";
  let deployment: unknown;
  const models = createModels({ env: {
    AZURE_OPENAI_API_KEY: "fixture-key", AZURE_OPENAI_BASE_URL: "https://east.openai.azure.com/openai/v1",
    AZURE_OPENAI_DEPLOYMENT_NAME: "configured-deployment",
  } });
  const provider = azureOpenAIResponsesProvider({ fetch: async (input, init) => {
    url = String(input);
    deployment = JSON.parse(String(init?.body)).model;
    return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
  } });
  models.setProvider(provider);
  const catalogModel = provider.getModels()[0];
  assert.ok(catalogModel);
  const message = await models.streamSimple(catalogModel, { messages: [] }).result();
  assert.equal(message.stopReason, "stop");
  assert.equal(url, "https://east.openai.azure.com/openai/v1/responses");
  assert.equal(deployment, "configured-deployment");
});
