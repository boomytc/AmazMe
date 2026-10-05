import assert from "node:assert/strict";
import test from "node:test";
import { frameFromEvent, reduceFrames, transformMessages, type AssistantEvent, type AssistantMessage, type Context, type Model } from "@amazme/ai";
import { anthropicMessagesApi } from "@amazme/ai/api/anthropic-messages";
import { googleGenerativeAIApi } from "@amazme/ai/api/google-generative-ai";
import { googleVertexApi } from "@amazme/ai/api/google-vertex";
import { bedrockConverseStreamApi } from "@amazme/ai/api/bedrock-converse-stream";
import { encodeBedrockEvents } from "@amazme/ai/api/aws-event-stream";
import { openAIResponsesApi } from "@amazme/ai/api/openai-responses";
import { checkAssistantStream } from "@amazme/ai/testing";
const context: Context = { messages: [{ role: "user", content: "read a", timestamp: 1 }] };
function model<TApi extends Model["api"]>(api: TApi, id = "recorded"): Model<TApi> { return { id, name: id, provider: "recorded", api, input: ["text"], contextWindow: 32_000, maxTokens: 4_000, cost: { input: 1_000_000, output: 2_000_000 }, reasoning: true }; }
function sse(events: unknown[]) { return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")); }
async function collect(stream: AsyncIterable<AssistantEvent> & { result(): Promise<AssistantMessage> }) { const events: AssistantEvent[] = []; for await (const e of stream) events.push(e); return { events, message: await stream.result() }; }
const options = { apiKey: "fixture", baseUrl: "https://fixture.test" };

test("native accumulator starts an empty success and validates truncated tools", async () => {
  const empty = await collect(openAIResponsesApi({ fetch: async () => sse([{ type: "response.completed", response: { status: "completed" } }]) }).stream(model("openai-responses"), context, options));
  assert.deepEqual(checkAssistantStream(empty.events), []);
  const truncated = await collect(openAIResponsesApi({ fetch: async () => sse([
    { type: "response.output_item.added", item: { type: "function_call", id: "item1", call_id: "call1", name: "read" } },
    { type: "response.function_call_arguments.delta", item_id: "item1", delta: '{"path":' },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
  ]) }).stream(model("openai-responses"), context, options));
  assert.equal(truncated.message.stopReason, "error");
  assert.equal(truncated.events.some(e => e.type === "toolcall_end"), false);
  assert.deepEqual(checkAssistantStream(truncated.events), []);
});

test("a failed native stream retains complete received tool arguments", async () => {
  const seen = await collect(openAIResponsesApi({ fetch: async () => sse([
    { type: "response.output_item.added", item: { type: "function_call", id: "item1", call_id: "call1", name: "read" } },
    { type: "response.function_call_arguments.delta", item_id: "item1", delta: '{"path":"a"}' },
    { type: "response.failed", response: { error: { code: "server_error", message: "failed" } } },
  ]) }).stream(model("openai-responses"), context, options));
  assert.deepEqual(seen.message.content.find(b => b.type === "toolCall")?.arguments, { path: "a" });
  assert.equal(seen.events.some(e => e.type === "toolcall_end"), false);
});

for (const api of ["anthropic-messages", "google-generative-ai", "google-vertex", "bedrock-converse-stream"] as const) {
  test(`${api} preserves signatures into the next tool request and recovery frames`, async () => {
    const google = api === "google-generative-ai" || api === "google-vertex";
    const active = model(api, google ? "gemini-3-flash-preview" : "recorded");
    const nativeId = `native.call:${"a".repeat(90)}`;
    const bodies: Record<string, unknown>[] = [];
    const native = api === "anthropic-messages" ? [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Read file" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2ln" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "bmVk" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call1", name: "read", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ] : [{ candidates: [{ content: { parts: [{ functionCall: { id: nativeId, name: "read", args: { path: "a" } }, thoughtSignature: "c2lnbmVk" }] }, finishReason: "STOP" }] }];
    const fetchImpl: typeof fetch = async (_input, init) => { bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return api === "bedrock-converse-stream" ? new Response(encodeBedrockEvents([
      { type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { reasoningContent: { text: "Read file" } } } },
      { type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "c2lnbmVk" } } } },
      { type: "contentBlockStart", body: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call1", name: "read" } } } },
      { type: "contentBlockDelta", body: { contentBlockIndex: 1, delta: { toolUse: { input: '{"path":"a"}' } } } },
      { type: "messageStop", body: { stopReason: "tool_use" } },
    ])) : sse(native); };
    const open = (input: Context) => api === "anthropic-messages"
      ? anthropicMessagesApi({ fetch: fetchImpl }).stream({ ...active, api: "anthropic-messages" }, input, options)
      : api === "google-generative-ai"
        ? googleGenerativeAIApi({ fetch: fetchImpl }).stream({ ...active, api: "google-generative-ai" }, input, options)
        : api === "google-vertex"
          ? googleVertexApi({ fetch: fetchImpl }).stream({ ...active, api: "google-vertex" }, input, { ...options, project: "fixture", location: "us-central1" })
          : bedrockConverseStreamApi({ fetch: fetchImpl }).stream({ ...active, api: "bedrock-converse-stream" }, input, options);
    const first = await collect(open(context));
    const call = first.message.content.find(b => b.type === "toolCall"); assert.ok(call);
    await collect(open({ messages: [...context.messages, first.message, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 }] }));
    assert.ok(JSON.stringify(bodies[1]).includes('"c2lnbmVk"'));
    if (google) {
      assert.equal(call.id, nativeId);
      const contents = bodies[1]?.contents as Array<{ role: string; parts: Array<{ functionCall?: { id: string }; functionResponse?: { id: string } }> }>;
      assert.equal(contents[1]?.parts[0]?.functionCall?.id, nativeId);
      assert.equal(contents[2]?.parts[0]?.functionResponse?.id, nativeId);
    }
    const frames = first.events.map(frameFromEvent).filter(f => f !== undefined);
    assert.deepEqual(reduceFrames(frames).content, first.message.content);
    assert.deepEqual(checkAssistantStream(first.events), []);
    const changed = transformMessages([first.message], { ...active, id: "another" });
    assert.equal(JSON.stringify(changed).includes('"c2lnbmVk"'), false);
    assert.equal(JSON.stringify(first.message).includes('"c2lnbmVk"'), true);
  });
}

