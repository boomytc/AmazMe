import assert from "node:assert/strict";
import test from "node:test";
import type { Context, JsonSchema, Model } from "@amazme/ai";
import { fauxAssistant, fauxToolCall } from "@amazme/ai/providers/faux";
import { anthropicMessagesApi } from "@amazme/ai/api/anthropic-messages";
import { googleGenerativeAIApi } from "@amazme/ai/api/google-generative-ai";
import { mistralConversationsApi } from "@amazme/ai/api/mistral-conversations";
import { openaiCompletionsApi } from "@amazme/ai/api/openai-completions";
import { openAIResponsesApi } from "@amazme/ai/api/openai-responses";

const PNG = "QUJD";

function model<TApi extends Model["api"]>(api: TApi, vision: boolean): Model<TApi> {
  return {
    id: "recorded",
    name: "recorded",
    provider: "recorded",
    api,
    input: vision ? ["text", "image"] : ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 0, output: 0 },
  };
}

function context(data = PNG): Context {
  return {
    messages: [
      { role: "user", content: "hi", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "shot",
        isError: false,
        timestamp: 2,
        content: [
          { type: "text", text: "cap" },
          { type: "image", mimeType: "image/png", data },
        ],
      },
    ],
  };
}

async function capture(
  start: (fetchImpl: typeof fetch) => AsyncIterable<unknown>,
  events: unknown[],
  done = false,
): Promise<{ calls: number; body: unknown }> {
  let calls = 0;
  let raw = "";
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    raw = String(init?.body ?? "");
    const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  for await (const event of start(fetchImpl)) void event;
  return { calls, body: raw.length > 0 ? JSON.parse(raw) as unknown : undefined };
}

const request = { apiKey: "test-key", baseUrl: "https://recorded.test" };

