import assert from "node:assert/strict";
import test from "node:test";
import type { Model, Usage } from "@amazme/ai";
import { anthropicMessagesApi } from "@amazme/ai/api/anthropic-messages";
import { encodeBedrockEvents } from "@amazme/ai/api/aws-event-stream";
import { bedrockConverseStreamApi } from "@amazme/ai/api/bedrock-converse-stream";
import { googleGenerativeAIApi } from "@amazme/ai/api/google-generative-ai";
import { mistralConversationsApi } from "@amazme/ai/api/mistral-conversations";
import { openaiCompletionsApi } from "@amazme/ai/api/openai-completions";
import { openAIResponsesApi } from "@amazme/ai/api/openai-responses";
import { piMessagesApi } from "@amazme/ai/api/pi-messages";
import { fauxAssistant, fauxProvider } from "@amazme/ai/providers/faux";

const CONTEXT = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };

function chatModel<TApi extends Model["api"]>(api: TApi): Model<TApi> {
  return {
    id: "recorded",
    name: "recorded",
    provider: "recorded",
    api,
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 0, output: 0 },
  };
}

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function assertCache(usage: Usage, cacheRead: number | undefined, cacheWrite: number | undefined): void {
  if (cacheRead === undefined) assert.equal(Object.hasOwn(usage, "cacheRead"), false);
  else assert.equal(usage.cacheRead, cacheRead);
  if (cacheWrite === undefined) assert.equal(Object.hasOwn(usage, "cacheWrite"), false);
  else assert.equal(usage.cacheWrite, cacheWrite);
}

async function settle(stream: { result: () => Promise<{ usage: Usage; stopReason: string }> }): Promise<Usage> {
  const message = await stream.result();
  assert.equal(message.stopReason, "stop");
  return message.usage;
}

function recordedFetch(body: Response): typeof fetch {
  return async () => body;
}

test("completions maps a reported cache read and leaves cache write unset", async () => {
  const model = chatModel("openai-completions");
  const stop = { choices: [{ finish_reason: "stop", delta: {} }] };
  const run = (events: unknown[]) => settle(openaiCompletionsApi({ fetch: recordedFetch(sse(events)) }).stream(model, CONTEXT, {
    apiKey: "recorded-key",
    baseUrl: "https://recorded.test/v1",
  }));
  const cached = await run([
    { choices: [{ delta: { content: "Hi" } }] },
    { ...stop, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 7 } } },
  ]);
  assertCache(cached, 7, undefined);
  assert.equal(cached.input, 10);

  const hit = await run([
    { choices: [{ delta: { content: "Hi" } }] },
    { ...stop, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } },
  ]);
  assertCache(hit, 4, undefined);

  const agreed = await run([
    { choices: [{ delta: { content: "Hi" } }] },
    { ...stop, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } },
  ]);
  assertCache(agreed, 0, undefined);

  const disagreed = await run([
    { choices: [{ delta: { content: "Hi" } }] },
    { ...stop, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 4, prompt_tokens_details: { cached_tokens: 9 } } },
  ]);
  assertCache(disagreed, undefined, undefined);

  const absent = await run([
    { choices: [{ delta: { content: "Hi" } }] },
    { ...stop, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ]);
  assertCache(absent, undefined, undefined);
});

const OPTIONS = { apiKey: "recorded-key", baseUrl: "https://recorded.test/v1" };

test("responses, anthropic, google, bedrock, and pi map only cache counts they return", async () => {
  const responses = await settle(openAIResponsesApi({
    fetch: recordedFetch(sse([
      { type: "response.output_text.delta", delta: "Hi" },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10, input_tokens_details: { cached_tokens: 5 } } } },
    ])),
  }).stream(chatModel("openai-responses"), CONTEXT, OPTIONS));
  assertCache(responses, 5, undefined);

  const responsesBare = await settle(openAIResponsesApi({
    fetch: recordedFetch(sse([
      { type: "response.output_text.delta", delta: "Hi" },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } } },
    ])),
  }).stream(chatModel("openai-responses"), CONTEXT, OPTIONS));
  assertCache(responsesBare, undefined, undefined);

  const anthropic = await settle(anthropicMessagesApi({
    fetch: recordedFetch(sse([
      { type: "message_start", message: { usage: { input_tokens: 9, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ])),
  }).stream(chatModel("anthropic-messages"), CONTEXT, OPTIONS));
  assert.equal(anthropic.input, 9);
  assert.equal(anthropic.output, 1);
  assertCache(anthropic, 6, 2);

  const anthropicBare = await settle(anthropicMessagesApi({
    fetch: recordedFetch(sse([
      { type: "message_start", message: { usage: { input_tokens: 3 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ])),
  }).stream(chatModel("anthropic-messages"), CONTEXT, OPTIONS));
  assertCache(anthropicBare, undefined, undefined);

  const google = await settle(googleGenerativeAIApi({
    fetch: recordedFetch(sse([{
      candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10, cachedContentTokenCount: 3 },
    }])),
  }).stream(chatModel("google-generative-ai"), CONTEXT, OPTIONS));
  assertCache(google, 3, undefined);

  const frames = encodeBedrockEvents([
    { type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { text: "Hi" } } },
    { type: "metadata", body: { usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10, cacheReadInputTokens: 4, cacheWriteInputTokens: 1 } } },
    { type: "messageStop", body: { stopReason: "end_turn" } },
  ]);
  const bedrock = await settle(bedrockConverseStreamApi({
    fetch: recordedFetch(new Response(frames, { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } })),
  }).stream(chatModel("bedrock-converse-stream"), CONTEXT, OPTIONS));
  assertCache(bedrock, 4, 1);

  const pi = await settle(piMessagesApi({
    fetch: recordedFetch(sse([
      { type: "text_delta", contentIndex: 0, delta: "Hi" },
      { type: "done", reason: "stop", usage: { input: 8, output: 2, totalTokens: 10, cacheRead: 5, cacheWrite: 0 } },
    ])),
  }).stream(chatModel("pi-messages"), CONTEXT, OPTIONS));
  assertCache(pi, 5, 0);

  const mistral = await settle(mistralConversationsApi({
    fetch: recordedFetch(sse([
      { choices: [{ delta: { content: [{ type: "text", text: "Hi" }] }, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
    ])),
  }).stream(chatModel("mistral-conversations"), CONTEXT, OPTIONS));
  assertCache(mistral, undefined, undefined);
});

test("a faux response can carry cache counts, and the default usage leaves them unset", async () => {
  const filled = fauxProvider({
    respond: () => fauxAssistant("ok", {
      usage: { input: 4, output: 2, totalTokens: 6, cost: { input: 0, output: 0, total: 0 }, cacheRead: 3, cacheWrite: 1 },
    }),
  });
  const filledModel = filled.getModels()[0];
  assert.ok(filledModel);
  const carried = await filled.streamSimple(filledModel, CONTEXT, { apiKey: "k" }).result();
  assertCache(carried.usage, 3, 1);

  const plain = fauxProvider();
  const plainModel = plain.getModels()[0];
  assert.ok(plainModel);
  const empty = await plain.streamSimple(plainModel, CONTEXT).result();
  assertCache(empty.usage, undefined, undefined);
});