test("Google uses 2.5 budgets, disables Flash thinking, and rejects Pro off", async () => {
  const bodies: Record<string, unknown>[] = [];
  const api = googleGenerativeAIApi({ fetch: async (_input, init) => { bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return sse([{ candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }] }]); } });
  await collect(api.stream(model("google-generative-ai", "gemini-2.5-flash"), context, { ...options, thinkingLevel: "off" }));
  const off = bodies[0]?.generationConfig as Record<string, unknown>;
  assert.deepEqual(off.thinkingConfig, { thinkingBudget: 0 });
  await collect(api.stream(model("google-generative-ai", "gemini-2.5-flash"), context, { ...options, thinkingLevel: "high" }));
  const high = bodies[1]?.generationConfig as { thinkingConfig: Record<string, unknown> };
  assert.equal(typeof high.thinkingConfig.thinkingBudget, "number");
  assert.equal(high.thinkingConfig.thinkingLevel, undefined);
  assert.equal(high.thinkingConfig.includeThoughts, true);
  const before = bodies.length;
  const pro = await collect(api.stream(model("google-generative-ai", "gemini-2.5-pro"), context, { ...options, thinkingLevel: "off" }));
  assert.equal(pro.message.stopReason, "error"); assert.equal(bodies.length, before);
});

test("Google bills reasoning tokens as part of output usage", async () => {
  const seen = await collect(googleGenerativeAIApi({ fetch: async () => sse([{ candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 10, totalTokenCount: 17 } }]) }).stream(model("google-generative-ai", "gemini-3-flash-preview"), context, options));
  assert.equal(seen.message.usage.output, 14);
  assert.equal(seen.message.usage.totalTokens, 17);
  assert.equal(seen.message.usage.reasoning, 10);
  assert.equal(seen.message.usage.cost.output, 28);
  assert.equal(seen.message.usage.cost.total, 28 + seen.message.usage.cost.input);
});

test("Google signature-only and signed text parts retain their distinct boundaries", async () => {
  const seen = await collect(googleGenerativeAIApi({ fetch: async () => sse([
    { candidates: [{ content: { parts: [{ text: "before" }] } }] },
    { candidates: [{ content: { parts: [{ text: "", thoughtSignature: "c2lnMQ==" }, { text: "after", thoughtSignature: "c2lnMg==" }] }, finishReason: "STOP" }] },
  ]) }).stream(model("google-generative-ai", "gemini-3-flash-preview"), context, options));
  assert.deepEqual(seen.message.content, [{ type: "text", text: "before", textSignature: "c2lnMQ==" }, { type: "text", text: "after", textSignature: "c2lnMg==" }]);
  assert.deepEqual(reduceFrames(seen.events.map(frameFromEvent).filter(f => f !== undefined)).content, seen.message.content);
  assert.deepEqual(checkAssistantStream(seen.events), []);
});

