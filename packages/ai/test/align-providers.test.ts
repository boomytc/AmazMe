import assert from "node:assert/strict";
import test from "node:test";
import { createModels, ModelsError } from "@amazme/ai";
import { builtinProviders } from "@amazme/ai/providers/builtin";
import { cloudflareWorkersAIProvider } from "@amazme/ai/providers/cloudflare-workers-ai";
import { openrouterProvider } from "@amazme/ai/providers/openrouter";
import { typesafeProvider } from "@amazme/ai/providers/typesafe";
const PI_CHAT = [
  "amazon-bedrock", "ant-ling", "anthropic", "azure-openai-responses", "baseten", "cerebras",
  "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks", "github-copilot",
  "google", "google-vertex", "groq", "huggingface", "kimi-coding", "meta", "minimax", "minimax-cn",
  "mistral", "moonshotai", "moonshotai-cn", "nvidia", "openai", "openai-codex", "opencode", "opencode-go",
  "openrouter", "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual", "radius", "together",
  "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp",
  "zai", "zai-coding-cn",
];

const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };

function sse(): Response {
  return new Response([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    "",
    'data: {"choices":[{"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n"), { status: 200 });
}

test("every Pi chat provider id is selectable, including cloudflare-workers-ai", () => {
  const ids = new Set(builtinProviders().map((provider) => provider.id));
  for (const id of PI_CHAT) {
    assert.equal(ids.has(id), true, id);
    const provider = builtinProviders().find((item) => item.id === id);
    assert.ok(provider?.getModels()[0], `${id} chat model`);
  }
  assert.equal(ids.has("typesafe"), true);
});

test("cloudflare-workers-ai posts chat completions to the account URL and classifies on /run", async () => {
  const seen: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    if (url.endsWith("/run")) {
      const sent = JSON.parse(String(init?.body)) as { input?: { questions?: { approved?: { type?: string } } } };
      const wireType = sent.input?.questions?.approved?.type;
      if (wireType === "noul" && seen.filter((call) => call.url.endsWith("/run")).length === 1) {
        return Response.json({
          success: true,
          result: { state: "Completed", result: { answers: { approved: { type: "noul", noul: 0.9 } } } },
        });
      }
      return Response.json({ success: true, result: { answers: { approved: { type: "noul", noul: 0.4 } } } });
    }
    return sse();
  };
  const models = createModels({ env: { CLOUDFLARE_API_KEY: "cf-key", CLOUDFLARE_ACCOUNT_ID: "acct" } });
  models.setProvider(cloudflareWorkersAIProvider({ fetch: fetchImpl }));
  const chat = models.getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");
  assert.ok(chat);
  const reply = await models.completeSimple(chat, context);
  assert.equal(reply.stopReason, "stop");
  assert.equal(seen[0]?.url, "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions");
  const classifier = models.getClassifier("cloudflare-workers-ai", "typesafe/jev");
  assert.ok(classifier);
  const questions = { state: { text: "ship it" }, questions: { approved: { type: "bool" as const, instructions: "approve?" } } };
  const completed = await models.classify(classifier, questions);
  assert.equal(completed.stopReason, "stop");
  assert.deepEqual(completed.answers.approved, { type: "bool", probability: 0.9 });
  const firstRun = JSON.parse(seen[1]?.body ?? "{}") as { input?: { questions?: { approved?: { type?: string } } } };
  assert.equal(firstRun.input?.questions?.approved?.type, "noul");
  assert.equal(seen[1]?.url, "https://api.cloudflare.com/client/v4/accounts/acct/ai/run");
  const direct = await models.classify(classifier, questions);
  assert.deepEqual(direct.answers.approved, { type: "bool", probability: 0.4 });
});

test("a classifier and an image model form a request, and missing credentials, an unknown provider, or a missing API do not", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { model?: string; questions?: { approved?: { type?: string } } };
    assert.equal(body.model, "jev-latest");
    assert.equal(body.questions?.approved?.type, "noul");
    assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
    return Response.json({ answers: { approved: { type: "noul", noul: 0.95 } } });
  };
  const questions = {
    state: { text: "ship it" },
    questions: { approved: { type: "bool", instructions: "approve?" } },
  };
  const models = createModels({ env: { TYPESAFE_API_KEY: "secret", OPENROUTER_API_KEY: "or-key" } });
  models.setProvider(typesafeProvider({ fetch: fetchImpl }));
  const classifier = models.getClassifier("typesafe", "jev-latest");
  assert.ok(classifier);
  const classified = await models.classify(classifier, questions);
  assert.equal(classified.stopReason, "stop");
  assert.deepEqual(classified.answers.approved, { type: "bool", probability: 0.95 });
  assert.equal(calls, 1);

  const bare = createModels({ env: {} });
  bare.setProvider(typesafeProvider({ fetch: fetchImpl }));
  const missingKey = bare.getClassifier("typesafe", "jev-latest");
  assert.ok(missingKey);
  await assert.rejects(() => bare.classify(missingKey, questions), (error: unknown) => error instanceof ModelsError && error.code === "auth");
  assert.equal(calls, 1);

  await assert.rejects(
    () => models.classify({ ...classifier, provider: "missing-provider" }, questions, { fetch: fetchImpl }),
    (error: unknown) => error instanceof ModelsError && error.code === "provider",
  );
  assert.equal(calls, 1);

  models.setProvider(typesafeProvider());
  const replaced = models.getClassifier("typesafe", "jev-latest");
  assert.ok(replaced);
  const missingApi = await models.classify({ ...replaced, api: "missing-api" }, questions, { fetch: fetchImpl });
  assert.equal(missingApi.stopReason, "error");
  assert.match(missingApi.errorMessage ?? "", /no classifier API/);
  assert.equal(calls, 1);

  const images: string[] = [];
  const imageFetch: typeof fetch = async (input, init) => {
    images.push(String(input));
    const body = JSON.parse(String(init?.body)) as { model?: string };
    assert.equal(body.model, "black-forest-labs/flux.2-pro");
    return Response.json({ choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,aGk=" } }] } }] });
  };
  const imageModels = createModels({ env: { OPENROUTER_API_KEY: "or-key" } });
  imageModels.setProvider(openrouterProvider({ fetch: imageFetch }));
  const image = imageModels.getImageModel("openrouter", "black-forest-labs/flux.2-pro");
  assert.ok(image);
  const generated = await imageModels.generateImages(image, { prompt: "a dot" });
  assert.equal(generated.stopReason, "stop");
  assert.deepEqual(generated.images, ["data:image/png;base64,aGk="]);
  assert.equal(images[0], "https://openrouter.ai/api/v1/chat/completions");

  const unkeyed = createModels({ env: {} });
  unkeyed.setProvider(openrouterProvider({ fetch: imageFetch }));
  const imageAgain = unkeyed.getImageModel("openrouter", "black-forest-labs/flux.2-pro");
  assert.ok(imageAgain);
  await assert.rejects(() => unkeyed.generateImages(imageAgain, { prompt: "a dot" }), (error: unknown) => error instanceof ModelsError);
  assert.equal(images.length, 1);

  const absent = await imageModels.generateImages({ ...image, api: "missing-images" }, { prompt: "a dot" }, { fetch: imageFetch });
  assert.equal(absent.stopReason, "error");
  assert.match(absent.errorMessage ?? "", /no image API/);
  assert.equal(images.length, 1);
});
