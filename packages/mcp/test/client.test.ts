import assert from "node:assert/strict";
import test from "node:test";
import {
  JSON_RPC_ERROR_CODES,
  type JsonRpcMessage,
  type JsonRpcRequest,
  LATEST_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSIONS,
  McpAbortError,
  McpClient,
  McpError,
  McpInputRequiredError,
  McpTimeoutError,
  MODERN_PROTOCOL_VERSION,
} from "@amazme/mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@amazme/mcp/testing";

interface TestServer {
  transport: InMemoryTransport;
  messages: JsonRpcMessage[];
  setHandler(method: string, handler: (request: JsonRpcRequest) => unknown | Promise<unknown>): void;
}

function requestParams(message: JsonRpcMessage): Record<string, unknown> | undefined {
  return "method" in message && "id" in message ? (message.params as Record<string, unknown> | undefined) : undefined;
}

function requests(server: TestServer, method: string): JsonRpcRequest[] {
  return server.messages.filter((message): message is JsonRpcRequest => "method" in message && "id" in message && message.method === method);
}

async function createServer(): Promise<{ clientTransport: InMemoryTransport; server: TestServer }> {
  const pair = createInMemoryTransportPair();
  const handlers = new Map<string, (request: JsonRpcRequest) => unknown | Promise<unknown>>();
  const messages: JsonRpcMessage[] = [];
  pair.server.onMessage((message) => {
    messages.push(message);
    if (!("id" in message) || !("method" in message)) return;
    const request = message;
    const handler = handlers.get(request.method);
    queueMicrotask(async () => {
      try {
        if (!handler) throw new McpError(JSON_RPC_ERROR_CODES.methodNotFound, `Method not found: ${request.method}`);
        await pair.server.send({ jsonrpc: "2.0", id: request.id, result: await handler(request) });
      } catch (error) {
        const mcpError = error instanceof McpError ? error : new McpError(JSON_RPC_ERROR_CODES.internalError, String(error));
        await pair.server.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: mcpError.code,
            message: mcpError.message,
            ...(mcpError.data === undefined ? {} : { data: mcpError.data }),
          },
        });
      }
    });
  });
  await pair.server.start();
  const server: TestServer = {
    transport: pair.server,
    messages,
    setHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
  return { clientTransport: pair.client, server };
}

function legacyInitialize(version: string = LEGACY_PROTOCOL_VERSIONS[0]) {
  return () => ({
    protocolVersion: version,
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: "legacy-server", version: "1.0.0" },
    instructions: "Legacy tools.",
  });
}

