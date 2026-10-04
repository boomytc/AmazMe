import assert from "node:assert/strict";
import test from "node:test";
import { FrameWriter } from "@amazme/protocol/writer";

test("the shared writer waits for each accepted frame before sending the next", async () => {
  const sent: number[] = [];
  const accepted: Array<() => void> = [];
  const writer = new FrameWriter((frame) => {
    sent.push(frame[0]!);
    return new Promise<void>((resolve) => accepted.push(resolve));
  }, 8, () => assert.fail("unexpected writer failure"));
  const first = writer.write(new Uint8Array([1]), () => new Error("overflow"));
  const second = writer.write(new Uint8Array([2]), () => new Error("overflow"));
  assert.deepEqual(sent, [1]);
  assert.equal(writer.queuedBytes, 2);
  accepted.shift()!();
  await first;
  assert.deepEqual(sent, [1, 2]);
  assert.equal(writer.queuedBytes, 1);
  accepted.shift()!();
  await second;
  assert.equal(writer.queuedBytes, 0);
});

test("overflow rejects every pending frame and all later writes with one terminal failure", async () => {
  const failures: Error[] = [];
  const writer = new FrameWriter(() => new Promise<void>(() => undefined), 2, (error) => failures.push(error));
  const error = new Error("overflow");
  const pending = writer.write(new Uint8Array([1, 2]), () => error);
  const overflowing = writer.write(new Uint8Array([3]), () => error);
  await Promise.all([assert.rejects(pending, (cause) => cause === error), assert.rejects(overflowing, (cause) => cause === error)]);
  await assert.rejects(writer.write(new Uint8Array([4]), () => new Error("unused")), (cause) => cause === error);
  assert.deepEqual(failures, [error]);
  assert.equal(writer.queuedBytes, 0);
});

test("the shared writer rejects invalid queue bounds", () => {
  for (const maxQueuedBytes of [Number.NaN, Infinity, 0, -1, 1.5]) {
    assert.throws(() => new FrameWriter(async () => undefined, maxQueuedBytes, () => undefined), RangeError);
  }
});
