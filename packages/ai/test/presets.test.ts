import assert from "node:assert/strict";
import test from "node:test";
import { createModels } from "@amazme/ai";
import { builtinProviders } from "@amazme/ai/providers/builtin";
import { cloudflareAIGatewayProvider } from "@amazme/ai/providers/cloudflare-ai-gateway";
import { githubCopilotProvider } from "@amazme/ai/providers/github-copilot";
import { openaiProvider } from "@amazme/ai/providers/openai";
import { opencodeProvider } from "@amazme/ai/providers/opencode";

const COMPLETIONS = new Set([
  "ant-ling", "baseten", "cerebras", "deepseek", "groq", "huggingface", "moonshotai", "moonshotai-cn",
  "nvidia", "together", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp",
  "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual", "zai", "zai-coding-cn",
]);

const ALLOWED = new Set([
  "openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses",
  "anthropic-messages", "google-generative-ai", "google-vertex", "bedrock-converse-stream",
  "mistral-conversations", "pi-messages",
]);

test("builtin chat presets share one provider factory and the existing protocol set", () => {
  const providers = builtinProviders();
  assert.equal(new Set(providers.map((provider) => provider.id)).size, providers.length);
  assert.equal(providers.some((provider) => provider.id === "cloudflare-workers-ai"), false);
  assert.equal(providers.some((provider) => provider.id === "typesafe"), false);
  for (const provider of providers) {
    assert.equal("refreshModels" in provider, false, provider.id);
    for (const model of provider.getModels()) {
      assert.equal(ALLOWED.has(model.api), true, `${provider.id}/${model.id} ${model.api}`);
      assert.equal(model.provider, provider.id);
      assert.equal(Number.isInteger(model.contextWindow) && model.contextWindow > 0, true, model.id);
      assert.equal(Number.isInteger(model.maxTokens) && model.maxTokens > 0, true, model.id);
    }
  }
  const codex = providers.find((provider) => provider.id === "openai-codex");
  assert.ok(codex);
  assert.equal(codex.auth.apiKey, undefined);
  assert.ok(codex.auth.oauth);
  assert.equal(codex.baseUrl, "https://chatgpt.com/backend-api");
  assert.equal(codex.getModels().every((model) => model.api === "openai-codex-responses"), true);
  const radius = providers.find((provider) => provider.id === "radius");
  assert.ok(radius);
  assert.equal(radius.getModels().every((model) => model.api === "pi-messages"), true);
  const copilot = providers.find((provider) => provider.id === "github-copilot");
  assert.ok(copilot);
  assert.equal(new Set(copilot.getModels().map((model) => model.api)).size > 1, true);
  for (const id of COMPLETIONS) {
    const provider = providers.find((item) => item.id === id);
    assert.ok(provider, id);
    assert.equal(provider.getModels().every((model) => model.api === "openai-completions"), true, id);
  }
  const openai = providers.find((provider) => provider.id === "openai");
  assert.ok(openai?.auth.oauth);
  const mini = openai.getModels().find((model) => model.id === "gpt-4o-mini");
  assert.equal(mini?.api, "openai-completions");
  assert.deepEqual(mini?.input, ["text"]);
  assert.equal(mini?.contextWindow, 128_000);
  assert.equal(openai.getModels().some((model) => model.id !== "gpt-4o-mini" && model.api === "openai-responses"), true);
  const empty = createModels();
  assert.equal(empty.listModels().length, 0);
});

function completionsSse(): Response {
  return new Response([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    "",
    'data: {"choices":[{"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n"), { status: 200 });
}

test("gateway headers stay beside an existing protocol", async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return completionsSse();
  };
  const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
  const copilot = githubCopilotProvider({ fetch: fetchImpl });
  const copilotModel = copilot.getModels().find((model) => model.api === "openai-completions");
  assert.ok(copilotModel);
  const models = createModels({ env: { COPILOT_GITHUB_TOKEN: "tok" } });
  models.setProvider(copilot);
  await models.completeSimple(copilotModel, context);
  assert.equal(seen[0]?.headers.get("user-agent"), "GitHubCopilotChat/0.35.0");
  assert.equal(seen[0]?.headers.get("x-initiator"), "user");
  assert.equal(seen[0]?.headers.get("openai-intent"), "conversation-edits");
  assert.equal(seen[0]?.headers.get("authorization"), "Bearer tok");

  const cloudflare = cloudflareAIGatewayProvider({ fetch: fetchImpl });
  const cloudflareModel = cloudflare.getModels().find((model) => model.api === "openai-completions");
  assert.ok(cloudflareModel);
  models.setProvider(cloudflare);
  const cloudflareModels = createModels({
    env: { CLOUDFLARE_API_KEY: "cf", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_GATEWAY_ID: "gw" },
  });
  cloudflareModels.setProvider(cloudflare);
  await cloudflareModels.completeSimple(cloudflareModel, context);
  assert.match(seen[1]?.url ?? "", /\/acct\/gw\//);
  assert.equal(seen[1]?.url.includes("{CLOUDFLARE_ACCOUNT_ID}"), false);
  assert.equal(seen[1]?.headers.get("cf-aig-authorization"), "Bearer cf");

  const opencode = opencodeProvider({ fetch: fetchImpl });
  const opencodeModel = opencode.getModels().find((model) => model.api === "openai-completions");
  assert.ok(opencodeModel);
  const opencodeModels = createModels({ env: { OPENCODE_API_KEY: "zen" } });
  opencodeModels.setProvider(opencode);
  await opencodeModels.completeSimple(opencodeModel, context, { sessionId: "sess-1" });
  assert.equal(seen[2]?.headers.get("x-opencode-session"), "sess-1");
});

test("an explicit OpenAI constructor stays on completions", () => {
  const provider = openaiProvider({ modelIds: ["gpt-4o-mini"] });
  assert.equal(provider.getModels().length, 1);
  assert.equal(provider.getModels()[0]?.api, "openai-completions");
  assert.equal(provider.auth.oauth, undefined);
});