async function connectLegacy(): Promise<{ client: McpClient; server: TestServer }> {
  const { clientTransport, server } = await createServer();
  server.setHandler("initialize", legacyInitialize());
  const client = new McpClient({ name: "test-client", version: "2.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

async function connectModern(): Promise<{ client: McpClient; server: TestServer }> {
  const { clientTransport, server } = await createServer();
  server.setHandler("server/discover", () => ({
    supportedVersions: [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSIONS[0]],
    capabilities: { tools: { listChanged: true } },
    instructions: "Modern tools.",
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-server", version: "3.0.0" } },
  }));
  const client = new McpClient({ name: "test-client", version: "2.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

test("a legacy server is opened with initialize after discover is rejected", async () => {
  const { client, server } = await connectLegacy();
  try {
    assert.equal(client.connectionState, "connected");
    assert.equal(client.protocolEra, "legacy");
    assert.equal(client.protocolVersion, LEGACY_PROTOCOL_VERSIONS[0]);
    assert.deepEqual(client.serverInfo, { name: "legacy-server", version: "1.0.0" });
    assert.deepEqual(client.serverCapabilities, { tools: { listChanged: true } });
    assert.equal(client.instructions, "Legacy tools.");
    assert.deepEqual(
      server.messages.map((message) => ("method" in message ? message.method : "")),
      ["server/discover", "initialize", "notifications/initialized"],
    );
    const discover = requests(server, "server/discover")[0];
    assert.ok(discover);
    const meta = requestParams(discover)?._meta as Record<string, unknown>;
    assert.equal(meta["io.modelcontextprotocol/protocolVersion"], LATEST_PROTOCOL_VERSION);
    assert.deepEqual(meta["io.modelcontextprotocol/clientInfo"], { name: "test-client", version: "2.0.0" });
    assert.deepEqual(meta["io.modelcontextprotocol/clientCapabilities"], {});
    const initialize = requests(server, "initialize")[0];
    assert.ok(initialize);
    assert.equal("_meta" in (requestParams(initialize) ?? {}), false);
    assert.equal(
      server.messages.some((message) => "method" in message && message.method === "notifications/cancelled"),
      false,
    );
  } finally {
    await client.close();
  }
});

test("a modern server never receives initialize and later requests carry protocol metadata", async () => {
  const { client, server } = await connectModern();
  try {
    assert.equal(client.protocolEra, "modern");
    assert.equal(client.protocolVersion, MODERN_PROTOCOL_VERSION);
    assert.deepEqual(client.serverInfo, { name: "modern-server", version: "3.0.0" });
    assert.equal(client.instructions, "Modern tools.");
    server.setHandler("tools/list", () => ({ tools: [{ name: "search", inputSchema: { type: "object" } }] }));
    assert.deepEqual(await client.listTools(), [{ name: "search", inputSchema: { type: "object" } }]);
    assert.equal(requests(server, "initialize").length, 0);
    const listed = requests(server, "tools/list")[0];
    assert.ok(listed);
    const meta = requestParams(listed)?._meta as Record<string, unknown>;
    assert.equal(meta["io.modelcontextprotocol/protocolVersion"], MODERN_PROTOCOL_VERSION);
    assert.deepEqual(meta["io.modelcontextprotocol/clientCapabilities"], {});
    assert.equal("progressToken" in meta, false);
  } finally {
    await client.close();
  }
});

test("an unsupported modern version does not fall back to initialize", async () => {
  const { clientTransport, server } = await createServer();
  server.setHandler("server/discover", () => ({
    supportedVersions: ["2099-01-01"],
    capabilities: {},
  }));
  const client = new McpClient({ name: "test-client", version: "2.0.0" });
  await assert.rejects(client.connect(clientTransport), (error: McpError) => {
    assert.equal(error.code, -32022);
    assert.deepEqual(error.data, { supported: ["2099-01-01"], requested: MODERN_PROTOCOL_VERSION });
    return true;
  });
  assert.equal(client.connectionState, "closed");
  assert.equal(requests(server, "initialize").length, 0);
});

test("a modern protocol error does not fall back to initialize", async () => {
  const { clientTransport, server } = await createServer();
  server.setHandler("server/discover", () => {
    throw new McpError(-32022, "Unsupported protocol version", { supported: ["2099-01-01"], requested: MODERN_PROTOCOL_VERSION });
  });
  const client = new McpClient({ name: "test-client", version: "2.0.0", protocolVersion: MODERN_PROTOCOL_VERSION });
  await assert.rejects(client.connect(clientTransport), (error: McpError) => error.code === -32022);
  assert.equal(requests(server, "initialize").length, 0);
  assert.equal(client.connectionState, "closed");
});

test("a discover body that is not a discovery document does not fall back", async () => {
  const { clientTransport, server } = await createServer();
  server.setHandler("server/discover", () => ({ ok: true }));
  server.setHandler("initialize", legacyInitialize());
  const client = new McpClient({ name: "test-client", version: "2.0.0" });
  await assert.rejects(client.connect(clientTransport), /Invalid MCP server\/discover result/);
  assert.equal(requests(server, "initialize").length, 0);
  assert.equal(client.connectionState, "closed");
});

test("forcing the modern revision does not open a legacy session when discover is missing", async () => {
  const { clientTransport, server } = await createServer();
  server.setHandler("initialize", legacyInitialize());
  const client = new McpClient({ name: "test-client", version: "2.0.0", protocolVersion: MODERN_PROTOCOL_VERSION });
  await assert.rejects(client.connect(clientTransport), /Method not found: server\/discover/);
  assert.equal(requests(server, "initialize").length, 0);
  assert.equal(client.connectionState, "closed");
});

test("a discover timeout falls back to the legacy handshake", async () => {
  const { clientTransport, server } = await createServer();
  server.setHandler("server/discover", () => new Promise(() => {}));
  server.setHandler("initialize", legacyInitialize());
  const client = new McpClient({ name: "test-client", version: "2.0.0", requestTimeoutMs: 40, maxTimeoutMs: 40 });
  const connection = await client.connect(clientTransport);
  try {
    assert.equal(connection.era, "legacy");
    assert.equal(connection.protocolVersion, LEGACY_PROTOCOL_VERSIONS[0]);
    assert.equal(
      server.messages.some((message) => "method" in message && message.method === "notifications/cancelled"),
      true,
    );
  } finally {
    await client.close();
  }
});

test("a forced legacy revision skips discover", async () => {
  const { clientTransport, server } = await createServer();
  server.setHandler("initialize", legacyInitialize("2024-11-05"));
  const client = new McpClient({ name: "test-client", version: "2.0.0", protocolVersion: "2024-11-05" });
  await client.connect(clientTransport);
  try {
    assert.equal(client.protocolVersion, "2024-11-05");
    assert.deepEqual(
      server.messages.map((message) => ("method" in message ? message.method : "")),
      ["initialize", "notifications/initialized"],
    );
  } finally {
    await client.close();
  }
});

test("an unknown legacy revision closes the client", async () => {
  const { clientTransport, server } = await createServer();
  server.setHandler("initialize", legacyInitialize("1999-01-01"));
  const client = new McpClient({ name: "test-client", version: "2.0.0", protocolVersion: "2025-11-25" });
  await assert.rejects(client.connect(clientTransport), /unsupported protocol version 1999-01-01/);
  assert.equal(client.connectionState, "closed");
});

test("initialize timing out does not send notifications/cancelled", async () => {
  const { clientTransport, server } = await createServer();
  server.setHandler("initialize", () => new Promise(() => {}));
  const client = new McpClient({ name: "test-client", version: "2.0.0", protocolVersion: "2025-11-25", requestTimeoutMs: 30, maxTimeoutMs: 30 });
  await assert.rejects(client.connect(clientTransport), (error: unknown) => error instanceof McpTimeoutError);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    server.messages.some((message) => "method" in message && message.method === "notifications/cancelled"),
    false,
  );
  assert.equal(client.connectionState, "closed");
});

test("legacy pagination treats an empty cursor as the end and the modern cursor does not", async () => {
  const legacy = await connectLegacy();
  const modern = await connectModern();
  const page = (request: JsonRpcRequest) => {
    const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
    return cursor === undefined
      ? { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }], nextCursor: "" }
      : { tools: [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] };
  };
  legacy.server.setHandler("tools/list", page);
  modern.server.setHandler("tools/list", page);
  try {
    assert.deepEqual(await legacy.client.listTools(), [{ name: "search", description: "Search", inputSchema: { type: "object" } }]);
    assert.equal(requests(legacy.server, "tools/list").length, 1);
    assert.deepEqual(await modern.client.listTools(), [
      { name: "search", description: "Search", inputSchema: { type: "object" } },
      { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ]);
    assert.equal((requestParams(requests(modern.server, "tools/list")[1] ?? { jsonrpc: "2.0", id: 0, method: "" }) as { cursor?: string } | undefined)?.cursor, "");
  } finally {
    await legacy.client.close();
    await modern.client.close();
  }
});

test("a repeated cursor fails instead of paging forever", async () => {
  const { client, server } = await connectLegacy();
  server.setHandler("tools/list", () => ({
    tools: [{ name: "search", inputSchema: { type: "object" } }],
    nextCursor: "again",
  }));
  try {
    await assert.rejects(client.listTools(), /duplicate cursor: again/);
  } finally {
    await client.close();
  }
});

test("resources keep a missing name as the URI and reject a body that is neither text nor bytes", async () => {
  const { client, server } = await connectLegacy();
  server.setHandler("resources/list", (request) =>
    (request.params as { cursor?: string } | undefined)?.cursor === undefined
      ? { resources: [{ uri: "file:///a", name: "a" }], nextCursor: "2" }
      : { resources: [{ uri: "file:///b" }] },
  );
  server.setHandler("resources/templates/list", () => ({
    resourceTemplates: [{ uriTemplate: "repo://{owner}/{repo}" }],
  }));
  server.setHandler("resources/read", (request) => ({
    contents: [{ uri: (request.params as { uri: string }).uri, text: "hello" }],
  }));
  try {
    assert.deepEqual(await client.listResources(), [
      { uri: "file:///a", name: "a" },
      { uri: "file:///b", name: "file:///b" },
    ]);
    assert.deepEqual(await client.listResourceTemplates(), [{ uriTemplate: "repo://{owner}/{repo}", name: "repo://{owner}/{repo}" }]);
    assert.deepEqual(await client.readResource("file:///a"), { contents: [{ uri: "file:///a", text: "hello" }] });
    server.setHandler("resources/read", () => ({ contents: [{ uri: "file:///a" }] }));
    await assert.rejects(client.readResource("file:///a"), /Invalid contents in MCP resources\/read result/);
  } finally {
    await client.close();
  }
});

test("tool results keep structured JSON and image blocks, and input_required is not success", async () => {
  const { client, server } = await connectModern();
  server.setHandler("tools/call", (request) => {
    const params = request.params as { name: string; arguments?: Record<string, unknown> };
    if (params.name === "fail") throw new McpError(1234, "tool failed", { retryable: false });
    if (params.name === "need-input") return { resultType: "input_required", requestState: "opaque" };
    if (params.name === "broken") return { content: "not a list" };
    if (params.name === "structured") return { structuredContent: ["one", { n: params.arguments?.count }] };
    return {
      content: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
      structuredContent: { count: params.arguments?.count },
      isError: false,
    };
  });
  try {
    assert.deepEqual(await client.callTool("shot", { count: 3 }), {
      content: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
      structuredContent: { count: 3 },
      isError: false,
    });
    assert.deepEqual(await client.callTool("structured", { count: 1 }), {
      content: [],
      structuredContent: ["one", { n: 1 }],
    });
    await assert.rejects(client.callTool("fail"), (error: McpError) => {
      assert.equal(error.name, "McpError");
      assert.equal(error.code, 1234);
      assert.equal(error.message, "tool failed");
      assert.deepEqual(error.data, { retryable: false });
      return true;
    });
    await assert.rejects(client.callTool("need-input"), (error: McpInputRequiredError) => {
      assert.equal(error.name, "McpInputRequiredError");
      assert.deepEqual(error.result, { resultType: "input_required", requestState: "opaque" });
      return true;
    });
    await assert.rejects(client.callTool("broken"), /Invalid MCP tools\/call result/);
  } finally {
    await client.close();
  }
});

test("progress restarts the idle timeout and still cannot extend the absolute limit", async () => {
  const { client, server } = await connectLegacy();
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.setHandler("tools/call", (request) => {
    const token = ((request.params as { _meta?: { progressToken?: number } })._meta)?.progressToken;
    release?.();
    return new Promise((resolve) => {
      setTimeout(() => {
        void server.transport.send({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: token, progress: 1, total: 2, message: "working" },
        });
      }, 30);
      setTimeout(() => resolve({ content: [{ type: "text", text: "done" }] }), 70);
    });
  });
  const progress: unknown[] = [];
  try {
    const pending = client.callTool("slow", {}, { timeoutMs: 50, maxTimeoutMs: 500, onProgress: (update) => progress.push(update) });
    await started;
    assert.deepEqual(await pending, { content: [{ type: "text", text: "done" }] });
    assert.deepEqual(progress, [{ progressToken: requests(server, "tools/call")[0]?.id, progress: 1, total: 2, message: "working" }]);
  } finally {
    await client.close();
  }

  const capped = await connectLegacy();
  const ticks: number[] = [];
  const interval = setInterval(() => {
    const call = requests(capped.server, "tools/call")[0];
    const token = call && ((call.params as { _meta?: { progressToken?: number } })._meta)?.progressToken;
    if (token === undefined) return;
    ticks.push(token);
    void capped.server.transport.send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: token, progress: ticks.length },
    });
  }, 20);
  capped.server.setHandler("tools/call", () => new Promise(() => {}));
  const startedAt = Date.now();
  try {
    await assert.rejects(
      capped.client.callTool("stuck", {}, { timeoutMs: 40, maxTimeoutMs: 120, onProgress: () => undefined }),
      (error: unknown) => error instanceof McpTimeoutError,
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 100, `elapsed ${elapsed}`);
    assert.ok(elapsed < 800, `elapsed ${elapsed}`);
    assert.ok(ticks.length >= 2);
  } finally {
    clearInterval(interval);
    await capped.client.close();
  }
});

