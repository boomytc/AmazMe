import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantEvent, AssistantMessage, Context, Model } from "@amazme/ai";
import { encodeAwsEvent, encodeBedrockEvents, encodeBedrockException, nextAwsEvent } from "@amazme/ai/api/aws-event-stream";
import { bedrockConverseStreamApi } from "@amazme/ai/api/bedrock-converse-stream";
import { checkAssistantStream } from "@amazme/ai/testing";

const CONTEXT: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function model(id = "amazon.nova"): Model<"bedrock-converse-stream"> {
  return {
    id,
    name: id,
    provider: "recorded",
    api: "bedrock-converse-stream",
    input: ["text", "image"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 1_000_000, output: 2_000_000 },
    reasoning: true,
  };
}

function crc32Ieee(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunked(bytes: Uint8Array, size: number): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.slice(offset, offset + size));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } });
}

function textOf(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

async function run(body: Uint8Array<ArrayBuffer> | Response, context: Context = CONTEXT, id = "amazon.nova") {
  let calls = 0;
  let url = "";
  let sent = "";
  const headers = new Headers();
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    url = String(input);
    sent = String(init?.body ?? "");
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    return body instanceof Response ? body : new Response(body, { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } });
  };
  const stream = bedrockConverseStreamApi({ fetch: fetchImpl }).stream(model(id), context, {
    apiKey: "recorded-key",
    baseUrl: "https://recorded.test/v1",
  });
  const events: AssistantEvent[] = [];
  for await (const event of stream) events.push(event);
  return { calls, url, sent, headers, events, message: await stream.result() };
}

const END_TURN = encodeBedrockEvents([
  { type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { text: "Hi" } } },
  { type: "messageStop", body: { stopReason: "end_turn" } },
]);

test("event stream frames use the IEEE CRC and reject a damaged frame", () => {
  assert.equal(crc32Ieee(new TextEncoder().encode("123456789")), 0xcbf43926);
  const payload = new TextEncoder().encode("123456789");
  const frame = encodeAwsEvent([[":message-type", "event"], [":event-type", "messageStop"]], payload);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  assert.equal(view.getUint32(8), crc32Ieee(frame.subarray(0, 8)));
  assert.equal(view.getUint32(frame.length - 4), crc32Ieee(frame.subarray(0, frame.length - 4)));
  const decoded = nextAwsEvent(frame);
  assert.equal("event" in decoded, true);
  if ("event" in decoded) {
    assert.equal(decoded.event.headers[":event-type"], "messageStop");
    assert.equal(new TextDecoder().decode(decoded.event.payload), "123456789");
    assert.equal(decoded.rest.length, 0);
  }
  assert.equal("need" in nextAwsEvent(frame.subarray(0, 10)), true);
  const flipped = frame.slice();
  flipped[flipped.length - 8] ^= 0xff;
  const broken = nextAwsEvent(flipped);
  assert.equal("error" in broken && broken.error.includes("checksum"), true);
  const tiny = new Uint8Array(12);
  new DataView(tiny.buffer).setUint32(0, 8);
  assert.equal("error" in nextAwsEvent(tiny), true);
});

