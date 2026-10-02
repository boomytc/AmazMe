import assert from "node:assert/strict";
import test from "node:test";
import { validateArguments, type JsonSchema } from "@amazme/ai";

const nested: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["config"],
  properties: {
    config: {
      type: "object",
      additionalProperties: false,
      required: ["count", "label"],
      properties: {
        count: { type: "number" },
        label: { type: "string", description: "visible name" },
        enabled: { type: "boolean" },
        empty: { type: "null" },
        tags: { type: "array", items: { type: "integer" } },
      },
    },
  },
};

const valid = {
  config: { count: 1.5, label: "ok", enabled: true, empty: null, tags: [1, 2] },
};

test("nested objects, arrays, null, and integers accept a matching value without changing it", () => {
  const args = structuredClone(valid);
  assert.equal(validateArguments(nested, args), undefined);
  assert.deepEqual(args, valid);
});

test("a nested number rejects a string and does not coerce it", () => {
  const args = { config: { count: "1", label: "ok", tags: [1] } };
  const error = validateArguments(nested, args);
  assert.match(error ?? "", /config\.count: must be number/);
  assert.equal(args.config.count, "1");
});

test("an array item reports its index when the type is wrong", () => {
  const error = validateArguments(nested, { config: { count: 1, label: "ok", tags: [1, "no"] } });
  assert.match(error ?? "", /config\.tags\.1: must be integer/);
});

test("additionalProperties false rejects an unknown field by path", () => {
  const error = validateArguments(nested, {
    config: { count: 1, label: "ok", tags: [] },
    extra: true,
  });
  assert.match(error ?? "", /extra: additional property is not allowed/);
});

test("a nested additional property and a missing required field are both reported", () => {
  const error = validateArguments(nested, { config: { count: 1, extra: true } });
  assert.match(error ?? "", /config\.label: required/);
  assert.match(error ?? "", /config\.extra: additional property is not allowed/);
});

test("boolean, null, and integer constraints reject coerced lookalikes", () => {
  assert.match(validateArguments(nested, { config: { count: 1, label: "ok", enabled: "true" } }) ?? "", /config\.enabled: must be boolean/);
  assert.match(validateArguments(nested, { config: { count: 1, label: "ok", empty: "null" } }) ?? "", /config\.empty: must be null/);
  assert.match(
    validateArguments(
      { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
      { n: 1.5 },
    ) ?? "",
    /n: must be integer/,
  );
});

test("a non-object value is rejected when the schema requires an object", () => {
  assert.match(validateArguments(nested, null) ?? "", /\$: must be object/);
  assert.match(validateArguments(nested, []) ?? "", /\$: must be object/);
  assert.match(validateArguments({ type: "string" }, 1) ?? "", /\$: must be string/);
});

test("omitted additionalProperties still allows unknown fields, and an array without items allows any element", () => {
  assert.equal(validateArguments({ type: "object", properties: { a: { type: "string" } } }, { a: "x", b: 1 }), undefined);
  assert.equal(validateArguments({ type: "array" }, [1, "a", null]), undefined);
});

test("a schema outside the supported subset is rejected even when the value would otherwise match", () => {
  const withMinimum = { type: "object", properties: { n: { type: "number", minimum: 0 } }, required: ["n"] } as JsonSchema;
  assert.match(validateArguments(withMinimum, { n: 1 }) ?? "", /n: keyword "minimum" is not supported/);
  const union = { type: ["string", "null"] } as unknown as JsonSchema;
  assert.match(validateArguments(union, null) ?? "", /type must be object, array, string, number, integer, boolean, or null/);
  const tuple = { type: "array", items: [{ type: "string" }] } as unknown as JsonSchema;
  assert.match(validateArguments(tuple, ["a"]) ?? "", /items: schema must be an object/);
  const schemaValued = { type: "object", additionalProperties: { type: "string" } } as unknown as JsonSchema;
  assert.match(validateArguments(schemaValued, { a: "x" }) ?? "", /additionalProperties must be a boolean/);
});
