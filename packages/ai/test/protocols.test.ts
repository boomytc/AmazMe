import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantEvent, AssistantMessage, Model, StreamOptions } from "@amazme/ai";
import { anthropicMessagesApi } from "@amazme/ai/api/anthropic-messages";
import { azureOpenAIResponsesApi } from "@amazme/ai/api/azure-openai-responses";
import { bedrockConverseStreamApi } from "@amazme/ai/api/bedrock-converse-stream";
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

test("azure-openai-responses uses the shared responses parser and its own deployment URL", async () => {
  const seen = await assertRecorded(
    "azure",
    (fetchImpl) => azureOpenAIResponsesApi({ fetch: fetchImpl }),
    chatModel("azure-openai-responses", "deployment-a"),
    RESPONSES,
    { baseUrl: undefined, env: { AZURE_OPENAI_RESOURCE_NAME: "east", AZURE_OPENAI_DEPLOYMENT_NAME: "deployment-a" } },
  );
  assert.match(seen.url, /^https:\/\/east\.openai\.azure\.com\/openai\/deployments\/deployment-a\/responses\?api-version=/);
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
});

test("google generative and vertex map recorded text, thinking, and tool calls", async () => {
  const generative = await assertRecorded("google", (fetchImpl) => googleGenerativeAIApi({ fetch: fetchImpl }), chatModel("google-generative-ai", "gemini"), GOOGLE);
  assert.match(generative.url, /\/models\/gemini:streamGenerateContent\?alt=sse$/);
  assert.equal(generative.headers.get("x-goog-api-key"), "recorded-key");
  const dir = mkdtempSync(join(tmpdir(), "amazme-adc-"));
  const file = join(dir, "adc.json");
  writeFileSync(file, JSON.stringify({ access_token: "adc-token" }));
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

test("bedrock converse stream maps recorded JSON events without the AWS SDK", async () => {
  const seen = await assertRecorded("bedrock", (fetchImpl) => bedrockConverseStreamApi({ fetch: fetchImpl }), chatModel("bedrock-converse-stream", "amazon.nova"), [
    { contentBlockDelta: { delta: { text: "Hi" } } },
    { contentBlockDelta: { delta: { reasoningContent: { text: "Think" } } } },
    { contentBlockStart: { start: { toolUse: { toolUseId: "call_1", name: "read" } } } },
    { contentBlockDelta: { delta: { toolUse: { input: "{\"path\":\"a\"}" } } } },
    { messageStop: { stopReason: "tool_use" } },
    { metadata: { usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } } },
  ]);
  assert.equal(seen.url, "https://recorded.test/v1/model/amazon.nova/converse-stream");
  assert.equal(seen.message.usage.totalTokens, 7);
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
    { type: "done", reason: "toolUse", usage: { input: 3, output: 4, totalTokens: 7 } },
  ], { baseUrl: "https://radius.pi.dev/v1" });
  assert.equal(seen.url, "https://radius.pi.dev/v1/messages");
  const payload = JSON.parse(seen.body) as { model: string; options: { maxTokens: number } };
  assert.equal(payload.model, "recorded");
  assert.equal(payload.options.maxTokens, 1000);
  assert.equal(seen.body.includes("recorded-key"), false);
});
