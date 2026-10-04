import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantEvent, AssistantMessage, Context, Model, StreamOptions } from "@amazme/ai";
import { anthropicMessagesApi } from "@amazme/ai/api/anthropic-messages";
import { azureOpenAIResponsesApi } from "@amazme/ai/api/azure-openai-responses";
import { googleGenerativeAIApi } from "@amazme/ai/api/google-generative-ai";
import { googleVertexApi } from "@amazme/ai/api/google-vertex";
import { mistralConversationsApi } from "@amazme/ai/api/mistral-conversations";
import { openAICodexResponsesApi } from "@amazme/ai/api/openai-codex-responses";
import { openAIResponsesApi } from "@amazme/ai/api/openai-responses";
import { piMessagesApi } from "@amazme/ai/api/pi-messages";
import { checkAssistantStream } from "@amazme/ai/testing";

const CONTEXT = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };

function chatModel<TApi extends Model["api"]>(api: TApi, id = "recorded"): Model<TApi> {
  return {
    id,
    name: id,
    provider: "recorded",
    api,
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 1_000_000, output: 2_000_000 },
    reasoning: true,
  };
}

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textOf(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function thinkingOf(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "thinking").map((block) => block.thinking).join("");
}

const RESPONSES = [
  { type: "response.output_text.delta", delta: "Hi" },
  { type: "response.reasoning_text.delta", delta: "Think" },
  { type: "response.output_item.added", item: { type: "function_call", id: "call_1", call_id: "call_1", name: "read" } },
  { type: "response.function_call_arguments.delta", item_id: "call_1", delta: "{\"path\":\"a\"}" },
  { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
];

const GOOGLE = [{
  candidates: [{
    content: { parts: [{ text: "Hi" }, { text: "Think", thought: true }, { functionCall: { name: "read", args: { path: "a" } } }] },
    finishReason: "STOP",
  }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
}];

async function assertRecorded<TApi extends Model["api"]>(
  label: string,
  factory: (fetchImpl: typeof fetch) => { stream: (model: Model<TApi>, context: typeof CONTEXT, options?: StreamOptions) => AsyncIterable<AssistantEvent> & { result: () => Promise<AssistantMessage> } },
  recorded: Model<TApi>,
  events: unknown[],
  options: StreamOptions = {},
) {
  let calls = 0;
  let url = "";
  let body = "";
  const headers = new Headers();
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    url = String(input);
    body = String(init?.body ?? "");
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    return sse(events);
  };
  const stream = factory(fetchImpl).stream(recorded, CONTEXT, { apiKey: "recorded-key", baseUrl: "https://recorded.test/v1", ...options });
  const collected: AssistantEvent[] = [];
  for await (const event of stream) collected.push(event);
  const message = await stream.result();
  assert.deepEqual(checkAssistantStream(collected), [], label);
  assert.equal(calls, 1, label);
  assert.equal(textOf(message), "Hi", label);
  assert.equal(thinkingOf(message), "Think", label);
  const call = message.content.find((block) => block.type === "toolCall");
  assert.ok(call && call.type === "toolCall", label);
  assert.equal(call.name, "read", label);
  assert.deepEqual(call.arguments, { path: "a" }, label);
  assert.equal(message.stopReason, "toolUse", label);
  return { url, body, headers, message };
}

test("openai-responses maps recorded text, thinking, and tool calls", async () => {
  const seen = await assertRecorded("responses", (fetchImpl) => openAIResponsesApi({ fetch: fetchImpl }), chatModel("openai-responses"), RESPONSES);
  assert.equal(seen.url, "https://recorded.test/v1/responses");
  assert.equal(seen.headers.get("authorization"), "Bearer recorded-key");
  assert.equal(JSON.parse(seen.body).max_output_tokens, 1000);
});

test("azure-openai-responses uses the shared responses parser and its v1 deployment field", async () => {
  const seen = await assertRecorded(
    "azure",
    (fetchImpl) => azureOpenAIResponsesApi({ fetch: fetchImpl }),
    chatModel("azure-openai-responses", "deployment-a"),
    RESPONSES,
    { baseUrl: undefined, env: { AZURE_OPENAI_RESOURCE_NAME: "east", AZURE_OPENAI_DEPLOYMENT_NAME: "deployment-a" } },
  );
  assert.equal(seen.url, "https://east.openai.azure.com/openai/v1/responses");
  assert.equal(JSON.parse(seen.body).model, "deployment-a");
  assert.equal(seen.headers.get("api-key"), "recorded-key");
});

test("openai-codex-responses posts to the chatgpt backend", async () => {
  const seen = await assertRecorded(
    "codex",
    (fetchImpl) => openAICodexResponsesApi({ fetch: fetchImpl }),
    chatModel("openai-codex-responses"),
    RESPONSES,
    { baseUrl: "https://chatgpt.com/backend-api", env: { CHATGPT_ACCOUNT_ID: "acct" } },
  );
  assert.equal(seen.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(seen.headers.get("openai-beta"), "responses=experimental");
  assert.equal(seen.headers.get("chatgpt-account-id"), "acct");
});

test("anthropic-messages maps recorded text, thinking, and tool calls", async () => {
  const seen = await assertRecorded("anthropic", (fetchImpl) => anthropicMessagesApi({ fetch: fetchImpl }), chatModel("anthropic-messages"), [
    { type: "message_start", message: { usage: { input_tokens: 3 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Think" } },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_1", name: "read" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a\"}" } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
  ], { baseUrl: "https://api.anthropic.com" });
  assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen.headers.get("x-api-key"), "recorded-key");
  assert.equal(seen.message.usage.input, 3);
  assert.equal(seen.message.usage.output, 4);
});

test("google generative and vertex map recorded text, thinking, and tool calls", async () => {
  const generative = await assertRecorded("google", (fetchImpl) => googleGenerativeAIApi({ fetch: fetchImpl }), chatModel("google-generative-ai", "gemini"), GOOGLE);
  assert.match(generative.url, /\/models\/gemini:streamGenerateContent\?alt=sse$/);
  assert.equal(generative.headers.get("x-goog-api-key"), "recorded-key");
  const dir = mkdtempSync(join(tmpdir(), "amazme-adc-"));
  const file = join(dir, "adc.json");
  writeFileSync(file, JSON.stringify({ access_token: "adc-token", expiry: "2099-01-01T00:00:00.000Z" }));
  const vertex = await assertRecorded(
    "vertex",
    (fetchImpl) => googleVertexApi({ fetch: fetchImpl }),
    chatModel("google-vertex", "gemini"),
    GOOGLE,
    { apiKey: undefined, env: { GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: file }, baseUrl: "https://{location}-aiplatform.googleapis.com" },
  );
  assert.match(vertex.url, /\/v1\/projects\/proj\/locations\/us-central1\/publishers\/google\/models\/gemini:streamGenerateContent\?alt=sse$/);
  assert.equal(vertex.headers.get("authorization"), "Bearer adc-token");
  assert.equal(vertex.body.includes("adc-token"), false);
});

test("mistral conversations posts to chat completions and maps recorded chunks", async () => {
  const seen = await assertRecorded("mistral", (fetchImpl) => mistralConversationsApi({ fetch: fetchImpl }), chatModel("mistral-conversations"), [
    { choices: [{ delta: { content: [{ type: "text", text: "Hi" }, { type: "thinking", text: "Think" }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] } }] },
    { choices: [{ finish_reason: "tool_calls" }] },
    { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
  ], { baseUrl: "https://api.mistral.ai" });
  assert.equal(seen.url, "https://api.mistral.ai/v1/chat/completions");
});

test("pi-messages reads assistant events from the static radius wire", async () => {
  const seen = await assertRecorded("pi", (fetchImpl) => piMessagesApi({ fetch: fetchImpl }), chatModel("pi-messages"), [
    { type: "text_delta", contentIndex: 0, delta: "Hi" },
    { type: "thinking_delta", contentIndex: 1, delta: "Think" },
    { type: "toolcall_start", contentIndex: 2, id: "call_1", toolName: "read" },
    { type: "toolcall_delta", contentIndex: 2, delta: "{\"path\":\"a\"}" },
    { type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } } },
    { type: "done", reason: "toolUse", usage: { input: 3, output: 4, totalTokens: 7 } },
  ], { baseUrl: "https://radius.pi.dev/v1" });
  assert.equal(seen.url, "https://radius.pi.dev/v1/messages");
  const payload = JSON.parse(seen.body) as { model: string; options: { maxTokens: number } };
  assert.equal(payload.model, "recorded");
  assert.equal(payload.options.maxTokens, 1000);
  assert.equal(seen.body.includes("recorded-key"), false);
});

async function drive<TApi extends Model["api"]>(
  factory: (fetchImpl: typeof fetch) => { stream: (model: Model<TApi>, context: Context, options?: StreamOptions) => AsyncIterable<AssistantEvent> & { result: () => Promise<AssistantMessage> } },
  recorded: Model<TApi>,
  events: unknown[],
  options: StreamOptions = {},
  context: Context = CONTEXT,
) {
  let calls = 0;
  let body = "";
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    body = String(init?.body ?? "");
    return sse(events);
  };
  const stream = factory(fetchImpl).stream(recorded, context, { apiKey: "recorded-key", baseUrl: "https://recorded.test/v1", ...options });
  const collected: AssistantEvent[] = [];
  for await (const event of stream) collected.push(event);
  return { calls, body, collected, message: await stream.result() };
}

test("anthropic refuses a thinking budget that cannot fit under max_tokens", async () => {
  const recorded = { ...chatModel("anthropic-messages"), contextWindow: 32_000, maxTokens: 4_000 };
  const blocked = await drive((fetchImpl) => anthropicMessagesApi({ fetch: fetchImpl }), recorded, [], {
    baseUrl: "https://api.anthropic.com",
    thinkingLevel: "high",
    maxTokens: 100,
  });
  assert.equal(blocked.calls, 0);
  assert.equal(blocked.message.stopReason, "error");
  assert.match(blocked.message.errorMessage ?? "", /thinking budget/);
  const sent = await drive((fetchImpl) => anthropicMessagesApi({ fetch: fetchImpl }), recorded, [
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ], { baseUrl: "https://api.anthropic.com", thinkingLevel: "high", maxTokens: 2000 });
  const payload = JSON.parse(sent.body) as { max_tokens: number; thinking: { type: string; budget_tokens: number } };
  assert.equal(payload.max_tokens, 2000);
  assert.equal(payload.thinking.type, "enabled");
  assert.equal(payload.thinking.budget_tokens, 1999);
  assert.ok(payload.thinking.budget_tokens < payload.max_tokens);
});

test("anthropic refusal keeps text and does not close a tool call", async () => {
  const seen = await drive((fetchImpl) => anthropicMessagesApi({ fetch: fetchImpl }), chatModel("anthropic-messages"), [
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Keep" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "read" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a\"}" } },
    { type: "message_delta", delta: { stop_reason: "refusal" } },
  ], { baseUrl: "https://api.anthropic.com" });
  assert.deepEqual(checkAssistantStream(seen.collected), []);
  assert.equal(seen.message.stopReason, "error");
  assert.notEqual(seen.message.retryable, true);
  assert.equal(textOf(seen.message), "Keep");
  assert.match(seen.message.errorMessage ?? "", /refusal/);
  assert.equal(seen.collected.some((event) => event.type === "toolcall_end"), false);
});

