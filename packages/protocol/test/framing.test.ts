import assert from "node:assert/strict";
import test from "node:test";
import { encodeFrame, FrameDecoder, ProtocolError } from "@amazme/protocol";

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

const payloads = [new Uint8Array([1]), new Uint8Array(300).fill(7), new Uint8Array([9, 8, 7]), new Uint8Array(5000).map((_, i) => i % 251)];
const stream = concat(payloads.map((payload) => encodeFrame(payload, 1 << 20)));

test("every split point and every coalesced chunk yields the same frames", () => {
  for (let cut = 0; cut <= stream.byteLength; cut++) {
    const decoder = new FrameDecoder(1 << 20);
    const frames = [...decoder.push(stream.subarray(0, cut)), ...decoder.push(stream.subarray(cut))];
    decoder.end();
    assert.deepEqual(frames, payloads, `cut ${cut}`);
  }
  for (const size of [1, 2, 3, 5, 7, 64, 4099]) {
    const decoder = new FrameDecoder(1 << 20);
    const frames: Uint8Array[] = [];
    for (let at = 0; at < stream.byteLength; at += size) frames.push(...decoder.push(stream.subarray(at, at + size)));
    decoder.end();
    assert.deepEqual(frames, payloads, `chunk ${size}`);
  }
});

test("frames are detached from the caller's chunk buffer", () => {
  const chunk = encodeFrame(new Uint8Array([1, 2, 3]), 16);
  const [frame] = new FrameDecoder(16).push(chunk);
  chunk.fill(0);
  assert.deepEqual(frame, new Uint8Array([1, 2, 3]));
});

test("an oversized length header fails on its fourth byte, before any payload arrives", () => {
  const decoder = new FrameDecoder(1024);
  assert.deepEqual(decoder.push(new Uint8Array([0xff, 0xff, 0xff])), []);
  assert.throws(() => decoder.push(new Uint8Array([0xff])), (error) => error instanceof ProtocolError && error.code === "limit_exceeded");
  assert.equal(decoder.failed, true);
  assert.throws(() => decoder.push(encodeFrame(new Uint8Array([1]), 16)), (error) => error instanceof ProtocolError && error.code === "decoder_failed");
  assert.throws(() => decoder.end(), (error) => error instanceof ProtocolError && error.code === "decoder_failed");
});

test("a frame at the limit passes and one byte more fails", () => {
  const decoder = new FrameDecoder(4);
  assert.equal(decoder.push(encodeFrame(new Uint8Array(4), 4)).length, 1);
  assert.throws(() => encodeFrame(new Uint8Array(5), 4), /exceeds 4 bytes/);
  assert.throws(() => decoder.push(new Uint8Array([0, 0, 0, 5])), /exceeds 4 bytes/);
});

test("empty frames and a stream ending inside a header or payload fail", () => {
  assert.throws(() => encodeFrame(new Uint8Array(0), 4), (error) => error instanceof ProtocolError && error.code === "invalid_frame");
  assert.throws(() => new FrameDecoder(4).push(new Uint8Array(4)), /empty/);
  for (const partial of [new Uint8Array([0, 0]), new Uint8Array([0, 0, 0, 2, 1])]) {
    const decoder = new FrameDecoder(16);
    decoder.push(partial);
    assert.throws(() => decoder.end(), (error) => error instanceof ProtocolError && error.code === "invalid_frame");
    assert.throws(() => decoder.push(new Uint8Array([1])), /failed/);
  }
  const ended = new FrameDecoder(16);
  ended.end();
  assert.throws(() => ended.push(new Uint8Array([0])), /ended/);
});
