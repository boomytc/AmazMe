import assert from "node:assert/strict";
import test from "node:test";
import { extractToolHeaderMappings } from "../src/protocol/tool-headers.ts";

test("header annotations retain exact nested property paths and primitive types", () => {
  assert.deepEqual(extractToolHeaderMappings({
    type: "object",
    properties: {
      nested: { type: "object", properties: {
        tenant: { type: ["string", "null"], "x-mcp-header": "Tenant" },
        count: { type: "integer", "x-mcp-header": "Count" },
        enabled: { type: "boolean", "x-mcp-header": "Enabled" },
      } },
      "x-mcp-header": { type: "string" },
    },
    examples: [{ "x-mcp-header": "literal data" }],
  }), [
    { path: ["nested", "tenant"], name: "Tenant", type: "string" },
    { path: ["nested", "count"], name: "Count", type: "integer" },
    { path: ["nested", "enabled"], name: "Enabled", type: "boolean" },
  ]);
});

test("invalid header names, types, duplicate names, and non-properties paths are rejected", () => {
  const invalid: Record<string, unknown>[] = [
    { properties: { x: { type: "string", "x-mcp-header": "" } } },
    { properties: { x: { type: "string", "x-mcp-header": "bad\r\nname" } } },
    { properties: { x: { type: "number", "x-mcp-header": "Number" } } },
    { properties: { x: { type: ["null", "number"], "x-mcp-header": "Number" } } },
    { properties: { x: { type: ["string", "integer"], "x-mcp-header": "Union" } } },
    { properties: { x: { type: "object", "x-mcp-header": "Object" } } },
    { properties: { x: { type: "string", "x-mcp-header": "Region" }, y: { type: "string", "x-mcp-header": "region" } } },
    { type: "string", "x-mcp-header": "Root" },
    { properties: { rows: { type: "array", items: { properties: { x: { type: "string", "x-mcp-header": "Array" } } } } } },
    { allOf: [{ properties: { x: { type: "string", "x-mcp-header": "Composition" } } }] },
    { if: { properties: { x: { type: "string", "x-mcp-header": "Conditional" } } } },
    { $defs: { X: { type: "string", "x-mcp-header": "Reference" } }, properties: { x: { $ref: "#/$defs/X" } } },
  ];
  for (const schema of invalid) assert.throws(() => extractToolHeaderMappings(schema), /Invalid x-mcp-header/);
});