const COMPLETIONS_STOP = [
  { choices: [{ delta: { content: "ok" } }] },
  { choices: [{ finish_reason: "stop" }] },
];
const RESPONSES_STOP = [
  { type: "response.output_text.delta", delta: "ok" },
  { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
];
const ANTHROPIC_STOP = [
  { type: "message_start", message: { usage: { input_tokens: 1 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
];
const GOOGLE_STOP = [{
  candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
}];
const MISTRAL_STOP = [
  { choices: [{ delta: { content: "ok" } }] },
  { choices: [{ finish_reason: "stop" }] },
  { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
];

test("vision providers project tool images onto their protocol's supported content roles", async () => {
  const source = context();
  const before = JSON.stringify(source);
  const completions = await capture(
    (fetchImpl) => openaiCompletionsApi({ fetch: fetchImpl }).stream(model("openai-completions", true), source, request),
    COMPLETIONS_STOP,
    true,
  );
  const completionsMessages = (completions.body as { messages: Array<{ role: string; content: unknown }> }).messages;
  const completionsTool = completionsMessages.find((message) => message.role === "tool");
  assert.equal(completionsTool?.content, "cap");
  assert.deepEqual(completionsMessages.at(-1), { role: "user", content: [
    { type: "text", text: "Images from tool shot (call call_1):" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
  ] });

  const responses = await capture(
    (fetchImpl) => openAIResponsesApi({ fetch: fetchImpl }).stream(model("openai-responses", true), source, request),
    RESPONSES_STOP,
  );
  const input = (responses.body as { input: Array<{ type?: string; output?: unknown }> }).input;
  const output = input.find((item) => item.type === "function_call_output");
  assert.deepEqual(output?.output, [
    { type: "input_text", text: "cap" },
    { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
  ]);

  const anthropic = await capture(
    (fetchImpl) => anthropicMessagesApi({ fetch: fetchImpl }).stream(model("anthropic-messages", true), source, request),
    ANTHROPIC_STOP,
  );
  const anthropicMessages = (anthropic.body as { messages: Array<{ content: Array<{ type?: string; content?: unknown }> }> }).messages;
  const toolResult = anthropicMessages.flatMap((message) => message.content).find((block) => block.type === "tool_result");
  assert.deepEqual(toolResult?.content, [
    { type: "text", text: "cap" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
  ]);

  const google = await capture(
    (fetchImpl) => googleGenerativeAIApi({ fetch: fetchImpl }).stream({ ...model("google-generative-ai", true), id: "gemini-3-flash" }, source, request),
    GOOGLE_STOP,
  );
  const contents = (google.body as { contents: Array<{ parts: Array<{ functionResponse?: { response: { result: string }; parts?: unknown[] } }> }> }).contents;
  const response = contents.flatMap((item) => item.parts).find((part) => part.functionResponse)?.functionResponse;
  assert.equal(response?.response.result, "cap");
  assert.deepEqual(response?.parts, [{ inlineData: { mimeType: "image/png", data: PNG } }]);

  const mistral = await capture(
    (fetchImpl) => mistralConversationsApi({ fetch: fetchImpl }).stream(model("mistral-conversations", true), source, request),
    MISTRAL_STOP,
  );
  const mistralMessages = (mistral.body as { messages: Array<{ role: string; content: unknown }> }).messages;
  const mistralTool = mistralMessages.find((message) => message.role === "tool");
  assert.deepEqual(mistralTool?.content, [
    { type: "text", text: "cap" },
    { type: "image_url", image_url: `data:image/png;base64,${PNG}` },
  ]);
  assert.equal(JSON.stringify(source), before);
});

test("a text model sends the tool-image placeholder and a bad tool image is not fetched", async () => {
  const source = context();
  const text = await capture(
    (fetchImpl) => openaiCompletionsApi({ fetch: fetchImpl }).stream(model("openai-completions", false), source, request),
    COMPLETIONS_STOP,
    true,
  );
  const messages = (text.body as { messages: Array<{ role: string; content: unknown }> }).messages;
  const tool = messages.find((message) => message.role === "tool");
  assert.equal(tool?.content, "cap(tool image omitted: model does not support images)");
  assert.equal(JSON.stringify(text.body).includes(PNG), false);

  let calls = 0;
  const broken = context("not valid!");
  const stream = openaiCompletionsApi({
    fetch: async () => {
      calls += 1;
      return new Response("", { status: 200 });
    },
  }).stream(model("openai-completions", true), broken, { apiKey: "test-key", baseUrl: "https://recorded.test" });
  const events = [];
  for await (const event of stream) events.push(event);
  const message = await stream.result();
  assert.equal(calls, 0);
  assert.equal(message.stopReason, "error");
  assert.equal((message.errorMessage ?? "").includes("not valid!"), false);
  assert.match(message.errorMessage ?? "", /base64 data/);

  const anthropic = anthropicMessagesApi({
    fetch: async () => {
      calls += 1;
      return new Response("", { status: 200 });
    },
  }).stream(model("anthropic-messages", true), broken, { apiKey: "test-key", baseUrl: "https://recorded.test" });
  for await (const event of anthropic) void event;
  const rejected = await anthropic.result();
  assert.equal(calls, 0);
  assert.equal(rejected.stopReason, "error");
  assert.equal((rejected.errorMessage ?? "").includes("not valid!"), false);
  assert.match(rejected.errorMessage ?? "", /base64 data/);
});

test("completions attaches tool images after every real and synthesized result in the batch", async () => {
  const source = context();
  const result = source.messages[1];
  assert.ok(result?.role === "toolResult");
  result.content = [{ type: "image", mimeType: "image/png", data: PNG }];
  source.messages.splice(1, 0, fauxAssistant([
    fauxToolCall("shot", {}, "call_1"),
    fauxToolCall("missing", {}, "call_2"),
  ]));
  source.messages.push({ role: "user", content: "next", timestamp: 3 });
  const before = JSON.stringify(source);
  const captured = await capture(
    (fetchImpl) => openaiCompletionsApi({ fetch: fetchImpl }).stream(model("openai-completions", true), source, request),
    COMPLETIONS_STOP,
    true,
  );
  const messages = (captured.body as { messages: Array<{ role: string; content: unknown; tool_call_id?: string }> }).messages;
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "tool", "user", "user"]);
  assert.equal(messages[2]?.content, "(see attached image)");
  assert.equal(messages[2]?.tool_call_id, "call_1");
  assert.equal(messages[3]?.tool_call_id, "call_2");
  assert.equal(messages[3]?.content, "No tool result was recorded");
  assert.deepEqual(messages[4]?.content, [
    { type: "text", text: "Images from tool shot (call call_1):" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
  ]);
  assert.equal(messages[5]?.content, "next");
  assert.equal(JSON.stringify(source), before);
});

test("Google groups parallel function results and attaches images outside responses on older and aliased models", async () => {
  for (const id of ["gemini-2.5-pro", "custom-vision-alias", "gemini-3-flash"]) {
    const source = context();
    const result = source.messages[1];
    assert.ok(result?.role === "toolResult");
    source.messages.splice(1, 0, fauxAssistant([
      fauxToolCall("shot", {}, "call_1"), fauxToolCall("missing", {}, "call_2"),
    ]));
    const before = JSON.stringify(source);
    const captured = await capture(
      (fetchImpl) => googleGenerativeAIApi({ fetch: fetchImpl }).stream({ ...model("google-generative-ai", true), id }, source, request),
      GOOGLE_STOP,
    );
    type Part = { functionResponse?: { id: string; parts?: unknown[] }; inlineData?: unknown };
    const contents = (captured.body as { contents: Array<{ role: string; parts: Part[] }> }).contents;
    const responses = contents[2];
    assert.equal(responses?.role, "user");
    assert.deepEqual(responses?.parts.map((part) => part.functionResponse?.id), ["call_1", "call_2"]);
    if (id.startsWith("gemini-3")) {
      assert.equal(contents.length, 3);
      assert.deepEqual(responses?.parts[0]?.functionResponse?.parts, [{ inlineData: { mimeType: "image/png", data: PNG } }]);
    } else {
      assert.equal(contents.length, 4);
      assert.equal(responses?.parts[0]?.functionResponse?.parts, undefined);
      assert.deepEqual(contents[3]?.parts, [
        { text: "Images from tool shot (call call_1):" },
        { inlineData: { mimeType: "image/png", data: PNG } },
      ]);
    }
    assert.equal(JSON.stringify(source), before);
  }
});

test("Google sends extended MCP JSON Schema through parametersJsonSchema", async () => {
  const schema: JsonSchema = {
    type: "object" as const,
    $defs: { kind: { type: "string", enum: ["a", "b"] } },
    properties: { kind: { $ref: "#/$defs/kind" }, n: { type: "integer", minimum: 1, "x-mcp-header": "N" } },
  };
  const source: Context = { ...context(), tools: [{ name: "query", description: "query", parameters: schema }] };
  const before = JSON.stringify(source);
  const captured = await capture(
    (fetchImpl) => googleGenerativeAIApi({ fetch: fetchImpl }).stream(model("google-generative-ai", true), source, request),
    GOOGLE_STOP,
  );
  const tools = (captured.body as { tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }> }).tools;
  const declaration = tools[0]?.functionDeclarations[0];
  assert.equal(declaration?.parameters, undefined);
  assert.deepEqual(declaration?.parametersJsonSchema, schema);
  assert.equal(JSON.stringify(source), before);
});
