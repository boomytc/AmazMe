import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";
import {
  type McpFetch,
  McpAbortError,
  McpAuthRequiredError,
  McpClient,
  McpError,
  McpHttpError,
  McpSessionExpiredError,
  McpTimeoutError,
  MODERN_PROTOCOL_VERSION,
  StreamableHttpTransport,
} from "@amazme/mcp";

interface RecordedRequest {
  method: string;
  headers: IncomingMessage["headers"];
  message?: Record<string, unknown>;
}

const servers: Server[] = [];
const openSockets: Socket[] = [];

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function header(headers: IncomingMessage["headers"], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse, requests: RecordedRequest[]) => Promise<void> | void,
): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response, requests)).catch((error: unknown) => {
      if (response.writableEnded) return;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.on("connection", (socket) => {
    openSockets.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server has no port");
  servers.push(server);
  return { url: `http://127.0.0.1:${address.port}/mcp`, requests };
}

after(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function json(response: ServerResponse, body: unknown, status = 200, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)), ...extra });
  response.end(payload);
}

function discoverBody(id: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      supportedVersions: [MODERN_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "http-fixture", version: "1.0.0" } },
    },
  };
}

function initializeBody(id: unknown, version = "2025-06-18") {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: "http-fixture", version: "1.0.0" },
    },
  };
}

async function recordPost(request: IncomingMessage, requests: RecordedRequest[]): Promise<Record<string, unknown> | undefined> {
  if (request.method === "GET" || request.method === "DELETE") {
    requests.push({ method: request.method, headers: request.headers });
    return undefined;
  }
  const raw = await readBody(request);
  const message = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
  requests.push({ method: request.method ?? "", headers: request.headers, ...(message ? { message } : {}) });
  return message;
}

function toolResult(id: unknown, text = "ok") {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
}

