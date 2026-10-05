import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { Client, RemoteError } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { LaneControl } from "../src/control.ts";
import { startCodingBridge } from "../src/bridge.ts";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID, startCodingHost } from "../src/host.ts";

function directory(t: test.TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(ready: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 5_000) throw new Error(label);
    await delay(10);
  }
}

async function openLane(socket: string): Promise<{ client: Client; control: LaneControl; texts: string[] }> {
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  await client.connect();
  const remote = new RuntimeClient(client);
  await remote.attach(HOST_RUNTIME_ID);
  const texts: string[] = [];
  const control = new LaneControl(remote.lane(HOST_LANE), (view) => {
    texts.push(JSON.stringify(view.snapshot));
  });
  await control.open();
  return { client, control, texts };
}

test("a follow-up during an open turn is sent on that drive", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t, "amz-control-");
  const socket = join(cwd, "run.sock");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen: string[] = [];
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: async (context, _options, state) => {
      if (state.callCount === 1) await gate;
      seen.push(JSON.stringify(context.messages));
      return fauxAssistant("ok");
    },
  }));
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const opened = await openLane(socket);
  t.after(() => opened.client.dispose());
  const running = opened.control.submit("hello");
  await until(() => opened.texts.some((text) => text.includes("hello")), "the prompt to appear");
  await opened.control.submit("later");
  release();
  await running;
  assert.match(seen.at(-1) ?? "", /later/);
  assert.equal(opened.control.view().snapshot.operationId, null);
});

test("abort settles the open turn", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t, "amz-abort-");
  const socket = join(cwd, "run.sock");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: async () => {
      await gate;
      return fauxAssistant("ok");
    },
  }));
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const opened = await openLane(socket);
  t.after(() => opened.client.dispose());
  const running = opened.control.submit("stop-me");
  await until(() => opened.control.view().snapshot.operationId !== null, "the turn to open");
  await opened.control.abort();
  release();
  await running;
  assert.equal(opened.control.view().snapshot.operationId, null);
  assert.match(JSON.stringify(opened.control.view().snapshot), /aborted/);
});

test("the loopback bridge renders the lane and refuses another host", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t, "amz-bridge-");
  const socket = join(cwd, "run.sock");
  const models = createModels();
  models.setProvider(fauxProvider({ respond: () => fauxAssistant("from-bridge") }));
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const bridge = await startCodingBridge({ socket, port: 0 });
  t.after(() => bridge.close());
  const view = await fetch(`${bridge.url}view`);
  assert.equal(view.status, 200);
  const page = await fetch(bridge.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /EventSource/);
  const acted = await fetch(`${bridge.url}act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "submit", text: "ping" }),
  });
  assert.equal(acted.status, 200);
  assert.match(await acted.text(), /from-bridge/);
  const forbidden = await request(bridge.url, { host: "evil.example" });
  assert.equal(forbidden.status, 403);
});

test("serve connects mcp.json and fails the open when a server is missing", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t, "amz-mcp-");
  const socket = join(cwd, "run.sock");
  const script = join(cwd, "mcp-server.mjs");
  const pidFile = join(cwd, "mcp.pid");
  writeFileSync(script, `
    import { createInterface } from "node:readline";
    import { writeFileSync } from "node:fs";
    writeFileSync(process.env.MCP_PID_FILE, String(process.pid));
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!("id" in message)) continue;
      if (message.method === "initialize") {
        const protocolVersion = message.params?.protocolVersion ?? "2025-11-25";
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "local", version: "0" } } }) + "\\n");
      } else if (message.method === "tools/list") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }] } }) + "\\n");
      } else if (message.method === "tools/call") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "pong" }] } }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }) + "\\n");
      }
    }
  `);
  mkdirSync(join(cwd, ".amazme"));
  writeFileSync(join(cwd, ".amazme", "mcp.json"), JSON.stringify({
    servers: [{ id: "local", command: process.execPath, args: [script] }],
  }));
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([fauxToolCall("mcp_local__ping", {})])
      : fauxAssistant("after"),
  }));
  const previous = process.env.MCP_PID_FILE;
  process.env.MCP_PID_FILE = pidFile;
  const host = await startCodingHost({
    cwd,
    socket,
    provider: "faux",
    model: "faux-1",
    models,
  });
  t.after(() => host.close());
  t.after(() => {
    if (previous === undefined) delete process.env.MCP_PID_FILE;
    else process.env.MCP_PID_FILE = previous;
  });
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  await client.connect();
  t.after(() => client.dispose());
  const remote = new RuntimeClient(client);
  await remote.attach(HOST_RUNTIME_ID);
  const lane = remote.lane(HOST_LANE);
  const admitted = await lane.accept({ kind: "prompt", text: "use the tool" });
  const outcome = await lane.drive(admitted.operationId);
  assert.equal(outcome.kind, "settled");
  const snapshot = await lane.snapshot();
  assert.match(JSON.stringify(snapshot), /pong/);
  assert.equal(Number.isInteger(Number(readFileSync(pidFile, "utf8"))), true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await host.close();
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, "the MCP process to exit");

  writeFileSync(join(cwd, ".amazme", "mcp.json"), JSON.stringify({
    servers: [{ id: "gone", command: "amazme-mcp-missing-command" }],
  }));
  const again = await startCodingHost({ cwd, socket: join(cwd, "again.sock"), provider: "faux", model: "faux-1", models });
  t.after(() => again.close());
  const second = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: again.socket }) });
  await second.connect();
  t.after(() => second.dispose());
  await assert.rejects(() => new RuntimeClient(second).attach(HOST_RUNTIME_ID), (error: unknown) => error instanceof RemoteError && error.code === "mcp_unavailable");
});

function request(url: string, headers: Record<string, string>): Promise<{ status: number }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: "/",
      headers,
    }, (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.end();
  });
}