for (const api of ["anthropic-messages", "bedrock-converse-stream"] as const) {
  test(`${api} retains redacted reasoning without exposing it as answer text`, async () => {
    const active = model(api);
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return api === "anthropic-messages" ? sse([
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "c2lnbmVk" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ]) : new Response(encodeBedrockEvents([
      { type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: "c2ln" } } } },
      { type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: "bmVk" } } } },
      { type: "contentBlockDelta", body: { contentBlockIndex: 1, delta: { text: "Hi" } } },
      { type: "messageStop", body: { stopReason: "end_turn" } },
    ])); };
    const open = (input: Context) => api === "anthropic-messages"
      ? anthropicMessagesApi({ fetch: fetchImpl }).stream({ ...active, api: "anthropic-messages" }, input, options)
      : bedrockConverseStreamApi({ fetch: fetchImpl }).stream({ ...active, api: "bedrock-converse-stream" }, input, options);
    const first = await collect(open(context));
    assert.deepEqual(first.message.content[0], { type: "thinking", thinking: "", thinkingSignature: "c2lnbmVk", redacted: true });
    assert.deepEqual(reduceFrames(first.events.map(frameFromEvent).filter(f => f !== undefined)).content, first.message.content);
    await collect(open({ messages: [...context.messages, first.message, { role: "user", content: "continue", timestamp: 3 }] }));
    assert.ok(JSON.stringify(bodies[1]).includes('"c2lnbmVk"'));
    assert.equal(JSON.stringify(transformMessages([first.message], { ...active, provider: "other" })).includes("c2lnbmVk"), false);
  });
}

test("a length response with complete tool arguments retains its length reason and payload", async () => {
  const seen = await collect(openAIResponsesApi({ fetch: async () => sse([
    { type: "response.output_item.added", item: { type: "function_call", id: "item1", call_id: "call1", name: "read" } },
    { type: "response.function_call_arguments.delta", item_id: "item1", delta: '{"path":"a"}' },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
  ]) }).stream(model("openai-responses"), context, options));
  assert.equal(seen.message.stopReason, "length");
  assert.deepEqual(seen.message.content.find(b => b.type === "toolCall")?.arguments, { path: "a" });
  assert.deepEqual(checkAssistantStream(seen.events), []);
});

test("Google does not merge signature-bearing parts within one native chunk", async () => {
  const seen = await collect(googleGenerativeAIApi({ fetch: async () => sse([{ candidates: [{ content: { parts: [{ text: "unsigned" }, { text: "signed", thoughtSignature: "c2lnbmVk" }, { text: "", thoughtSignature: "ZW1wdHk=" }] }, finishReason: "STOP" }] }]) }).stream(model("google-generative-ai", "gemini-3-flash-preview"), context, options));
  assert.deepEqual(seen.message.content, [{ type: "text", text: "unsigned" }, { type: "text", text: "signed", textSignature: "c2lnbmVk" }, { type: "text", text: "", textSignature: "ZW1wdHk=" }]);
  assert.deepEqual(reduceFrames(seen.events.map(frameFromEvent).filter(f => f !== undefined)).content, seen.message.content);
  assert.deepEqual(checkAssistantStream(seen.events), []);
});

async function bedrockRequest(id: string, thinkingLevel: "off" | "minimal" | "low" | "medium" | "high", maxTokens = 4000) {
  const bodies: Array<{ inferenceConfig: { maxTokens: number }; additionalModelRequestFields?: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (_input, init) => { bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]); return new Response(encodeBedrockEvents([{ type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { text: "Hi" } } }, { type: "messageStop", body: { stopReason: "end_turn" } }])); };
  const seen = await collect(bedrockConverseStreamApi({ fetch: fetchImpl }).stream(model("bedrock-converse-stream", id), context, { ...options, thinkingLevel, maxTokens }));
  return { ...seen, bodies };
}

