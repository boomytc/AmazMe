import assert from "node:assert/strict";
import test from "node:test";
import { decodeKeys, emptyTui, KeyDecoder, reduceTui } from "@amazme/tui";

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

test("a lone escape becomes Esc after 50ms and does not insert text", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const late: Array<{ type: string }> = [];
  const decoder = new KeyDecoder((keys) => late.push(...keys));
  assert.deepEqual(decoder.push("\u001b"), []);
  t.mock.timers.tick(49);
  assert.deepEqual(late, []);
  t.mock.timers.tick(1);
  assert.deepEqual(late, [{ type: "escape" }]);
  const next = reduceTui(emptyTui(), { type: "key", key: { type: "escape" } });
  assert.equal(next.state.input, "");
});

test("split alt-enter, arrows, and paste are not read as Esc", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const late: Array<{ type: string }> = [];
  const decoder = new KeyDecoder((keys) => late.push(...keys));
  assert.deepEqual(decoder.push("\u001b"), []);
  assert.deepEqual(decoder.push("\r"), [{ type: "newline" }]);
  assert.deepEqual(decoder.push("\u001b"), []);
  assert.deepEqual(decoder.push("[A"), [{ type: "up" }]);
  assert.deepEqual(decoder.push("\u001b"), []);
  assert.deepEqual(decoder.push("[200~ab\u001b[201~"), [{ type: "paste", text: "ab" }]);
  t.mock.timers.tick(50);
  assert.deepEqual(late, []);
});
