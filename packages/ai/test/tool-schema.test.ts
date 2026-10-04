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

test("standard JSON Schema constraints work and malformed or unknown schema rules fail closed", () => {
  const withMinimum = { type: "object", properties: { n: { type: "number", minimum: 0 } }, required: ["n"] } as JsonSchema;
  assert.equal(validateArguments(withMinimum, { n: 1 }), undefined);
  assert.match(validateArguments(withMinimum, { n: -1 }) ?? "", /n: must be >= 0/);
  const union = { type: ["string", "null"] } as unknown as JsonSchema;
  assert.equal(validateArguments(union, null), undefined);
  assert.match(validateArguments(union, 1) ?? "", /must be string or null/);
  const tuple = { type: "array", items: [{ type: "string" }] } as unknown as JsonSchema;
  assert.match(validateArguments(tuple, ["a"]) ?? "", /unsupported schema/);
  const schemaValued = { type: "object", additionalProperties: { type: "string" } } as unknown as JsonSchema;
  assert.equal(validateArguments(schemaValued, { a: "x" }), undefined);
  assert.match(validateArguments(schemaValued, { a: 1 }) ?? "", /a: must be string/);
  for (const schema of [
    { type: "invented" }, { type: "object", required: "n" },
    { type: "number", madeUpConstraint: true }, { type: "number", minimum: "0" },
    { $ref: "https://example.test/schema" }, { $ref: "#/$defs/missing" },
  ]) assert.match(validateArguments(schema as JsonSchema, {}) ?? "", /unsupported schema/);
});

test("MCP schemas keep enums, local references, annotations, defaults and format constraints", () => {
  const schema: JsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: { "mode/name": { type: "string", enum: ["fast", "slow"] } },
    properties: {
      mode: { $ref: "#/$defs/mode~1name", default: "fast" },
      count: { type: "integer", minimum: 1, "x-mcp-header": "Count" },
      email: { type: "string", format: "email" },
    },
    required: ["mode", "count"],
    additionalProperties: false,
  };
  const args = { mode: "fast", count: 2, email: "me@example.test" };
  const before = JSON.stringify(args);
  assert.equal(validateArguments(schema, args), undefined);
  assert.equal(JSON.stringify(args), before);
  assert.match(validateArguments(schema, { mode: "other", count: 2 }) ?? "", /mode.*allowed values/);
  assert.match(validateArguments(schema, { mode: "fast", count: "2" }) ?? "", /count: must be integer/);
  assert.match(validateArguments(schema, { mode: "fast", count: 0 }) ?? "", /count: must be >= 1/);
  assert.match(validateArguments(schema, { mode: "fast", count: 2, email: "bad" }) ?? "", /email.*format/);
  const missing = { count: 2 };
  assert.match(validateArguments(schema, missing) ?? "", /mode: required/);
  assert.deepEqual(missing, { count: 2 });
});

test("unused unresolved references, unknown formats and unknown dialects are rejected before execution", () => {
  for (const schema of [
    { type: "object", properties: { optional: { $ref: "#/$defs/missing" } } },
    { type: "object", $defs: { unused: { $ref: "#missing" } } },
    { type: "string", format: "misspelled_format" },
    { $schema: "https://example.invalid/dialect", type: "string" },
    { type: "object", properties: { optional: { $ref: "#/default" } }, default: { $ref: "#/$defs/missing" } },
    { type: "object", properties: { optional: { $ref: "#/x-schema" } }, "x-schema": { properties: { n: { $ref: "#missing" } } } },
  ]) assert.match(validateArguments(schema as JsonSchema, {}) ?? "", /unsupported schema/);
});

test("local references honor embedded resource ids and their own anchor scopes", () => {
  const schema: JsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://example.test/root",
    type: "object",
    $defs: {
      positive: { $id: "positive", $defs: { n: { $anchor: "value", type: "integer", minimum: 1 } }, type: "object", properties: { n: { $ref: "#value" } } },
      negative: { $id: "negative", $defs: { n: { $anchor: "value", type: "integer", maximum: -1 } }, type: "object", properties: { n: { $ref: "#value" } } },
    },
    properties: { positive: { $ref: "positive" }, negative: { $ref: "negative" } },
  };
  assert.equal(validateArguments(schema, { positive: { n: 1 }, negative: { n: -1 } }), undefined);
  assert.match(validateArguments(schema, { positive: { n: 0 } }) ?? "", /n: must be >= 1/);
  assert.match(validateArguments(schema, { negative: { n: 0 } }) ?? "", /n: must be <= -1/);
});

test("reusing a schema object after changing its constraints uses the current definition", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: { value: { type: "string" } },
  };
  assert.equal(validateArguments(schema, { value: "old" }), undefined);
  const value = schema.properties?.value;
  assert.ok(value && typeof value === "object");
  value.type = "number";
  assert.equal(validateArguments(schema, { value: 7 }), undefined);
  assert.match(validateArguments(schema, { value: "old" }) ?? "", /value: must be number/);
  schema.required = ["value"];
  assert.match(validateArguments(schema, {}) ?? "", /value: required/);
  schema.additionalProperties = false;
  assert.match(validateArguments(schema, { value: 7, extra: true }) ?? "", /extra: additional property/);
});
