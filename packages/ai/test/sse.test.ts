import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@amazme/ai";
import { anthropicMessagesApi } from "@amazme/ai/api/anthropic-messages";
import { readSse } from "@amazme/ai/api/prepare";

function chunked(bytes: Uint8Array, size: number): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.slice(offset, offset + size));
      controller.close();
    },
  }));
}

async function collect(response: Response, signal?: AbortSignal): Promise<Array<{ event?: string; data: string }>> {
  const events: Array<{ event?: string; data: string }> = [];
  await readSse(response, signal, (event) => events.push(event));
  return events;
}

test("readSse splits chunks, joins data lines, and flushes a trailing event", async () => {
  const text = `data: ${JSON.stringify({ text: "你" })}\n\n`;
  const bytes = new TextEncoder().encode(text);
  const splitAt = bytes.indexOf(0xe4);
  assert.ok(splitAt > 0);
  const decoded = await collect(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, splitAt + 1));
      controller.enqueue(bytes.slice(splitAt + 1));
      controller.close();
    },
  })));
  assert.equal(decoded.length, 1);
  assert.equal(JSON.parse(decoded[0]?.data ?? "{}").text, "你");

  const lines = await collect(new Response("event: ping\r\ndata: one\r\ndata: two\r\n\r\n"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.event, "ping");
  assert.equal(lines[0]?.data, "one\ntwo");
  const trailing = await collect(new Response("data: tail"));
  assert.equal(trailing[0]?.data, "tail");
  assert.deepEqual(await collect(new Response(new Uint8Array())), []);
  await assert.rejects(collect(new Response(null)), /no body/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collect(new Response("data: {}\n\n"), controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test("anthropic messages still parses an SSE body delivered a few bytes at a time", async () => {
  const body = [
    { type: "message_start", message: { usage: { input_tokens: 3 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const recorded: Model<"anthropic-messages"> = {
    id: "recorded",
    name: "recorded",
    provider: "recorded",
    api: "anthropic-messages",
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 0, output: 0 },
    reasoning: false,
  };
  const stream = anthropicMessagesApi({
    fetch: async () => chunked(new TextEncoder().encode(body), 2),
  }).stream(recorded, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
    apiKey: "recorded-key",
    baseUrl: "https://api.anthropic.com",
  });
  const message = await stream.result();
  assert.equal(message.stopReason, "stop");
  assert.equal(message.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join(""), "Hi");
  assert.equal(message.usage.input, 3);
  assert.equal(message.usage.output, 4);
});

test("readSse cancels a pending body read when its signal is aborted", async () => {
  let closeBody: () => void = () => undefined;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { closeBody = () => controller.close(); },
    cancel() { cancelled = true; },
  }));
  const controller = new AbortController();
  const pending = collect(response, controller.signal).then(() => undefined, (error: unknown) => error);
  controller.abort();
  const timeout = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([pending, new Promise<symbol>(resolve => {
    timer = setTimeout(() => resolve(timeout), 100);
  })]);
  clearTimeout(timer);
  if (result === timeout) closeBody();
  assert.notEqual(result, timeout, "abort must settle without waiting for another server chunk");
  assert.ok(result instanceof DOMException && result.name === "AbortError");
  assert.equal(cancelled, true);
});