test("bedrock converse reads chunked event-stream frames", async () => {
  const frames = encodeBedrockEvents([
    { type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { text: "Hi" } } },
    { type: "contentBlockDelta", body: { contentBlockIndex: 1, delta: { reasoningContent: { text: "Think", reasoningText: { text: "Again" } } } } },
    { type: "contentBlockStart", body: { contentBlockIndex: 2, start: { toolUse: { toolUseId: "call_a", name: "read" } } } },
    { type: "contentBlockDelta", body: { contentBlockIndex: 2, delta: { toolUse: { input: "{\"path\":\"a\"}" } } } },
    { type: "contentBlockStart", body: { contentBlockIndex: 3, start: { toolUse: { toolUseId: "call_b", name: "read" } } } },
    { type: "contentBlockDelta", body: { contentBlockIndex: 3, delta: { toolUse: { input: "{\"path\":\"b\"}" } } } },
    { type: "metadata", body: { usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } } },
    { type: "messageStop", body: { stopReason: "tool_use" } },
  ]);
  const seen = await run(chunked(frames, 3));
  assert.deepEqual(checkAssistantStream(seen.events), []);
  assert.equal(seen.calls, 1);
  assert.equal(seen.url, "https://recorded.test/v1/model/amazon.nova/converse-stream");
  assert.equal(seen.headers.get("accept"), "application/vnd.amazon.eventstream");
  assert.equal(seen.headers.get("authorization"), "Bearer recorded-key");
  assert.equal(textOf(seen.message), "Hi");
  assert.equal(seen.message.content.filter((block) => block.type === "thinking").map((block) => block.type === "thinking" ? block.thinking : "").join(""), "Think");
  const tools = seen.message.content.filter((block) => block.type === "toolCall");
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.type === "toolCall" && tools[0].id, "call_a");
  assert.equal(tools[1]?.type === "toolCall" && tools[1].id, "call_b");
  assert.deepEqual(tools[0]?.type === "toolCall" ? tools[0].arguments : undefined, { path: "a" });
  assert.deepEqual(tools[1]?.type === "toolCall" ? tools[1].arguments : undefined, { path: "b" });
  assert.equal(seen.message.stopReason, "toolUse");
  assert.equal(seen.message.usage.totalTokens, 7);
  assert.equal(seen.message.usage.input, 3);
  assert.equal(seen.message.usage.output, 4);
});

test("a damaged bedrock frame keeps earlier text and does not close a tool call", async () => {
  const good = encodeBedrockEvents([
    { type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { text: "Keep" } } },
  ]);
  const bad = encodeBedrockEvents([
    { type: "contentBlockStart", body: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call_1", name: "read" } } } },
  ]);
  const flipped = bad.slice();
  flipped[12] ^= 0xff;
  const bytes = new Uint8Array(good.length + flipped.length);
  bytes.set(good, 0);
  bytes.set(flipped, good.length);
  const seen = await run(bytes);
  assert.deepEqual(checkAssistantStream(seen.events), []);
  assert.equal(seen.message.stopReason, "error");
  assert.equal(seen.message.retryable, true);
  assert.equal(textOf(seen.message), "Keep");
  assert.equal(seen.events.some((event) => event.type === "toolcall_end"), false);
  assert.match(seen.message.errorMessage ?? "", /checksum/);
});

test("bedrock exceptions keep the retryable split and do not close tool calls", async () => {
  const validation = await run(encodeBedrockException("validationException", "nope"));
  assert.equal(validation.message.stopReason, "error");
  assert.notEqual(validation.message.retryable, true);
  assert.match(validation.message.errorMessage ?? "", /validationException: nope/);
  assert.equal(validation.events.some((event) => event.type === "toolcall_end"), false);
  const internal = await run(encodeBedrockException("internalServerException", "later"));
  assert.equal(internal.message.stopReason, "error");
  assert.equal(internal.message.retryable, true);
  assert.match(internal.message.errorMessage ?? "", /internalServerException/);
});

test("bedrock stop reasons distinguish length, success, and guardrails", async () => {
  const empty = await run(new Uint8Array());
  assert.equal(empty.message.stopReason, "error");
  assert.notEqual(empty.message.retryable, true);
  assert.match(empty.message.errorMessage ?? "", /without a stop reason/);
  const truncated = await run(END_TURN.slice(0, 10));
  assert.equal(truncated.message.retryable, true);
  assert.match(truncated.message.errorMessage ?? "", /truncated/);
  const length = await run(encodeBedrockEvents([
    { type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { text: "Hi" } } },
    { type: "messageStop", body: { stopReason: "model_context_window_exceeded" } },
  ]));
  assert.equal(length.message.stopReason, "length");
  const sequence = await run(encodeBedrockEvents([
    { type: "messageStop", body: { stopReason: "stop_sequence" } },
  ]));
  assert.equal(sequence.message.stopReason, "stop");
  const guard = await run(encodeBedrockEvents([
    { type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { text: "Keep" } } },
    { type: "contentBlockStart", body: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call_1", name: "read" } } } },
    { type: "messageStop", body: { stopReason: "guardrail_intervened" } },
  ]));
  assert.deepEqual(checkAssistantStream(guard.events), []);
  assert.equal(guard.message.stopReason, "error");
  assert.notEqual(guard.message.retryable, true);
  assert.equal(textOf(guard.message), "Keep");
  assert.equal(guard.events.some((event) => event.type === "toolcall_end"), false);
  assert.match(guard.message.errorMessage ?? "", /guardrail_intervened/);
});

