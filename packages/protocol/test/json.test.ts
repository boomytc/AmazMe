import assert from "node:assert/strict";
import test from "node:test";
import { assertJsonValue, isJsonValue, ProtocolError } from "@amazme/protocol";

test("strict JSON accepts plain data without copying or coercing it", () => {
  const shared = { leaf: [1, -0, 1.5, "é😀", true, null] };
  const value = { a: shared, b: shared, empty: {}, list: [], bare: Object.assign(Object.create(null), { x: 1 }) };
  assertJsonValue(value);
  assert.equal(value.a, value.b);
  assert.equal(isJsonValue("0"), true);
  assert.equal(isJsonValue(Number.MAX_VALUE), true);
});

test("strict JSON rejects every non-data value with a path", () => {
  class Box { x = 1; }
  const accessor = Object.defineProperty({}, "x", { get: () => 1, enumerable: true });
  const hidden = Object.defineProperty({}, "x", { value: 1, enumerable: false });
  const symbolKey = { [Symbol("s")]: 1 };
  const sparse = [1, , 3];
  const extra = Object.assign([1], { name: "x" });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = { back: cyclic };
  const cases: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["undefined property", { x: undefined }],
    ["NaN", Number.NaN],
    ["Infinity", { n: [Infinity] }],
    ["bigint", 1n],
    ["function", { f: () => 1 }],
    ["symbol", Symbol("s")],
    ["sparse array", sparse],
    ["array with extra key", extra],
    ["class instance", new Box()],
    ["Date", new Date(0)],
    ["Map", new Map()],
    ["Uint8Array", new Uint8Array(1)],
    ["accessor", accessor],
    ["non-enumerable", hidden],
    ["symbol key", symbolKey],
    ["cycle", cyclic],
    ["lone surrogate", "\ud800"],
    ["lone surrogate key", { "\udc00": 1 }],
  ];
  for (const [name, value] of cases) {
    assert.throws(() => assertJsonValue(value), (error) => error instanceof ProtocolError && error.code === "invalid_json", name);
    assert.equal(isJsonValue(value), false, name);
  }
  assert.throws(() => assertJsonValue({ outer: [{ bad: Number.NaN }] }), /\$\.outer\[0\]\.bad: number is not finite/);
});

test("strict JSON bounds depth and total items, including shared subtrees", () => {
  let deep: unknown = 1;
  for (let index = 0; index < 4; index++) deep = [deep];
  assertJsonValue(deep, { maxDepth: 4 });
  assert.throws(() => assertJsonValue([deep], { maxDepth: 4 }), (error) => error instanceof ProtocolError && error.code === "limit_exceeded");
  assertJsonValue([1, 2, 3], { maxItems: 3 });
  assert.throws(() => assertJsonValue([1, 2, 3, 4], { maxItems: 3 }), (error) => error instanceof ProtocolError && error.code === "limit_exceeded");

  let dag: unknown = [1, 1];
  for (let index = 0; index < 40; index++) dag = [dag, dag];
  assert.throws(() => assertJsonValue(dag, { maxItems: 10_000 }), /exceeds 10000 items/);
  assert.throws(() => assertJsonValue([], { maxDepth: 0 }), RangeError);
});