test("aborting a tool call notifies the server and does not send a call that was already aborted", async () => {
  const { client, server } = await connectLegacy();
  server.setHandler("tools/call", () => new Promise(() => {}));
  const controller = new AbortController();
  try {
    const aborted = client.callTool("wait", {}, { signal: controller.signal, timeoutMs: 0, maxTimeoutMs: 0 });
    controller.abort("stop");
    await assert.rejects(aborted, (error: unknown) => error instanceof McpAbortError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      server.messages.filter((message) => "method" in message && message.method === "notifications/cancelled"),
      [{ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: requests(server, "tools/call")[0]?.id, reason: "stop" } }],
    );
    const already = new AbortController();
    already.abort("stop");
    const before = requests(server, "tools/call").length;
    await assert.rejects(client.callTool("wait", {}, { signal: already.signal }), (error: unknown) => error instanceof McpAbortError);
    assert.equal(requests(server, "tools/call").length, before);
  } finally {
    await client.close();
  }
});

test("a transport error is reported without failing the pending request", async () => {
  const { clientTransport, server } = await createServer();
  server.setHandler("initialize", legacyInitialize());
  const client = new McpClient({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  const errors: string[] = [];
  client.onError((error) => errors.push(error.message));
  let respond: () => void = () => undefined;
  server.setHandler("tools/call", () => new Promise((resolve) => {
    respond = () => resolve({ content: [] });
  }));
  try {
    const call = client.callTool("wait");
    await new Promise((resolve) => setTimeout(resolve, 0));
    clientTransport.fail(new Error("stray log line"));
    respond();
    assert.deepEqual(await call, { content: [] });
    assert.deepEqual(errors, ["stray log line"]);
  } finally {
    await client.close();
  }
});

test("roots/list is answered and a tool-list notification is delivered", async () => {
  const { clientTransport, server } = await createServer();
  server.setHandler("initialize", legacyInitialize());
  const client = new McpClient({
    name: "test-client",
    version: "1.0.0",
    protocolVersion: "2025-11-25",
    roots: [{ uri: "file:///workspace", name: "workspace" }],
  });
  await client.connect(clientTransport);
  const changed: unknown[] = [];
  client.onNotification("notifications/tools/list_changed", (params) => changed.push(params));
  try {
    await server.transport.send({ jsonrpc: "2.0", id: "roots", method: "roots/list" });
    await server.transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(server.messages.some((message) => "id" in message && message.id === "roots" && "result" in message && JSON.stringify(message.result) === JSON.stringify({ roots: [{ uri: "file:///workspace", name: "workspace" }] })));
    const initialize = requests(server, "initialize")[0];
    assert.deepEqual((requestParams(initialize ?? { jsonrpc: "2.0", id: 0, method: "" }) as { capabilities?: unknown }).capabilities, { roots: {} });
    assert.deepEqual(changed, [undefined]);
  } finally {
    await client.close();
  }
});

test("ping completes and a server cancellation aborts the handler signal", async () => {
  const { clientTransport, server } = await createServer();
  server.setHandler("initialize", legacyInitialize());
  server.setHandler("ping", () => ({}));
  const client = new McpClient({ name: "test-client", version: "1.0.0", protocolVersion: "2025-11-25" });
  let signal: AbortSignal | undefined;
  client.setRequestHandler("slow", (_params, context) => new Promise((_resolve, reject) => {
    signal = context.signal;
    context.signal.addEventListener("abort", () => reject(new McpAbortError()), { once: true });
  }));
  await client.connect(clientTransport);
  try {
    await client.ping();
    await server.transport.send({ jsonrpc: "2.0", id: "slow", method: "slow" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await server.transport.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "slow", reason: "stop" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(signal?.aborted, true);
  } finally {
    await client.close();
  }
});

test("dropping the transport rejects pending work and closes once", async () => {
  const { client, server } = await connectLegacy();
  const closed: number[] = [];
  client.onClose(() => closed.push(1));
  server.setHandler("tools/call", () => new Promise(() => {}));
  const pending = client.callTool("wait", {}, { timeoutMs: 0, maxTimeoutMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await server.transport.close();
  await assert.rejects(pending, /MCP connection closed/);
  assert.equal(client.connectionState, "closed");
  await client.close();
  assert.deepEqual(closed, [1]);
});