test("responses content_filter is an error and max_output_tokens stays length", async () => {
  const filtered = await drive((fetchImpl) => openAIResponsesApi({ fetch: fetchImpl }), chatModel("openai-responses"), [
    { type: "response.output_text.delta", delta: "Keep" },
    { type: "response.output_item.added", item: { type: "function_call", id: "call_1", call_id: "call_1", name: "read" } },
    { type: "response.function_call_arguments.delta", item_id: "call_1", delta: "{\"path\":\"a\"}" },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } },
  ]);
  assert.deepEqual(checkAssistantStream(filtered.collected), []);
  assert.equal(filtered.message.stopReason, "error");
  assert.notEqual(filtered.message.retryable, true);
  assert.equal(textOf(filtered.message), "Keep");
  assert.match(filtered.message.errorMessage ?? "", /content_filter/);
  assert.equal(filtered.collected.some((event) => event.type === "toolcall_end"), false);
  const limited = await drive((fetchImpl) => openAIResponsesApi({ fetch: fetchImpl }), chatModel("openai-responses"), [
    { type: "response.output_text.delta", delta: "Hi" },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
  ]);
  assert.equal(limited.message.stopReason, "length");
  assert.equal(textOf(limited.message), "Hi");
});

test("google function calls from separate chunks stay separate, and safety is an error", async () => {
  const tools = await drive((fetchImpl) => googleGenerativeAIApi({ fetch: fetchImpl }), chatModel("google-generative-ai", "gemini"), [
    { candidates: [{ content: { parts: [{ functionCall: { name: "read", args: { path: "a" } } }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "read", args: { path: "b" } } }] }, finishReason: "STOP" }] },
  ]);
  assert.deepEqual(checkAssistantStream(tools.collected), []);
  assert.equal(tools.message.stopReason, "toolUse");
  const calls = tools.message.content.filter((block) => block.type === "toolCall");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.type === "toolCall" ? calls[0].arguments : undefined, { path: "a" });
  assert.deepEqual(calls[1]?.type === "toolCall" ? calls[1].arguments : undefined, { path: "b" });
  assert.notEqual(calls[0]?.type === "toolCall" ? calls[0].id : "", calls[1]?.type === "toolCall" ? calls[1].id : "");
  const safety = await drive((fetchImpl) => googleGenerativeAIApi({ fetch: fetchImpl }), chatModel("google-generative-ai", "gemini"), [{
    candidates: [{
      content: { parts: [{ text: "Keep" }, { functionCall: { name: "read", args: { path: "a" } } }] },
      finishReason: "SAFETY",
    }],
  }]);
  assert.deepEqual(checkAssistantStream(safety.collected), []);
  assert.equal(safety.message.stopReason, "error");
  assert.notEqual(safety.message.retryable, true);
  assert.equal(textOf(safety.message), "Keep");
  assert.match(safety.message.errorMessage ?? "", /SAFETY/);
  assert.equal(safety.collected.some((event) => event.type === "toolcall_end"), false);
  const limited = await drive((fetchImpl) => googleGenerativeAIApi({ fetch: fetchImpl }), chatModel("google-generative-ai", "gemini"), [{
    candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "MAX_TOKENS" }],
  }]);
  assert.equal(limited.message.stopReason, "length");
});

