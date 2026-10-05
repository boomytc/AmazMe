import assert from "node:assert/strict";
import test from "node:test";
import { decodeKeys, KeyDecoder } from "@amazme/tui";

test("a truncated escape is not text, and the next chunk can finish it", () => {
  const lone = decodeKeys("\u001b");
  assert.deepEqual(lone.keys, []);
  assert.equal(lone.rest, "\u001b");
  const csi = decodeKeys("\u001b[6");
  assert.deepEqual(csi.keys, []);
  assert.equal(csi.rest, "\u001b[6");

  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.push("\u001b"), []);
  assert.deepEqual(decoder.push("[6"), []);
  assert.deepEqual(decoder.push("~"), [{ type: "page-down" }]);
});

test("ctrl-c, a CJK character, and page-down decode as themselves", () => {
  assert.deepEqual(decodeKeys("\u0003").keys, [{ type: "ctrl-c" }]);
  assert.deepEqual(decodeKeys("中").keys, [{ type: "char", value: "中" }]);
  assert.deepEqual(decodeKeys("\u001b[6~").keys, [{ type: "page-down" }]);
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.push("中\u0003\u001b[6~"), [
    { type: "char", value: "中" },
    { type: "ctrl-c" },
    { type: "page-down" },
  ]);
});