test("bedrock sends one system block, images, and coalesced tool results", async () => {
  const same = await run(END_TURN, {
    systemPrompt: "be brief",
    messages: [
      { role: "system", content: "be brief", timestamp: 1 },
      { role: "user", content: "hi", timestamp: 2 },
    ],
  });
  const sameBody = JSON.parse(same.sent) as { system: Array<{ text: string }>; messages: Array<{ role: string }> };
  assert.deepEqual(sameBody.system, [{ text: "be brief" }]);
  assert.equal(sameBody.messages.some((message) => message.role === "system"), false);
  const joined = await run(END_TURN, {
    systemPrompt: "be brief",
    messages: [
      { role: "system", content: "extra", timestamp: 1 },
      { role: "user", content: "hi", timestamp: 2 },
    ],
  });
  const joinedBody = JSON.parse(joined.sent) as { system: Array<{ text: string }> };
  assert.deepEqual(joinedBody.system, [{ text: "be brief\nextra" }]);
  const images = await run(END_TURN, {
    messages: [{
      role: "user",
      timestamp: 1,
      content: [
        { type: "image", mimeType: "image/png", data: "QUJD" },
        { type: "image", mimeType: "image/jpg", data: "QUJD" },
      ],
    }],
  });
  const imageBody = JSON.parse(images.sent) as { messages: Array<{ content: Array<{ image?: { format: string; source: { bytes: string } } }> }> };
  const blocks = imageBody.messages[0]?.content ?? [];
  assert.equal(blocks[0]?.image?.format, "png");
  assert.equal(blocks[0]?.image?.source.bytes, "QUJD");
  assert.equal(blocks[1]?.image?.format, "jpeg");
  const rejected = await run(END_TURN, {
    messages: [{ role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/tiff", data: "QUJD" }] }],
  });
  assert.equal(rejected.calls, 0);
  assert.equal(rejected.message.stopReason, "error");
  assert.equal((rejected.message.errorMessage ?? "").includes("QUJD"), false);
  assert.match(rejected.message.errorMessage ?? "", /image format/);
  const tools = await run(END_TURN, {
    messages: [
      { role: "user", content: "hi", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "bedrock-converse-stream",
        provider: "recorded",
        model: "amazon.nova",
        usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: "call_a", toolName: "read", content: [{ type: "text", text: "aaa" }], isError: false, timestamp: 3 },
      { role: "toolResult", toolCallId: "call_b", toolName: "read", content: [{ type: "text", text: "bbb" }], isError: true, timestamp: 4 },
    ],
  });
  const toolBody = JSON.parse(tools.sent) as {
    messages: Array<{ role: string; content: Array<{ toolResult?: { toolUseId: string; status?: string } }> }>;
  };
  assert.deepEqual(toolBody.messages.map((message) => message.role), ["user", "assistant", "user"]);
  const results = toolBody.messages[2]?.content ?? [];
  assert.equal(results[0]?.toolResult?.toolUseId, "call_a");
  assert.equal(results[0]?.toolResult?.status, undefined);
  assert.equal(results[1]?.toolResult?.toolUseId, "call_b");
  assert.equal(results[1]?.toolResult?.status, "error");
});
