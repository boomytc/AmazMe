import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpClient, StdioTransport } from "@amazme/mcp";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
const stubborn = fileURLToPath(new URL("./fixtures/stubborn-server.mjs", import.meta.url));

test("stdio speaks newline JSON-RPC, captures stderr, and answers a legacy server request", { timeout: 5_000 }, async () => {
  const stderr: string[] = [];
  const transport = new StdioTransport({
    command: process.execPath,
    args: [fixture],
    onStderr: (chunk) => stderr.push(chunk),
  });
  const client = new McpClient({
    name: "stdio-test",
    version: "1.0.0",
    roots: [{ uri: "file:///workspace", name: "workspace" }],
  });
  const errors: Error[] = [];
  client.onError((error) => errors.push(error));
  await client.connect(transport);
  assert.equal(client.protocolEra, "legacy");
  assert.deepEqual(await client.listTools(), [{
    name: "echo",
    description: "file:///workspace",
    inputSchema: { type: "object" },
  }]);
  assert.deepEqual(await client.callTool("echo", { text: "hello" }), {
    content: [{ type: "text", text: "hello" }],
  });
  assert.equal(typeof transport.pid, "number");
  assert.match(stderr.join(""), /stdio fixture ready/);
  assert.match(transport.stderr, /stdio fixture ready/);
  assert.deepEqual(errors, []);
  await client.close();
  assert.equal(client.connectionState, "closed");
});

test("stdio reports an incomplete line when the server exits", { timeout: 5_000 }, async () => {
  const transport = new StdioTransport({
    command: process.execPath,
    args: ["-e", "process.stdout.write('{\"jsonrpc\":\"2.0\"')"],
  });
  const errors: Error[] = [];
  transport.onError((error) => errors.push(error));
  const client = new McpClient({ name: "stdio-test", version: "1.0.0", requestTimeoutMs: 200, maxTimeoutMs: 200 });
  await assert.rejects(client.connect(transport));
  assert.ok(errors.some((error) => error.message.includes("incomplete JSON-RPC message")));
  await client.close();
});

test("stdio rejects a message larger than the configured limit", { timeout: 5_000 }, async () => {
  const transport = new StdioTransport({
    command: process.execPath,
    args: ["-e", "process.stdout.write(`${'x'.repeat(128)}\\n`)"],
    maxMessageBytes: 32,
  });
  const errors: Error[] = [];
  transport.onError((error) => errors.push(error));
  const client = new McpClient({ name: "stdio-test", version: "1.0.0", requestTimeoutMs: 200, maxTimeoutMs: 200 });
  await assert.rejects(client.connect(transport));
  assert.ok(errors.some((error) => error.message.includes("exceeds 32 bytes")));
  await client.close();
});

test("stdio close finishes when the command cannot start", { timeout: 5_000 }, async () => {
  const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
  await assert.rejects(client.connect(new StdioTransport({
    command: "amazme-mcp-no-such-command",
    closeTimeoutMs: 100,
  })));
  assert.equal(client.connectionState, "closed");
});

test("stdio kills a server that ignores shutdown, including its children", { timeout: 10_000, skip: process.platform === "win32" }, async () => {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [stubborn],
    closeTimeoutMs: 100,
  });
  const client = new McpClient({
    name: "stdio-test",
    version: "1.0.0",
    requestTimeoutMs: 100,
    maxTimeoutMs: 100,
  });
  await client.connect(transport);
  let grandchild: number | undefined;
  for (let attempt = 0; attempt < 100 && grandchild === undefined; attempt++) {
    const match = /grandchild (\d+)/.exec(transport.stderr);
    if (match?.[1]) grandchild = Number(match[1]);
    else await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(typeof grandchild, "number");
  const startedAt = Date.now();
  await client.close();
  assert.ok(Date.now() - startedAt < 5_000);
  let alive = true;
  for (let attempt = 0; attempt < 100 && alive; attempt++) {
    try {
      process.kill(grandchild as number, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false);
});

test("stdio drops the whole oversized line across chunks before reading the next message", { timeout: 5_000 }, async () => {
  const transport = new StdioTransport({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(128)); setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'tail'})+'\\n'), 30); setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'next'})+'\\n'), 60)"],
    maxMessageBytes: 64,
  });
  const methods: string[] = [];
  transport.onMessage((message) => { if ("method" in message) methods.push(message.method); });
  const errors: Error[] = [];
  transport.onError((error) => errors.push(error));
  const done = new Promise<void>((resolve) => transport.onClose(resolve));
  await transport.start();
  await done;
  assert.deepEqual(methods, ["next"]);
  assert.equal(errors.length, 1);
  await transport.close();
});

test("stdio close kills descendants even after the parent has exited", { timeout: 5_000, skip: process.platform === "win32" }, async () => {
  const descendantCode = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  const parentCode = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore',1,2]}); console.error('descendant '+child.pid); setTimeout(()=>process.exit(0),80)`;
  const transport = new StdioTransport({ command: process.execPath, args: ["-e", parentCode], closeTimeoutMs: 30 });
  await transport.start();
  let descendant: number | undefined;
  for (let n = 0; n < 100 && !descendant; n++) {
    descendant = Number(/descendant (\d+)/.exec(transport.stderr)?.[1]) || undefined;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(descendant);
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await transport.close();
    let alive = true;
    for (let n = 0; n < 100 && alive; n++) {
      try { process.kill(descendant, 0); } catch { alive = false; }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(alive, false);
  } finally {
    try { process.kill(descendant, "SIGKILL"); } catch { /* Already gone. */ }
  }
});
