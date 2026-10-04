import assert from "node:assert/strict";
import test from "node:test";
import { decodeCbor, encodeCbor, ProtocolError, resolveLimits, type JsonValue } from "@amazme/protocol";

const limits = resolveLimits();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "hex"));

function fails(input: Uint8Array, code: "invalid_cbor" | "limit_exceeded", pattern: RegExp, options = limits) {
  assert.throws(() => decodeCbor(input, options), (error) => error instanceof ProtocolError && error.code === code && pattern.test(error.message));
}

test("CBOR encodes the RFC 8949 vectors of the JSON subset", () => {
  const vectors: Array<[JsonValue, string]> = [
    [0, "00"], [23, "17"], [24, "1818"], [1000, "1903e8"], [1_000_000, "1a000f4240"],
    [Number.MAX_SAFE_INTEGER, "1b001fffffffffffff"], [-1, "20"], [-1000, "3903e7"],
    [1.5, "fb3ff8000000000000"], [-0, "fb8000000000000000"], [1e300, "fb7e37e43c8800759c"],
    [false, "f4"], [true, "f5"], [null, "f6"], ["", "60"], ["a", "6161"], ["ü", "62c3bc"],
    [[], "80"], [[1, [2, 3]], "8201820203"], [{}, "a0"], [{ a: 1, b: [2, 3] }, "a26161016162820203"],
  ];
  for (const [value, expected] of vectors) {
    assert.equal(hex(encodeCbor(value, limits)), expected, JSON.stringify(value));
    assert.deepEqual(decodeCbor(bytes(expected), limits), value);
  }
  const unsafe = 2 ** 60;
  assert.equal(decodeCbor(encodeCbor(unsafe, limits), limits), unsafe, "non-safe integers travel as exact float64");
});

test("CBOR round-trips nested strict JSON without prototype effects", () => {
  const value = JSON.parse('{"__proto__":{"polluted":true},"text":"😀\\u0000\\ufeff","list":[{"deep":[null,false,-2.25]}]}') as JsonValue;
  const decoded = decodeCbor(encodeCbor(value, limits), limits) as Record<string, unknown>;
  assert.deepEqual(decoded, value);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.ok(Object.hasOwn(decoded, "__proto__"));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(decoded.text, "😀\u0000\ufeff");
});

test("CBOR rejects values outside the protocol subset", () => {
  fails(bytes("40"), "invalid_cbor", /byte strings/);
  fails(bytes("c100"), "invalid_cbor", /tags/);
  fails(bytes("9f01ff"), "invalid_cbor", /indefinite/);
  fails(bytes("7f6161ff"), "invalid_cbor", /indefinite/);
  fails(bytes("f7"), "invalid_cbor", /simple value/);
  fails(bytes("f93c00"), "invalid_cbor", /float width/);
  fails(bytes("fa3f800000"), "invalid_cbor", /float width/);
  fails(bytes("fb7ff8000000000000"), "invalid_cbor", /not finite/);
  fails(bytes("ff"), "invalid_cbor", /simple value/);
  fails(bytes("1c"), "invalid_cbor", /additional information/);
  fails(bytes("1b0020000000000000"), "invalid_cbor", /safe range/);
  fails(bytes("3b001fffffffffffff"), "invalid_cbor", /safe range/);
  fails(bytes("a10101"), "invalid_cbor", /keys must be/);
  fails(bytes("a2616101616102"), "invalid_cbor", /duplicate key/);
  fails(bytes("62c328"), "invalid_cbor", /UTF-8/);
  fails(bytes("63eda080"), "invalid_cbor", /UTF-8/);
  fails(bytes("0000"), "invalid_cbor", /trailing/);
  fails(bytes(""), "invalid_cbor", /truncated/);
  fails(bytes("6461"), "invalid_cbor", /truncated/);
  fails(bytes("1a0001"), "invalid_cbor", /truncated/);
  fails(bytes("9a7fffffff"), "invalid_cbor", /truncated/);
  fails(bytes("ba7fffffff"), "invalid_cbor", /truncated/);
});

test("CBOR decoding and encoding stay inside byte, depth and item limits", () => {
  const small = resolveLimits({ maxFrameBytes: 8, maxDepth: 2, maxItems: 3 });
  fails(bytes("818181f6"), "limit_exceeded", /nesting/, small);
  assert.deepEqual(decodeCbor(bytes("8181f6"), small), [[null]]);
  fails(bytes("84f6f6f6f6"), "limit_exceeded", /items/, small);
  fails(new Uint8Array(9), "limit_exceeded", /bytes/, small);
  assert.throws(() => encodeCbor("123456789", small), (error) => error instanceof ProtocolError && error.code === "limit_exceeded");
  let dag: JsonValue = ["x".repeat(16)];
  for (let index = 0; index < 50; index++) dag = [dag, dag];
  assert.throws(() => encodeCbor(dag, resolveLimits({ maxFrameBytes: 1024 })), (error) => error instanceof ProtocolError && error.code === "limit_exceeded");
});

test("the public CBOR encoder validates strict JSON and the same container limits as its decoder", () => {
  const small = resolveLimits({ maxDepth: 1, maxItems: 1 });
  for (const value of [[[1]], [1, 2]]) {
    assert.throws(() => encodeCbor(value, small), (error) => error instanceof ProtocolError && error.code === "limit_exceeded");
  }
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "x", { get() { getterCalls += 1; return 1; }, enumerable: true });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [Number.NaN, Infinity, "\ud800", accessor, cycle, { x: undefined }, [1, , 3]]) {
    assert.throws(() => encodeCbor(value as JsonValue, limits), (error) => error instanceof ProtocolError && error.code === "invalid_json");
  }
  assert.equal(getterCalls, 0);
});

test("CBOR rejects malformed limit options before encoding or decoding", () => {
  for (const key of ["maxFrameBytes", "maxDepth", "maxItems"] as const) {
    for (const value of [Number.NaN, Infinity, 0, -1, 1.5]) {
      const invalid = { ...limits, [key]: value };
      assert.throws(() => encodeCbor(null, invalid), RangeError, `${key}=${value}`);
      assert.throws(() => decodeCbor(bytes("f6"), invalid), RangeError, `${key}=${value}`);
    }
  }
});

test("oversized CBOR text is rejected before allocating its UTF-8 buffer", (t) => {
  const original = TextEncoder.prototype.encode;
  let encoded = 0;
  t.mock.method(TextEncoder.prototype, "encode", function(this: TextEncoder, input?: string) {
    encoded += 1;
    return original.call(this, input);
  });
  const small = resolveLimits({ maxFrameBytes: 8 });
  for (const value of ["x".repeat(1000), "😀".repeat(1000), { ["x".repeat(1000)]: null }]) {
    assert.throws(() => encodeCbor(value, small), (error) => error instanceof ProtocolError && error.code === "limit_exceeded");
  }
  assert.equal(encoded, 0);
});