test("Bedrock Claude uses token or adaptive thinking without increasing the output cap", async () => {
  const token = await bedrockRequest("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "low");
  assert.equal(token.bodies[0]?.inferenceConfig.maxTokens, 4000);
  assert.deepEqual(token.bodies[0]?.additionalModelRequestFields, { thinking: { type: "enabled", budget_tokens: 2048 } });
  const capped = await bedrockRequest("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "high", 2000);
  assert.deepEqual(capped.bodies[0]?.additionalModelRequestFields, { thinking: { type: "enabled", budget_tokens: 1999 } });
  const blocked = await bedrockRequest("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "high", 1024);
  assert.equal(blocked.message.stopReason, "error"); assert.equal(blocked.bodies.length, 0); assert.notEqual(blocked.message.retryable, true);
  for (const [requested, expected] of [["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"]] as const) {
    const adaptive = await bedrockRequest("global.anthropic.claude-opus-4-6-v1", requested, 1000);
    assert.deepEqual(adaptive.bodies[0]?.additionalModelRequestFields, { thinking: { type: "adaptive" }, output_config: { effort: expected } });
    assert.equal(adaptive.bodies[0]?.inferenceConfig.maxTokens, 1000);
  }
  const off = await bedrockRequest("global.anthropic.claude-sonnet-5", "off");
  assert.deepEqual(off.bodies[0]?.additionalModelRequestFields, { thinking: { type: "disabled" } });
});

test("Bedrock Nova maps its supported efforts and refuses unbounded or unknown controls", async () => {
  for (const effort of ["low", "medium"] as const) {
    const seen = await bedrockRequest("global.amazon.nova-2-lite-v1:0", effort);
    assert.deepEqual(seen.bodies[0]?.additionalModelRequestFields, { reasoningConfig: { type: "enabled", maxReasoningEffort: effort } });
    assert.equal(seen.bodies[0]?.inferenceConfig.maxTokens, 4000);
  }
  const off = await bedrockRequest("global.amazon.nova-2-lite-v1:0", "off");
  assert.deepEqual(off.bodies[0]?.additionalModelRequestFields, { reasoningConfig: { type: "disabled" } });
  for (const effort of ["minimal", "high"] as const) {
    const blocked = await bedrockRequest("amazon.nova-2-lite-v1:0", effort);
    assert.equal(blocked.bodies.length, 0); assert.equal(blocked.message.stopReason, "error"); assert.notEqual(blocked.message.retryable, true);
  }
  const unknown = await bedrockRequest("deepseek.v3.2", "high");
  assert.equal(unknown.bodies.length, 0); assert.match(unknown.message.errorMessage ?? "", /not implemented/);
  const inherited = await bedrockRequest("deepseek.v3.2", "off");
  assert.equal(inherited.bodies.length, 0); assert.match(inherited.message.errorMessage ?? "", /not implemented/);
  const defaults = await collect(bedrockConverseStreamApi({ fetch: async () => new Response(encodeBedrockEvents([{ type: "messageStop", body: { stopReason: "end_turn" } }])) }).stream(model("bedrock-converse-stream", "deepseek.v3.2"), context, options));
  assert.equal(defaults.message.stopReason, "stop");
});

test("native Claude adaptive and off controls use the same fields as Bedrock", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const api = anthropicMessagesApi({ fetch: async (_input, init) => { bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return sse([{ type: "message_delta", delta: { stop_reason: "end_turn" } }]); } });
  const active = model("anthropic-messages", "claude-sonnet-5");
  await collect(api.stream(active, context, { ...options, thinkingLevel: "medium", maxTokens: 1000 }));
  assert.deepEqual(bodies[0]?.thinking, { type: "adaptive" }); assert.deepEqual(bodies[0]?.output_config, { effort: "medium" });
  assert.equal(bodies[0]?.max_tokens, 1000);
  await collect(api.stream(active, context, { ...options, thinkingLevel: "off" }));
  assert.deepEqual(bodies[1]?.thinking, { type: "disabled" });
});

test("native length reports preserve the shared overflow recovery signal", async () => {
  const bedrock = await collect(bedrockConverseStreamApi({ fetch: async () => new Response(encodeBedrockEvents([{ type: "messageStop", body: { stopReason: "model_context_window_exceeded" } }])) }).stream(model("bedrock-converse-stream"), context, options));
  assert.equal(bedrock.message.stopReason, "length"); assert.equal(bedrock.message.overflow, true);
  const responses = await collect(openAIResponsesApi({ fetch: async () => sse([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 32000, output_tokens: 0 } } }]) }).stream(model("openai-responses"), context, options));
  assert.equal(responses.message.overflow, true);
});
