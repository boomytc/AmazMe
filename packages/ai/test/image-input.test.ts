import assert from "node:assert/strict";
import test from "node:test";
import { createModels, imageInputRefusal, type UserContent } from "@amazme/ai";
import { deepseekProvider } from "@amazme/ai/providers/deepseek";
import { completionsProvider } from "@amazme/ai/providers/completions";

const PNG = "aaaa";

function imageContent(text = "look "): UserContent[] {
  return [
    { type: "text", text },
    { type: "image", mimeType: "image/png", data: PNG },
  ];
}

function sseStop(): Response {
  const encoder = new TextEncoder();
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "seen" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function userParts(body: string | undefined): unknown {
  const parsed: unknown = JSON.parse(body ?? "{}");
  if (!parsed || typeof parsed !== "object") return undefined;
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return undefined;
  const user = messages.find((item) => item && typeof item === "object" && (item as { role?: string }).role === "user");
  return user && typeof user === "object" ? (user as { content?: unknown }).content : undefined;
}

test("a vision model sends ImageContent when the input contains an image", async () => {
  let calls = 0;
  let body = "";
  const models = createModels({ env: { COMPAT_KEY: "sk-test" } });
  models.setProvider(completionsProvider({
    id: "compat",
    name: "compat",
    baseUrl: "https://example.test/v1",
    env: "COMPAT_KEY",
    modelIds: ["see"],
    models: { see: { contextWindow: 8000, maxTokens: 256, input: ["text", "image"] } },
    fetch: async (_input, init) => {
      calls += 1;
      body = String(init?.body ?? "");
      return sseStop();
    },
  }));
  const model = models.getModel("compat", "see");
  assert.ok(model);
  const content = imageContent();
  assert.equal(content.some((block) => block.type === "image"), true);
  assert.equal(imageInputRefusal(model, content), undefined);
  const result = await models.stream(model, {
    messages: [{ role: "user", content, timestamp: 1 }],
  }).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(calls, 1);
  assert.deepEqual(userParts(body), [
    { type: "text", text: "look " },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
  ]);
});

// Catalog input is text only. Refusal follows model.input. Do not reject by model id,
// and do not rewrite flash input in a fixture. Restoring image on deepseek-flash fails this test.
test("deepseek-flash and deepseek-v4-pro reject a new image before any request", async () => {
  let calls = 0;
  const models = createModels({ env: { DEEPSEEK_API_KEY: "sk-test" } });
  models.setProvider(deepseekProvider({
    fetch: async () => {
      calls += 1;
      throw new Error("fetch should not run");
    },
  }));
  const flash = models.getModel("deepseek", "deepseek-flash");
  const pro = models.getModel("deepseek", "deepseek-v4-pro");
  assert.ok(flash);
  assert.ok(pro);
  assert.deepEqual(flash.input, ["text"]);
  assert.deepEqual(pro.input, ["text"]);
  const content = imageContent("look ");
  assert.equal(imageInputRefusal(flash, content), "Model deepseek-flash does not accept image input");
  assert.equal(imageInputRefusal(pro, content), "Model deepseek-v4-pro does not accept image input");
  const flashResult = await models.stream(flash, {
    messages: [{ role: "user", content, timestamp: 1 }],
  }).result();
  assert.equal(calls, 0);
  assert.equal(flashResult.stopReason, "error");
  assert.equal(flashResult.errorMessage, "Model deepseek-flash does not accept image input");
  assert.notEqual(flashResult.retryable, true);
  const proResult = await models.stream(pro, {
    messages: [{ role: "user", content, timestamp: 2 }],
  }).result();
  assert.equal(calls, 0);
  assert.equal(proResult.stopReason, "error");
  assert.equal(proResult.errorMessage, "Model deepseek-v4-pro does not accept image input");
  assert.notEqual(proResult.retryable, true);
});

test("a text turn on deepseek-flash replaces an earlier image with [image]", async () => {
  let calls = 0;
  const bodies: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    bodies.push(String(init?.body ?? ""));
    return sseStop();
  };
  const models = createModels({ env: { DEEPSEEK_API_KEY: "sk-test", COMPAT_KEY: "sk-test" } });
  models.setProvider(completionsProvider({
    id: "compat",
    name: "compat",
    baseUrl: "https://example.test/v1",
    env: "COMPAT_KEY",
    modelIds: ["see"],
    models: { see: { contextWindow: 8000, maxTokens: 256, input: ["text", "image"] } },
    fetch: fetchImpl,
  }));
  models.setProvider(deepseekProvider({ fetch: fetchImpl }));
  const see = models.getModel("compat", "see");
  const flash = models.getModel("deepseek", "deepseek-flash");
  assert.ok(see);
  assert.ok(flash);
  assert.deepEqual(flash.input, ["text"]);
  const content = imageContent();
  const seen = await models.stream(see, {
    messages: [{ role: "user", content, timestamp: 1 }],
  }).result();
  assert.equal(seen.stopReason, "stop");
  assert.equal(calls, 1);
  assert.equal(bodies[0]?.includes("image_url"), true);
  assert.equal(bodies[0]?.includes(PNG), true);

  const next = await models.stream(flash, {
    messages: [
      { role: "user", content, timestamp: 1 },
      seen,
      { role: "user", content: "next", timestamp: 3 },
    ],
  }).result();
  assert.equal(next.stopReason, "stop");
  assert.equal(calls, 2);
  const sent = bodies[1] ?? "";
  assert.equal(sent.includes("image_url"), false);
  assert.equal(sent.includes(PNG), false);
  assert.equal(sent.includes("[image]"), true);
  const users = chatUsers(sent);
  assert.deepEqual(users[0], [
    { type: "text", text: "look " },
    { type: "text", text: "[image]" },
  ]);
  assert.equal(users[1], "next");

  const again = await models.stream(flash, {
    messages: [
      { role: "user", content, timestamp: 1 },
      seen,
      { role: "user", content: imageContent("again "), timestamp: 4 },
    ],
  }).result();
  assert.equal(calls, 2);
  assert.equal(again.stopReason, "error");
  assert.equal(again.errorMessage, "Model deepseek-flash does not accept image input");
});

function chatUsers(body: string): unknown[] {
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object") return [];
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((item) => {
    if (!item || typeof item !== "object" || (item as { role?: string }).role !== "user") return [];
    return [(item as { content?: unknown }).content];
  });
}
