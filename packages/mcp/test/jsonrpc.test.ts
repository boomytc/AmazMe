import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonRpcMessage } from "@amazme/mcp";

test("JSON-RPC request, notification, and response shapes cannot overlap", () => {
  const invalid = [
    { jsonrpc: "2.0", id: 1, method: "ping", result: {} },
    { jsonrpc: "2.0", method: "event", error: { code: -32600, message: "invalid" } },
    { jsonrpc: "2.0", id: 1, result: {}, error: { code: -32600, message: "invalid" } },
    { jsonrpc: "2.0", id: 1, error: { code: -32600.5, message: "invalid" } },
  ];
  for (const message of invalid) assert.throws(() => parseJsonRpcMessage(message), /Invalid JSON-RPC message/);
  assert.deepEqual(parseJsonRpcMessage({ jsonrpc: "2.0", id: 1, result: {} }), { jsonrpc: "2.0", id: 1, result: {} });
});
