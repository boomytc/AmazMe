import { createInterface } from "node:readline";

console.error("stdio fixture ready");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pendingListId;

for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === 4242 && !("method" in message)) {
    const uri = message.result?.roots?.[0]?.uri ?? "";
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: pendingListId,
      result: { tools: [{ name: "echo", description: uri, inputSchema: { type: "object" } }] },
    })}\n`);
    pendingListId = undefined;
    continue;
  }
  if (!("id" in message)) continue;
  if (message.method === "initialize") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stdio-fixture", version: "1.0.0" },
      },
    })}\n`);
    continue;
  }
  if (message.method === "tools/list") {
    pendingListId = message.id;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4242, method: "roots/list" })}\n`);
    continue;
  }
  if (message.method === "tools/call") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: String(message.params?.arguments?.text ?? "") }] },
    })}\n`);
    continue;
  }
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" },
  })}\n`);
}