test("modern HTTP mirrors protocol headers and does not use sessions", { timeout: 5_000 }, async () => {
  const { url, requests } = await listen(async (request, response, recorded) => {
    const message = await recordPost(request, recorded);
    if (request.method !== "POST" || !message) {
      response.statusCode = 405;
      response.end();
      return;
    }
    if (message.method === "server/discover") {
      json(response, discoverBody(message.id), 200, { "mcp-session-id": "ignore-me" });
      return;
    }
    if (message.method === "resources/read") {
      const uri = (message.params as { uri?: string } | undefined)?.uri ?? "";
      json(response, { jsonrpc: "2.0", id: message.id, result: { contents: [{ uri, text: "body" }] } });
      return;
    }
    if (message.method === "prompts/get") {
      json(response, { jsonrpc: "2.0", id: message.id, result: { messages: [] } });
      return;
    }
    json(response, toolResult(message.id));
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHttpTransport({ url }));
  assert.equal(client.protocolEra, "modern");
  const names = ["get_weather", "Hello, 世界", "=?base64?literal?=", " padded "];
  for (const name of names) {
    assert.deepEqual(await client.callTool(name, { region: "us-west1" }), { content: [{ type: "text", text: "ok" }] });
  }
  assert.deepEqual(await client.readResource("file:///tmp/a b.txt"), {
    contents: [{ uri: "file:///tmp/a b.txt", text: "body" }],
  });
  assert.deepEqual(await client.request("prompts/get", { name: "review" }), { messages: [] });
  await client.close();

  const discover = requests.find((entry) => entry.message?.method === "server/discover");
  assert.equal(header(discover?.headers ?? {}, "mcp-protocol-version"), MODERN_PROTOCOL_VERSION);
  assert.equal(header(discover?.headers ?? {}, "mcp-method"), "server/discover");
  assert.equal(header(discover?.headers ?? {}, "mcp-session-id"), undefined);
  const meta = (discover?.message?.params as { _meta?: Record<string, string> } | undefined)?._meta;
  assert.equal(meta?.["io.modelcontextprotocol/protocolVersion"], MODERN_PROTOCOL_VERSION);
  const encoded = new Map<string, string>([
    ["get_weather", "get_weather"],
    ["Hello, 世界", "=?base64?SGVsbG8sIOS4lueVjA==?="],
    ["=?base64?literal?=", "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="],
    [" padded ", "=?base64?IHBhZGRlZCA=?="],
  ]);
  for (const [name, expected] of encoded) {
    const call = requests.find((entry) => (entry.message?.params as { name?: string } | undefined)?.name === name);
    assert.equal(header(call?.headers ?? {}, "mcp-method"), "tools/call");
    assert.equal(header(call?.headers ?? {}, "mcp-name"), expected);
    assert.equal(header(call?.headers ?? {}, "mcp-protocol-version"), MODERN_PROTOCOL_VERSION);
    assert.equal(header(call?.headers ?? {}, "mcp-session-id"), undefined);
    assert.equal(header(call?.headers ?? {}, "mcp-param-region"), undefined);
    assert.match(header(call?.headers ?? {}, "accept") ?? "", /application\/json/);
    assert.match(header(call?.headers ?? {}, "accept") ?? "", /text\/event-stream/);
  }
  const read = requests.find((entry) => entry.message?.method === "resources/read");
  assert.equal(header(read?.headers ?? {}, "mcp-name"), "file:///tmp/a b.txt");
  const prompt = requests.find((entry) => entry.message?.method === "prompts/get");
  assert.equal(header(prompt?.headers ?? {}, "mcp-name"), "review");
  assert.equal(requests.some((entry) => entry.method === "GET" || entry.method === "DELETE"), false);
});

test("HTTP falls back only when discover returns 400 without a modern JSON-RPC error", { timeout: 5_000 }, async () => {
  const { url, requests } = await listen(async (request, response, recorded) => {
    const message = await recordPost(request, recorded);
    if (request.method === "DELETE") {
      response.statusCode = 200;
      response.end();
      return;
    }
    if (request.method === "GET") {
      response.statusCode = 405;
      response.end();
      return;
    }
    if (message?.method === "server/discover") {
      response.statusCode = 400;
      response.end("not a protocol endpoint");
      return;
    }
    if (message?.method === "initialize") {
      json(response, initializeBody(message.id), 200, { "mcp-session-id": "session-1" });
      return;
    }
    if (!message || !("id" in message)) {
      response.statusCode = 202;
      response.end();
      return;
    }
    json(response, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  const errors: Error[] = [];
  client.onError((error) => errors.push(error));
  await client.connect(new StreamableHttpTransport({ url }));
  assert.equal(client.protocolEra, "legacy");
  assert.equal(client.protocolVersion, "2025-06-18");
  assert.deepEqual(await client.listTools(), [{ name: "echo", inputSchema: { type: "object" } }]);
  await client.close();

  const discover = requests.find((entry) => entry.message?.method === "server/discover");
  const initialize = requests.find((entry) => entry.message?.method === "initialize");
  const list = requests.find((entry) => entry.message?.method === "tools/list");
  assert.equal(header(initialize?.headers ?? {}, "mcp-method"), undefined);
  assert.equal(header(initialize?.headers ?? {}, "mcp-protocol-version"), undefined);
  assert.equal(header(list?.headers ?? {}, "mcp-method"), undefined);
  assert.equal(header(list?.headers ?? {}, "mcp-name"), undefined);
  assert.equal(header(list?.headers ?? {}, "mcp-protocol-version"), "2025-06-18");
  assert.equal(header(list?.headers ?? {}, "mcp-session-id"), "session-1");
  const order = requests.map((entry) => entry.message?.method ?? entry.method);
  assert.ok(order.indexOf("GET") > order.indexOf("notifications/initialized"));
  assert.equal(header(requests.find((entry) => entry.method === "GET")?.headers ?? {}, "last-event-id"), undefined);
  assert.equal(header(requests.find((entry) => entry.method === "DELETE")?.headers ?? {}, "mcp-session-id"), "session-1");
  assert.equal(header(discover?.headers ?? {}, "mcp-method"), "server/discover");
  assert.deepEqual(errors, []);
});

test("HTTP 400 with a non-modern JSON-RPC body still falls back", { timeout: 5_000 }, async () => {
  const { url, requests } = await listen(async (request, response, recorded) => {
    const message = await recordPost(request, recorded);
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    if (message?.method === "server/discover") {
      json(response, { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "nope" } }, 400);
      return;
    }
    if (message?.method === "initialize") {
      json(response, initializeBody(message.id, "2025-11-25"));
      return;
    }
    response.statusCode = 202;
    response.end();
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
  assert.equal(client.protocolEra, "legacy");
  assert.equal(client.protocolVersion, "2025-11-25");
  assert.equal(requests.some((entry) => entry.message?.method === "initialize"), true);
  await client.close();
});

const refusals: Array<{ name: string; status: number; body: string | ((id: unknown) => unknown); code?: number; http?: boolean }> = [
  {
    name: "HTTP 400 UnsupportedProtocolVersion does not initialize",
    status: 400,
    body: (id) => ({ jsonrpc: "2.0", id, error: { code: -32022, message: "unsupported", data: { supported: ["1999-01-01"], requested: MODERN_PROTOCOL_VERSION } } }),
    code: -32022,
  },
  {
    name: "HTTP 400 MissingRequiredClientCapability does not initialize",
    status: 400,
    body: (id) => ({ jsonrpc: "2.0", id, error: { code: -32021, message: "missing capability" } }),
    code: -32021,
  },
  {
    name: "HTTP 400 HeaderMismatch does not initialize",
    status: 400,
    body: (id) => ({ jsonrpc: "2.0", id, error: { code: -32020, message: "header mismatch" } }),
    code: -32020,
  },
  {
    name: "HTTP 404 method-not-found does not initialize",
    status: 404,
    body: (id) => ({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }),
    code: -32601,
  },
  { name: "HTTP 404 without a JSON-RPC body is not HTTP+SSE", status: 404, body: "", http: true },
  { name: "HTTP 405 without a JSON-RPC body is not HTTP+SSE", status: 405, body: "", http: true },
  { name: "HTTP 500 does not fall back to initialize", status: 500, body: "unavailable", http: true },
];

for (const entry of refusals) {
  test(entry.name, { timeout: 5_000 }, async () => {
    const { url, requests } = await listen(async (request, response, recorded) => {
      const message = await recordPost(request, recorded);
      if (message?.method !== "server/discover") {
        response.statusCode = 500;
        response.end("unexpected follow-up");
        return;
      }
      if (typeof entry.body === "function") json(response, entry.body(message.id), entry.status);
      else {
        response.statusCode = entry.status;
        response.end(entry.body);
      }
    });
    const client = new McpClient({ name: "http-test", version: "1.0.0" });
    await assert.rejects(client.connect(new StreamableHttpTransport({ url })), (error: unknown) => {
      if (entry.http) {
        assert.ok(error instanceof McpHttpError);
        assert.equal(error.status, entry.status);
        if (entry.status === 404 || entry.status === 405) assert.match(error.message, /HTTP\+SSE/);
      } else {
        assert.ok(error instanceof McpError);
        assert.equal(error.code, entry.code);
      }
      return true;
    });
    assert.equal(requests.some((item) => item.message?.method === "initialize"), false);
  });
}

test("HTTP discover timeout does not initialize or send notifications/cancelled", { timeout: 2_000 }, async () => {
  const { url, requests } = await listen(async (request, response, recorded) => {
    const message = await recordPost(request, recorded);
    if (message?.method !== "server/discover") {
      response.statusCode = 500;
      response.end("unexpected");
    }
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0", requestTimeoutMs: 40, maxTimeoutMs: 40 });
  await assert.rejects(client.connect(new StreamableHttpTransport({ url })), (error: unknown) => {
    assert.ok(error instanceof McpTimeoutError);
    return true;
  });
  assert.deepEqual(requests.map((item) => item.message?.method), ["server/discover"]);
});

test("a chunked SSE body reassembles one JSON-RPC message", { timeout: 5_000 }, async () => {
  const encoder = new TextEncoder();
  const fetchImpl: McpFetch = async (_input, init) => {
    const message = JSON.parse(String(init?.body)) as { id?: number; method?: string };
    if (message.method === "server/discover") {
      return new Response(JSON.stringify(discoverBody(message.id)), { headers: { "content-type": "application/json" } });
    }
    const chunks = [
      ": keepalive\r\nid: 7\r\ndata: {\"jsonrpc\":\"2.0\",\r\n",
      `data: "id":${String(message.id)},"result":{"content":[{"type":"text","text":"split"}]}}\r\n\r\n`,
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  };
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHttpTransport({ url: "http://127.0.0.1/mcp", fetch: fetchImpl, openGetStream: false }));
  assert.deepEqual(await client.callTool("echo"), { content: [{ type: "text", text: "split" }] });
  await client.close();
});

test("an SSE event without a blank line fails once it passes the size limit", { timeout: 5_000 }, async () => {
  const encoder = new TextEncoder();
  const fetchImpl: McpFetch = async (_input, init) => {
    const message = JSON.parse(String(init?.body)) as { method?: string; id?: number };
    if (message.method === "server/discover") {
      return new Response(JSON.stringify(discoverBody(message.id)), { headers: { "content-type": "application/json" } });
    }
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("data: xxxxxxxxxxxxxxxx\n"));
      },
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHttpTransport({
    url: "http://127.0.0.1/mcp",
    fetch: fetchImpl,
    openGetStream: false,
    maxMessageBytes: 256,
  }));
  await assert.rejects(client.callTool("echo"), (error: unknown) => {
    assert.ok(error instanceof McpError);
    assert.match(error.message, /exceeds 256 bytes/);
    return true;
  });
  await client.close();
});

test("modern SSE does not resume with Last-Event-ID", { timeout: 5_000 }, async () => {
  const { url, requests } = await listen(async (request, response, recorded) => {
    const message = await recordPost(request, recorded);
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    if (message?.method === "server/discover") {
      json(response, discoverBody(message.id));
      return;
    }
    const name = (message?.params as { name?: string } | undefined)?.name;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(name === "primed" ? "id: 1\ndata:\n\n" : ": nothing here\n\n");
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHttpTransport({ url }));
  await assert.rejects(client.callTool("primed"), /stream ended without a response/);
  await assert.rejects(client.callTool("empty"), /stream ended without a response/);
  assert.equal(requests.some((entry) => entry.method === "GET"), false);
  await client.close();
});

test("legacy HTTP resumes a response stream that closed after assigning an event id", { timeout: 5_000 }, async () => {
  let pendingId: unknown;
  const { url, requests } = await listen(async (request, response, recorded) => {
    if (request.method === "GET" && header(request.headers, "last-event-id")) {
      recorded.push({ method: "GET", headers: request.headers });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`id: 2\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: pendingId, result: { content: [{ type: "text", text: "resumed" }] } })}\n\n`);
      return;
    }
    const message = await recordPost(request, recorded);
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    if (message?.method === "initialize") {
      json(response, initializeBody(message.id), 200, { "mcp-session-id": "session-1" });
      return;
    }
    if (message?.method === "tools/call") {
      pendingId = message.id;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("id: 1\nretry: 5\ndata:\n\n");
      return;
    }
    response.statusCode = 202;
    response.end();
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0", protocolVersion: "2025-11-25" });
  const errors: Error[] = [];
  client.onError((error) => errors.push(error));
  await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
  assert.deepEqual(await client.callTool("echo"), { content: [{ type: "text", text: "resumed" }] });
  assert.deepEqual(requests.filter((entry) => entry.method === "GET").map((entry) => header(entry.headers, "last-event-id")), ["1"]);
  assert.deepEqual(errors, []);
  await client.close();
});

test("legacy GET stream reconnects with Last-Event-ID after it drops", { timeout: 5_000 }, async () => {
  let gets = 0;
  const lastEventIds: Array<string | undefined> = [];
  const { url } = await listen(async (request, response, recorded) => {
    if (request.method === "GET") {
      gets += 1;
      lastEventIds.push(header(request.headers, "last-event-id"));
      recorded.push({ method: "GET", headers: request.headers });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const notification = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
      if (gets === 1) {
        response.end(`id: g1\ndata: ${JSON.stringify(notification)}\n\n`);
        return;
      }
      response.write(`id: g2\ndata: ${JSON.stringify(notification)}\n\n`);
      return;
    }
    if (request.method === "DELETE") {
      response.statusCode = 200;
      response.end();
      return;
    }
    const message = await recordPost(request, recorded);
    if (message?.method === "initialize") {
      json(response, initializeBody(message.id), 200, { "mcp-session-id": "session-1" });
      return;
    }
    response.statusCode = 202;
    response.end();
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0", protocolVersion: "2025-11-25" });
  let changes = 0;
  const second = new Promise<void>((resolve) => {
    client.onNotification("notifications/tools/list_changed", () => {
      if (++changes === 2) resolve();
    });
  });
  await client.connect(new StreamableHttpTransport({ url, reconnect: { initialDelayMs: 1, maxRetries: 2 } }));
  await second;
  assert.deepEqual(lastEventIds, [undefined, "g1"]);
  await client.close();
});

test("HTTP 202 on a request that needs a body fails that request", { timeout: 5_000 }, async () => {
  const { url } = await listen(async (request, response, recorded) => {
    const message = await recordPost(request, recorded);
    if (message?.method === "server/discover") {
      json(response, discoverBody(message.id));
      return;
    }
    response.statusCode = 202;
    response.end();
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
  await assert.rejects(client.callTool("echo"), /without a response/);
  await client.close();
});

test("one broken SSE response does not fail another in-flight call", { timeout: 5_000 }, async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { url } = await listen(async (request, response, recorded) => {
    const message = await recordPost(request, recorded);
    if (message?.method === "server/discover") {
      json(response, discoverBody(message.id));
      return;
    }
    const name = (message?.params as { name?: string } | undefined)?.name;
    if (name === "slow") await gate;
    if (name === "broken") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: not json\n\n");
      return;
    }
    json(response, toolResult(message?.id));
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  const errors: Error[] = [];
  client.onError((error) => errors.push(error));
  await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
  const slow = client.callTool("slow");
  await assert.rejects(client.callTool("broken"), /MCP response stream failed/);
  release();
  assert.deepEqual(await slow, { content: [{ type: "text", text: "ok" }] });
  assert.equal(errors.length, 1);
  await client.close();
});

test("aborting one modern HTTP call does not cancel the others or send notifications/cancelled", { timeout: 5_000 }, async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closed: string[] = [];
  const { url, requests } = await listen(async (request, response, recorded) => {
    const message = await recordPost(request, recorded);
    if (message?.method === "server/discover") {
      json(response, discoverBody(message.id));
      return;
    }
    const name = (message?.params as { name?: string } | undefined)?.name ?? "";
    if (name === "stop") {
      response.on("close", () => {
        if (!response.writableEnded) closed.push(name);
      });
      await new Promise(() => undefined);
      return;
    }
    if (name === "slow") await gate;
    json(response, toolResult(message?.id));
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
  const controller = new AbortController();
  const stopped = client.callTool("stop", {}, { signal: controller.signal });
  const slow = client.callTool("slow");
  for (let attempt = 0; attempt < 50 && requests.filter((entry) => entry.message?.method === "tools/call").length < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort();
  await assert.rejects(stopped, (error: unknown) => {
    assert.ok(error instanceof McpAbortError);
    return true;
  });
  for (let attempt = 0; attempt < 50 && closed.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(closed, ["stop"]);
  assert.equal(requests.some((entry) => entry.message?.method === "notifications/cancelled"), false);
  release();
  assert.deepEqual(await slow, { content: [{ type: "text", text: "ok" }] });
  await client.close();
});

test("a JSON array body delivers each message", { timeout: 5_000 }, async () => {
  const { url } = await listen(async (request, response, recorded) => {
    const message = await recordPost(request, recorded);
    if (message?.method === "server/discover") {
      json(response, discoverBody(message.id));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{ jsonrpc: "2.0", id: message?.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }]));
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
  assert.deepEqual(await client.listTools(), [{ name: "echo", inputSchema: { type: "object" } }]);
  await client.close();
});

test("401 and insufficient_scope 403 retry once with the replacement token", { timeout: 5_000 }, async () => {
  const seen: Array<{ status: number; token?: string }> = [];
  let token = "old";
  const { url } = await listen(async (request, response, recorded) => {
    const message = await recordPost(request, recorded);
    if (header(request.headers, "authorization") === "Bearer old") {
      response.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }
    if (message?.method === "tools/call" && header(request.headers, "authorization") === "Bearer new") {
      response.writeHead(403, { "www-authenticate": "Bearer error=\"insufficient_scope\", scope=\"admin\"" }).end();
      return;
    }
    if (message?.method === "server/discover") {
      json(response, discoverBody(message.id));
      return;
    }
    json(response, toolResult(message?.id, "hello"));
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHttpTransport({
    url,
    openGetStream: false,
    authProvider: {
      token: async () => token,
      onUnauthorized: async ({ response, token: rejected }) => {
        seen.push({ status: response.status, ...(rejected ? { token: rejected } : {}) });
        token = response.status === 401 ? "new" : "admin";
      },
    },
  }));
  assert.deepEqual(await client.callTool("echo"), { content: [{ type: "text", text: "hello" }] });
  assert.deepEqual(seen, [
    { status: 401, token: "old" },
    { status: 403, token: "new" },
  ]);
  await client.close();
});

test("a second 401 fails without putting the bearer token in the error", { timeout: 5_000 }, async () => {
  let refreshes = 0;
  const { url } = await listen(async (request, response) => {
    await readBody(request);
    response.writeHead(401, { "www-authenticate": "Bearer" }).end("denied");
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  await assert.rejects(client.connect(new StreamableHttpTransport({
    url,
    authProvider: {
      token: async () => "super-secret-token",
      onUnauthorized: async () => {
        refreshes += 1;
      },
    },
  })), (error: unknown) => {
    assert.ok(error instanceof McpAuthRequiredError);
    assert.equal(error.status, 401);
    assert.equal(error.body, "denied");
    assert.equal(JSON.stringify(error).includes("super-secret-token"), false);
    return true;
  });
  assert.equal(refreshes, 1);
});

test("403 without insufficient_scope does not refresh", { timeout: 5_000 }, async () => {
  let refreshes = 0;
  const { url } = await listen(async (request, response) => {
    await readBody(request);
    response.writeHead(403, { "www-authenticate": "Bearer error=\"invalid_token\"" }).end("nope");
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  await assert.rejects(client.connect(new StreamableHttpTransport({
    url,
    authProvider: {
      token: async () => "token",
      onUnauthorized: async () => {
        refreshes += 1;
      },
    },
  })), (error: unknown) => {
    assert.ok(error instanceof McpHttpError);
    assert.equal(error instanceof McpAuthRequiredError, false);
    assert.equal(error.status, 403);
    return true;
  });
  assert.equal(refreshes, 0);
});

test("concurrent 401s share one refresh", { timeout: 5_000 }, async () => {
  let refreshes = 0;
  let active = 0;
  let maxActive = 0;
  let token: string | undefined;
  const { url } = await listen(async (request, response, recorded) => {
    const message = await recordPost(request, recorded);
    if (message?.method === "tools/call" && header(request.headers, "authorization") !== "Bearer fresh") {
      response.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }
    if (message?.method === "server/discover") {
      json(response, discoverBody(message.id));
      return;
    }
    json(response, toolResult(message?.id));
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHttpTransport({
    url,
    openGetStream: false,
    authProvider: {
      token: async () => token,
      onUnauthorized: async () => {
        refreshes += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        token = "fresh";
      },
    },
  }));
  const [first, second] = await Promise.all([client.callTool("echo"), client.callTool("echo")]);
  assert.deepEqual(first, { content: [{ type: "text", text: "ok" }] });
  assert.deepEqual(second, { content: [{ type: "text", text: "ok" }] });
  assert.equal(refreshes, 1);
  assert.equal(maxActive, 1);
  await client.close();
});

test("fetch is called without a receiver", { timeout: 5_000 }, async () => {
  const realFetch = globalThis.fetch;
  const strictFetch: McpFetch = function (this: unknown, input, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return realFetch(input, init);
  };
  const { url } = await listen(async (request, response, recorded) => {
    const message = await recordPost(request, recorded);
    if (header(request.headers, "authorization") === undefined) {
      response.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }
    if (message?.method === "server/discover") {
      json(response, discoverBody(message.id));
      return;
    }
    json(response, { jsonrpc: "2.0", id: message?.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
  });
  const connect = async (fetchImpl: McpFetch | undefined) => {
    let token: string | undefined;
    const client = new McpClient({ name: "http-test", version: "1.0.0" });
    await client.connect(new StreamableHttpTransport({
      url,
      fetch: fetchImpl,
      openGetStream: false,
      authProvider: {
        token: async () => token,
        onUnauthorized: async (context) => {
          await (await context.fetch(url)).body?.cancel();
          token = "token";
        },
      },
    }));
    assert.deepEqual(await client.listTools(), [{ name: "echo", inputSchema: { type: "object" } }]);
    await client.close();
  };
  await connect(strictFetch);
  globalThis.fetch = strictFetch as typeof globalThis.fetch;
  try {
    await connect(undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an established legacy session returns session expired on HTTP 404", { timeout: 5_000 }, async () => {
  let posts = 0;
  const { url } = await listen(async (request, response, recorded) => {
    if (request.method === "POST" && posts >= 2) {
      await readBody(request);
      response.statusCode = 404;
      response.end("gone");
      return;
    }
    const message = await recordPost(request, recorded);
    if (request.method === "POST") posts += 1;
    if (message?.method === "initialize") {
      json(response, initializeBody(message.id), 200, { "mcp-session-id": "session-1" });
      return;
    }
    response.statusCode = 202;
    response.end();
  });
  const client = new McpClient({ name: "http-test", version: "1.0.0", protocolVersion: "2025-11-25" });
  await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
  await assert.rejects(client.listTools(), (error: unknown) => {
    assert.ok(error instanceof McpSessionExpiredError);
    assert.equal(error.status, 404);
    assert.equal(error.body, "gone");
    return true;
  });
  await client.close();
});
