import assert from "node:assert/strict";
import test from "node:test";
import { createModels, createProvider, type AssistantEvent, type AssistantMessage, type Model } from "@amazme/ai";
import { openaiCompletionsApi } from "@amazme/ai/api/openai-completions";
import { readSse } from "@amazme/ai/api/prepare";
import { checkAssistantStream } from "@amazme/ai/testing";

const CONTEXT = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
const KEEPALIVE = ": keep-alive\n\n: keep-alive\n\n";

function model(): Model<"openai-completions"> {
  return {
    id: "gpt-4o-mini",
    name: "gpt-4o-mini",
    provider: "openai",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0, output: 0 },
  };
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function byteResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function shape(events: readonly AssistantEvent[]): unknown {
  return JSON.parse(JSON.stringify(events, (key, value) => key === "timestamp" ? undefined : value)) as unknown;
}

async function collect(body: Response, onActivity?: () => void): Promise<{ message: AssistantMessage; events: AssistantEvent[] }> {
  const api = openaiCompletionsApi({ fetch: async () => body });
  const stream = api.streamSimple(model(), CONTEXT, {
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
    ...(onActivity ? { onActivity } : {}),
  });
  const events: AssistantEvent[] = [];
  const finished = (async () => {
    for await (const event of stream) events.push(event);
  })();
  const message = await Promise.race([
    stream.result(),
    new Promise<AssistantMessage>((_, reject) => setTimeout(() => reject(new Error("result hung")), 1000)),
  ]);
  await finished;
  assert.deepEqual(checkAssistantStream(events), []);
  return { message, events };
}

test("comment keep-alives call onActivity once per line and add no deltas", async () => {
  let activity = 0;
  const signaled = await collect(sseResponse([KEEPALIVE]), () => { activity += 1; });
  assert.equal(activity, 4);
  assert.deepEqual(signaled.events.map((event) => event.type), ["start", "error"]);
  assert.equal(signaled.events.some((event) => event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta"), false);

  const omitted = await collect(sseResponse([KEEPALIVE]));
  assert.deepEqual(shape(signaled.events), shape(omitted.events));
  assert.equal(omitted.message.stopReason, "error");
  assert.equal(omitted.message.retryable, true);
  assert.match(omitted.message.errorMessage ?? "", /ended without a finish reason/);
});

test("a keep-alive split one byte at a time still signals each complete line", async () => {
  let activity = 0;
  const split = await collect(byteResponse(KEEPALIVE), () => { activity += 1; });
  const omitted = await collect(sseResponse([KEEPALIVE]));
  assert.equal(activity, 4);
  assert.deepEqual(shape(split.events), shape(omitted.events));
});

test("omitting onActivity leaves a completions stream with the same events", async () => {
  const chunks = [
    ": keep-alive\n\n",
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    "\n",
    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  let activity = 0;
  const signaled = await collect(sseResponse(chunks), () => { activity += 1; });
  const omitted = await collect(sseResponse(chunks));
  // keep-alive + blank, Hi + blank, one blank, reasoning + blank, finish + blank, [DONE] + blank.
  assert.equal(activity, 11);
  assert.equal(signaled.message.stopReason, "stop");
  assert.equal(omitted.message.stopReason, "stop");
  assert.deepEqual(shape(signaled.events), shape(omitted.events));
  assert.equal(signaled.message.content.some((block) => block.type === "text" && block.text === "Hi"), true);
  assert.equal(signaled.message.content.some((block) => block.type === "thinking" && block.thinking === "think"), true);
});

test("streamSimple forwards onActivity through the registry", async () => {
  let activity = 0;
  const active = model();
  const models = createModels({ env: { OPENAI_API_KEY: "sk-test" } });
  models.setProvider(createProvider({
    id: "openai",
    baseUrl: "https://example.test/v1",
    auth: { env: "OPENAI_API_KEY" },
    models: [active],
    api: openaiCompletionsApi({ fetch: async () => sseResponse([KEEPALIVE]) }),
  }));
  const message = await models.streamSimple(active, CONTEXT, { onActivity: () => { activity += 1; } }).result();
  assert.equal(activity, 4);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /ended without a finish reason/);
});

test("readSse signals comment and blank lines without emitting events for them", async () => {
  const comments: Array<{ event?: string; data: string }> = [];
  let commentActivity = 0;
  await readSse(new Response(KEEPALIVE), undefined, (event) => comments.push(event), () => { commentActivity += 1; });
  const omittedComments: Array<{ event?: string; data: string }> = [];
  await readSse(new Response(KEEPALIVE), undefined, (event) => omittedComments.push(event));
  assert.equal(commentActivity, 4);
  assert.deepEqual(comments, []);
  assert.deepEqual(omittedComments, comments);

  const body = `: keep-alive\n\ndata: ${JSON.stringify({ text: "Hi" })}\n\n`;
  const signaled: Array<{ event?: string; data: string }> = [];
  let activity = 0;
  await readSse(new Response(body), undefined, (event) => signaled.push(event), () => { activity += 1; });
  const omitted: Array<{ event?: string; data: string }> = [];
  await readSse(new Response(body), undefined, (event) => omitted.push(event));
  assert.equal(activity, 4);
  assert.deepEqual(signaled, omitted);
  assert.equal(signaled.length, 1);
  assert.equal(JSON.parse(signaled[0]?.data ?? "{}").text, "Hi");
});
