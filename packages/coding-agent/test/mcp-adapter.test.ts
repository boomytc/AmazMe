import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, type AgentTool } from "@amazme/agent";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall, type FauxResponder } from "@amazme/ai/providers/faux";
import {
  JSON_RPC_ERROR_CODES,
  type JsonRpcMessage,
  type JsonRpcRequest,
  McpClient,
  McpError,
  MODERN_PROTOCOL_VERSION,
} from "@amazme/mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@amazme/mcp/testing";
import { appendMcpTools, createCodingTools, mcpServer, type McpClient as ListedClient } from "@amazme/coding-agent";

test("MCP tool names and schema are captured together and standard constraints work through Agent", async () => {
  const listing = {
    name: "query", description: "query",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object" as const,
      $defs: { mode: { type: "string", enum: ["fast", "slow"] } },
      properties: {
        mode: { $ref: "#/$defs/mode" },
        n: { type: "integer" as const, minimum: 1, "x-mcp-header": "N" },
      },
      required: ["mode", "n"], additionalProperties: false,
    },
  };
  const calls: Array<{ name: string; args: unknown }> = [];
  const client: ListedClient = {
    listTools: () => [listing],
    async callTool(name, args) { calls.push({ name, args }); return { content: [{ type: "text", text: "ok" }] }; },
  };
  const tools = await appendMcpTools([], { serverId: "docs", client });
  const originalSchema = structuredClone(listing.inputSchema);
  listing.name = "mutated";
  listing.inputSchema.properties.n.minimum = 100;
  assert.deepEqual(tools[0]?.parameters, originalSchema);
  for (const [args, valid] of [
    [{ mode: "fast", n: 2 }, true],
    [{ mode: "other", n: 2 }, false],
    [{ mode: "fast", n: "2" }, false],
    [{ mode: "fast", n: 0 }, false],
  ] as const) {
    const models = createModels();
    models.setProvider(fauxProvider({
      respond: ((...params: Parameters<FauxResponder>) => params[2].callCount === 1
        ? fauxAssistant([fauxToolCall("mcp_docs__query", args)]) : fauxAssistant("done")) satisfies FauxResponder,
    }));
    const model = models.getModel("faux", "faux-1");
    assert.ok(model);
    const before = calls.length;
    const messages = await new Agent({ model, streamFn: models.streamSimple.bind(models), tools }).prompt("query");
    const result = messages.find((message) => message.role === "toolResult");
    assert.equal(result?.role === "toolResult" && result.isError, !valid);
    assert.equal(calls.length, before + (valid ? 1 : 0));
  }
  assert.deepEqual(calls, [{ name: "query", args: { mode: "fast", n: 2 } }]);
});

function listed(name: string): ListedClient {
  return {
    listTools: () => [{ name, description: name, inputSchema: { type: "object" } }],
    callTool: () => Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
  };
}

test("exposed MCP names stay stable and collisions name both identities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-mcp-names-"));
  const coding = createCodingTools(dir);
  const tools = await appendMcpTools(coding, [
    { serverId: "docs", client: listed("read") },
    { serverId: "other", client: listed("read") },
  ]);
  assert.deepEqual(tools.map((tool) => tool.name), ["read", "write", "edit", "bash", "mcp_docs__read", "mcp_other__read"]);
  assert.equal(tools[0], coding[0]);

  const occupied: AgentTool = {
    name: "mcp_docs__read",
    description: "already",
    parameters: { type: "object" },
    async execute() { return { content: [{ type: "text", text: "" }] }; },
  };
  await assert.rejects(
    appendMcpTools([occupied], { serverId: "docs", client: listed("read") }),
    /MCP tool name collides with "mcp_docs__read": server "docs", tool "read"/,
  );

  await assert.rejects(
    appendMcpTools([], [
      { serverId: "a", client: listed("b__c") },
      { serverId: "a__b", client: listed("c") },
    ]),
    /server "a", tool "b__c".*server "a__b", tool "c"/,
  );

  const serverId = "s".repeat(40);
  const toolName = "t".repeat(30);
  await assert.rejects(
    appendMcpTools([], { serverId, client: listed(toolName) }),
    (error: Error) => {
      assert.match(error.message, /exceeds 64 characters/);
      assert.equal(error.message.includes(serverId), true);
      assert.equal(error.message.includes(toolName), true);
      return true;
    },
  );

  await assert.rejects(
    appendMcpTools([], { serverId: "docs", client: listed("hello.world") }),
    (error: Error) => {
      assert.match(error.message, /not a stable identifier/);
      assert.equal(error.message.includes("hello.world"), true);
      assert.equal(error.message.includes("docs"), true);
      assert.equal(error.message.includes("hello_world"), false);
      return true;
    },
  );
  assert.deepEqual(coding.map((tool) => tool.name), ["read", "write", "edit", "bash"]);
});

