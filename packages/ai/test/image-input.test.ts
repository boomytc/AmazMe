import assert from "node:assert/strict";
import test from "node:test";
import { createModels, imageInputRefusal, parseAtMentions, pastedImageMention, userContentFromParts, type UserContent } from "@amazme/ai";
import { deepseekProvider } from "@amazme/ai/providers/deepseek";
import { completionsProvider } from "@amazme/ai/providers/completions";

const PNG = "aaaa";

function imageContent(text = "look @shot.png"): UserContent[] {
  return userContentFromParts(parseAtMentions(text), new Map([["shot.png", { mimeType: "image/png", data: PNG }]]));
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

test("the @ scanner attaches only image extensions and leaves every other mention as text", () => {
  assert.deepEqual(parseAtMentions("see @readme.md and @shot.PNG."), [
    { kind: "text", text: "see @readme.md and " },
    { kind: "image", path: "shot.PNG", raw: "@shot.PNG" },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(parseAtMentions("user@x.png @notes.txt @a.jpeg @b.gif @c.webp @d.bmp"), [
    { kind: "text", text: "user@x.png @notes.txt " },
    { kind: "image", path: "a.jpeg", raw: "@a.jpeg" },
    { kind: "text", text: " " },
    { kind: "image", path: "b.gif", raw: "@b.gif" },
    { kind: "text", text: " " },
    { kind: "image", path: "c.webp", raw: "@c.webp" },
    { kind: "text", text: " @d.bmp" },
  ]);
  assert.deepEqual(parseAtMentions("plain"), [{ kind: "text", text: "plain" }]);
  assert.equal(pastedImageMention("  ./pic.jpg  "), "@./pic.jpg");
  assert.equal(pastedImageMention("@shot.png"), "@shot.png");
  assert.equal(pastedImageMention("notes.md"), undefined);
  assert.equal(pastedImageMention("see @shot.png"), undefined);
  assert.equal(pastedImageMention("\"my photo.png\""), "@\"my photo.png\"");
});

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

test("deepseek-flash rejects image input before any request", async () => {
  let calls = 0;
  const models = createModels({ env: { DEEPSEEK_API_KEY: "sk-test" } });
  models.setProvider(deepseekProvider({
    fetch: async () => {
      calls += 1;
      throw new Error("fetch should not run");
    },
  }));
  const published = models.getModel("deepseek", "deepseek-flash");
  assert.ok(published);
  const flash = { ...published, input: ["text"] as Array<"text" | "image"> };
  const content = imageContent("look @shot.png");
  assert.equal(imageInputRefusal(flash, content), "Model deepseek-flash does not accept image input");
  const result = await models.stream(flash, {
    messages: [{ role: "user", content, timestamp: 1 }],
  }).result();
  assert.equal(calls, 0);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Model deepseek-flash does not accept image input");
  assert.notEqual(result.retryable, true);
});