test("mistral sends an image url string once and does not treat content_filter as success", async () => {
  const recorded = { ...chatModel("mistral-conversations"), input: ["text" as const, "image" as const] };
  const seen = await drive((fetchImpl) => mistralConversationsApi({ fetch: fetchImpl }), recorded, [
    { choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] },
  ], { baseUrl: "https://api.mistral.ai" }, {
    systemPrompt: "be brief",
    messages: [
      { role: "system", content: "be brief", timestamp: 1 },
      { role: "user", content: [{ type: "image", mimeType: "image/png", data: "QUJD" }], timestamp: 2 },
    ],
  });
  assert.equal(seen.message.stopReason, "stop");
  const payload = JSON.parse(seen.body) as { messages: Array<{ role: string; content: unknown }> };
  assert.equal(payload.messages.filter((message) => message.role === "system").length, 1);
  assert.equal(payload.messages[0]?.content, "be brief");
  assert.deepEqual(payload.messages[1]?.content, [{ type: "image_url", image_url: "data:image/png;base64,QUJD" }]);
  const filtered = await drive((fetchImpl) => mistralConversationsApi({ fetch: fetchImpl }), chatModel("mistral-conversations"), [
    { choices: [{ delta: { content: "Keep" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] } }] },
    { choices: [{ finish_reason: "content_filter" }] },
  ], { baseUrl: "https://api.mistral.ai" });
  assert.deepEqual(checkAssistantStream(filtered.collected), []);
  assert.equal(filtered.message.stopReason, "error");
  assert.notEqual(filtered.message.retryable, true);
  assert.equal(textOf(filtered.message), "Keep");
  assert.match(filtered.message.errorMessage ?? "", /content_filter/);
  assert.equal(filtered.collected.some((event) => event.type === "toolcall_end"), false);
});