test("an MCP tool forwards cancel and progress and keeps image content", async () => {
  let seen: AbortSignal | undefined;
  const client: ListedClient = {
    listTools: () => [{ name: "shot", description: "Take a picture", inputSchema: { type: "object" } }],
    callTool: (_name, _args, options) => new Promise((resolve, reject) => {
      seen = options?.signal;
      options?.onProgress?.({ progress: 1, total: 2, message: "working" });
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      resolve({ content: [{ type: "text", text: "cap" }, { type: "image", data: "QUJD", mimeType: "image/png" }] });
    }),
  };
  const tools = await appendMcpTools([], { serverId: "cam", client });
  const models = createModels();
  const provider = fauxProvider({
    respond: ((...args: Parameters<FauxResponder>) => {
      const state = args[2];
      return state.callCount === 1 ? fauxAssistant([fauxToolCall("mcp_cam__shot", {})]) : fauxAssistant("done");
    }) satisfies FauxResponder,
  });
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  const partials: string[] = [];
  const agent = new Agent({ model, streamFn: models.streamSimple.bind(models), tools });
  agent.subscribe((event) => {
    if (event.type === "tool_execution_update") partials.push(event.partial);
  });
  const produced = await agent.prompt("hi");
  const result = produced.find((message) => message.role === "toolResult");
  assert.ok(result?.role === "toolResult");
  assert.deepEqual(result.content, [
    { type: "text", text: "cap" },
    { type: "image", mimeType: "image/png", data: "QUJD" },
  ]);
  assert.equal(messageText(result), "cap[image]");
  assert.deepEqual(partials, ["working"]);
  assert.equal(seen?.aborted, false);

  let started = () => {};
  const running = new Promise<void>((resolve) => { started = resolve; });
  const waiting: ListedClient = {
    listTools: () => [{ name: "shot", description: "Take a picture", inputSchema: { type: "object" } }],
    callTool: (_name, _args, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      started();
    }),
  };
  const cancellable = await appendMcpTools([], { serverId: "cam", client: waiting });
  const second = fauxProvider({
    respond: ((...args: Parameters<FauxResponder>) => {
      const state = args[2];
      return state.callCount === 1 ? fauxAssistant([fauxToolCall("mcp_cam__shot", {})]) : fauxAssistant("done");
    }) satisfies FauxResponder,
  });
  models.setProvider(second);
  const again = new Agent({
    model,
    streamFn: models.streamSimple.bind(models),
    tools: cancellable,
  });
  const pending = again.prompt("hi");
  await running;
  again.abort();
  const cancelled = await pending;
  const failure = cancelled.find((message) => message.role === "toolResult");
  assert.equal(failure?.role === "toolResult" && failure.isError, true);
  assert.match(failure?.role === "toolResult" ? messageText(failure) : "", /aborted/);
});

test("a connected MCP client projects images, progress, and abort without opening a browser", async () => {
  const { client, server } = await connect();
  try {
    server.setHandler("tools/list", () => ({
      tools: [{ name: "shot", description: "Take a picture", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    }));
    server.setHandler("tools/call", async (request) => {
      const params = request.params as { name?: string; arguments?: { q?: string }; _meta?: { progressToken?: unknown } };
      assert.equal(params.name, "shot");
      assert.equal(params.arguments?.q, "x");
      await server.transport.send({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: params._meta?.progressToken, progress: 1, total: 2, message: "working" },
      });
      return {
        content: [
          { type: "text", text: "cap" },
          { type: "image", data: "aW1n", mimeType: "image/png" },
          { type: "audio", data: "aaa", mimeType: "audio/wav" },
        ],
      };
    });
    const tools = await appendMcpTools([], mcpServer("docs", client));
    assert.equal(tools[0]?.name, "mcp_docs__shot");
    assert.equal(tools[0]?.description, "Take a picture");
    assert.deepEqual(tools[0]?.parameters, { type: "object", properties: { q: { type: "string" } } });
    const updates: string[] = [];
    const result = await tools[0]?.execute({ q: "x" }, {
      signal: new AbortController().signal,
      onUpdate: (partial) => updates.push(partial),
    });
    assert.deepEqual(updates, ["working"]);
    assert.deepEqual(result?.content, [
      { type: "text", text: "cap" },
      { type: "image", mimeType: "image/png", data: "aW1n" },
      { type: "text", text: "[audio audio/wav omitted]" },
    ]);

    let arrived = () => {};
    const seen = new Promise<void>((resolve) => { arrived = resolve; });
    server.setHandler("tools/call", () => {
      arrived();
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const shot = tools[0];
    assert.ok(shot);
    const pending = shot.execute({}, { signal: controller.signal });
    await seen;
    controller.abort();
    await assert.rejects(pending, (error: Error) => error.name === "AbortError" && /aborted/.test(error.message));
  } finally {
    await client.close();
  }
});

interface TestServer {
  transport: InMemoryTransport;
  setHandler(method: string, handler: (request: JsonRpcRequest) => unknown | Promise<unknown>): void;
}

async function connect(): Promise<{ client: McpClient; server: TestServer }> {
  const pair = createInMemoryTransportPair();
  const handlers = new Map<string, (request: JsonRpcRequest) => unknown | Promise<unknown>>();
  pair.server.onMessage((message: JsonRpcMessage) => {
    if (!("id" in message) || !("method" in message)) return;
    const request = message;
    const handler = handlers.get(request.method);
    queueMicrotask(async () => {
      try {
        if (!handler) throw new McpError(JSON_RPC_ERROR_CODES.methodNotFound, `Method not found: ${request.method}`);
        await pair.server.send({ jsonrpc: "2.0", id: request.id, result: await handler(request) });
      } catch (error) {
        const mcpError = error instanceof McpError ? error : new McpError(JSON_RPC_ERROR_CODES.internalError, String(error));
        await pair.server.send({ jsonrpc: "2.0", id: request.id, error: { code: mcpError.code, message: mcpError.message } });
      }
    });
  });
  await pair.server.start();
  handlers.set("server/discover", () => ({
    supportedVersions: [MODERN_PROTOCOL_VERSION],
    capabilities: { tools: { listChanged: true } },
  }));
  const client = new McpClient({ name: "adapter-test", version: "1.0.0" });
  await client.connect(pair.client);
  return {
    client,
    server: {
      transport: pair.server,
      setHandler(method, handler) { handlers.set(method, handler); },
    },
  };
}
