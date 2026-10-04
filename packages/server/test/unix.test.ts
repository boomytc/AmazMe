import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, ClientError, RemoteError } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { encodeClientMessage, encodeServerMessage, ServerMessageDecoder, type ServerMessage } from "@amazme/protocol";
import { Server, type ByteConnection, type ByteConnectionHandlers } from "@amazme/server";
import { listenUnix, type UnixListener } from "@amazme/server/unix";

function scratch(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amz-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const mode = (path: string) => (lstatSync(path).mode & 0o777).toString(8);

function echoServer(errors: Error[] = []) {
  return new Server({
    serverId: "srv",
    openRuntime: () => Promise.resolve(null),
    service: { call: (call) => call },
    onError: (error) => errors.push(error),
  });
}

/** A raw socket peer that decodes whatever the server sends. */
async function rawPeer(path: string) {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const messages: ServerMessage[] = [];
  const decoder = new ServerMessageDecoder();
  let closed = false;
  socket.on("data", (chunk: Buffer) => messages.push(...decoder.push(new Uint8Array(chunk))));
  socket.on("close", () => { closed = true; });
  socket.on("error", () => undefined);
  return { socket, messages, closed: () => closed };
}

test("the listener makes private directories and a 0600 socket, and leaves an existing directory's mode alone", async (t) => {
  const base = scratch(t);
  const nested = join(base, "a", "b");
  const listener = await listenUnix(echoServer(), { path: join(nested, "s.sock") });
  assert.equal(mode(join(base, "a")), "700");
  assert.equal(mode(nested), "700");
  assert.equal(mode(listener.path), "600");
  assert.ok(lstatSync(listener.path).isSocket());
  const privateNames = readdirSync(nested).filter((name) => name.startsWith(".amazme-bind-"));
  assert.equal(privateNames.length, 1);
  const privatePath = join(nested, privateNames[0]!);
  assert.equal(mode(privatePath), "700");
  const anchor = lstatSync(join(privatePath, "owned"));
  assert.ok(anchor.isSocket());
  assert.equal(anchor.dev, lstatSync(listener.path).dev);
  assert.equal(anchor.ino, lstatSync(listener.path).ino, "a private hard link prevents socket inode reuse until cleanup");
  await listener.close();
  assert.equal(existsSync(listener.path), false);
  assert.deepEqual(readdirSync(nested), [], "no bind or cleanup names are left behind");

  const shared = join(base, "shared");
  mkdirSync(shared);
  chmodSync(shared, 0o755);
  const second = await listenUnix(echoServer(), { path: join(shared, "s.sock") });
  assert.equal(mode(shared), "755");
  await second.close();
});

test("a regular file, a live socket, or any leftover socket at the path is refused without probing", async (t) => {
  const dir = scratch(t);
  const file = join(dir, "file.sock");
  writeFileSync(file, "keep me");
  await assert.rejects(listenUnix(echoServer(), { path: file }), /not a socket/);
  assert.equal(readFileSync(file, "utf8"), "keep me");

  const path = join(dir, "s.sock");
  const first = await listenUnix(echoServer(), { path });
  t.after(() => first.close());
  const attempt = listenUnix(echoServer(), { path });
  t.after(async () => (await attempt.catch(() => undefined))?.close());
  await assert.rejects(attempt, /already exists/);
  assert.equal(first.connectionCount, 0, "rejecting an existing socket makes no probe connection");
  const client = new Client({ serverId: "srv", transport: createUnixTransport({ path }) });
  await client.connect();
  assert.equal(await client.request(client.serverRoute(), "still served"), "still served");
  await client.dispose();

  const stale = join(dir, "stale.sock");
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(stale)}, () => process.stdout.write("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.ok(lstatSync(stale).isSocket(), "the killed process left a stale socket");
  const refused = listenUnix(echoServer(), { path: stale });
  t.after(async () => (await refused.catch(() => undefined))?.close());
  await assert.rejects(refused, /already exists/);
  assert.ok(lstatSync(stale).isSocket(), "connection refusal never authorizes deleting somebody else's socket");
  await first.close();
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".")), [], "no private bind directory is left");
});

test("closing removes only a socket this listener still owns", async (t) => {
  const dir = scratch(t);
  const path = join(dir, "s.sock");
  const moved = await listenUnix(echoServer(), { path });
  t.after(() => moved.close());
  renameSync(path, `${path}.moved`);
  writeFileSync(path, "replacement");
  await moved.close();
  assert.equal(readFileSync(path, "utf8"), "replacement");
  assert.ok(lstatSync(`${path}.moved`).isSocket());
  unlinkSync(path);
  unlinkSync(`${path}.moved`);

  const old = await listenUnix(echoServer(), { path });
  t.after(() => old.close());
  const oldIdentity = lstatSync(path);
  unlinkSync(path);
  const fresh = await listenUnix(echoServer(), { path });
  t.after(() => fresh.close());
  assert.notEqual(lstatSync(path).ino, oldIdentity.ino, "the old private link keeps its inode reserved");
  await old.close();
  assert.ok(lstatSync(path).isSocket(), "the newer listener's socket survived");
  const client = new Client({ serverId: "srv", transport: createUnixTransport({ path }) });
  await client.connect();
  await client.dispose();
  await fresh.close();
  assert.equal(existsSync(path), false);
  assert.deepEqual(readdirSync(dir), []);
});

test("listen failures reject and leave nothing behind", async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "not-a-dir"), "");
  await assert.rejects(listenUnix(echoServer(), { path: join(dir, "not-a-dir", "s.sock") }));
  const locked = join(dir, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  await assert.rejects(listenUnix(echoServer(), { path: join(locked, "s.sock") }), (error) => (error as NodeJS.ErrnoException).code === "EACCES");
  chmodSync(locked, 0o700);
  assert.deepEqual(readdirSync(locked), []);
  assert.deepEqual(readdirSync(dir).sort(), ["locked", "not-a-dir"]);
  await assert.rejects(Promise.resolve().then(() => listenUnix(echoServer(), { path: "" })), TypeError);
});

test("connection writes keep byte order, wait for drain and stay inside the byte bound", async (t) => {
  const dir = scratch(t);
  const connections: ByteConnection[] = [];
  const acceptor = { accept: (connection: ByteConnection): ByteConnectionHandlers => {
    connections.push(connection);
    return { onData: () => undefined, onClose: () => undefined, onError: () => undefined };
  } };
  const listener = await listenUnix(acceptor, { path: join(dir, "s.sock"), maxQueuedBytes: 1024 * 1024 });
  t.after(() => listener.close());
  const reader = createConnection(listener.path);
  await new Promise<void>((resolve) => reader.once("connect", resolve));
  reader.pause();
  await until(() => connections.length === 1);
  const connection = connections[0]!;
  const chunk = (index: number) => new Uint8Array(64 * 1024).fill(index % 251);
  const accepted: number[] = [];
  const rejected: number[] = [];
  const sends = Array.from({ length: 40 }, (_, index) => connection.send(chunk(index)).then(() => accepted.push(index), () => rejected.push(index)));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(rejected.length > 0, "sends past the byte bound are rejected");
  assert.ok(accepted.length < 40 - rejected.length, "a reader that stopped holds sends back");
  const expected = 40 - rejected.length;
  const received: Buffer[] = [];
  reader.on("data", (data: Buffer) => received.push(data));
  reader.resume();
  await Promise.all(sends);
  assert.equal(accepted.length, expected);
  await until(() => received.reduce((sum, part) => sum + part.length, 0) === expected * 64 * 1024, "every accepted byte");
  const all = Buffer.concat(received);
  const order = Array.from({ length: 40 }, (_, index) => index).filter((index) => !rejected.includes(index));
  order.forEach((index, position) => assert.equal(all[position * 64 * 1024], index % 251));
  reader.destroy();
});

test("the protocol over a Unix socket handles byte-by-byte and coalesced writes", async (t) => {
  const dir = scratch(t);
  const server = echoServer();
  const listener = await listenUnix(server, { path: join(dir, "s.sock") });
  t.after(async () => { await server.close(); await listener.close(); });
  const peer = await rawPeer(listener.path);
  const hello = encodeClientMessage({ type: "hello", version: 1 });
  const one = encodeClientMessage({ type: "request", id: "r1", route: { serverId: "srv" }, call: { n: 1 } });
  const two = encodeClientMessage({ type: "request", id: "r2", route: { serverId: "srv" }, call: "two" });
  peer.socket.write(Buffer.concat([hello, one, two]));
  const three = encodeClientMessage({ type: "request", id: "r3", route: { serverId: "srv" }, call: ["é", 3] });
  for (const byte of three) {
    peer.socket.write(Buffer.from([byte]));
    await new Promise((resolve) => setImmediate(resolve));
  }
  await until(() => peer.messages.length === 4, "four server messages");
  assert.deepEqual(peer.messages.map((message) => message.type === "response" && message.ok ? message.result : message.type), ["hello", { n: 1 }, "two", ["é", 3]]);
  peer.socket.destroy();
});

test("oversized frames, half frames at end of stream and resets close the connection and free it", async (t) => {
  const dir = scratch(t);
  const errors: Error[] = [];
  const server = echoServer(errors);
  const listener = await listenUnix(server, { path: join(dir, "s.sock") });
  t.after(async () => { await server.close(); await listener.close(); });
  const hello = encodeClientMessage({ type: "hello", version: 1 });

  const oversized = await rawPeer(listener.path);
  oversized.socket.write(hello);
  await until(() => oversized.messages.length === 1, "the server hello");
  oversized.socket.write(Buffer.from([0x40, 0, 0, 0]));
  await until(oversized.closed, "the oversized connection to close");
  assert.deepEqual(oversized.messages.map((message) => message.type === "hello_error" ? message.error.code : message.type), ["hello", "protocol_error"]);

  const half = await rawPeer(listener.path);
  half.socket.end(Buffer.concat([hello, encodeClientMessage({ type: "request", id: "r", route: { serverId: "srv" }, call: 1 }).subarray(0, 6)]));
  await until(half.closed, "the half-frame connection to close");
  await until(() => errors.some((error) => /inside a frame/.test(error.message)), "the truncated frame to be reported");

  const reset = await rawPeer(listener.path);
  reset.socket.write(hello);
  await until(() => reset.messages.length === 1);
  reset.socket.destroy();
  await until(() => server.connectionCount === 0 && listener.connectionCount === 0, "every connection to be released");
});

test("the client Unix transport checks the logical ID, reports a mid-frame end and never reconnects", async (t) => {
  const dir = scratch(t);
  const server = echoServer();
  const listener = await listenUnix(server, { path: join(dir, "s.sock") });
  t.after(async () => { await server.close(); await listener.close(); });
  const wrong = new Client({ serverId: "elsewhere", transport: createUnixTransport({ path: listener.path }) });
  await assert.rejects(wrong.connect(), (error) => error instanceof ClientError && error.code === "server_mismatch");
  const missing = new Client({ serverId: "srv", transport: createUnixTransport({ path: join(dir, "absent.sock") }) });
  await assert.rejects(missing.connect(), (error) => error instanceof ClientError && error.code === "transport_error" && /ENOENT/.test(error.message));

  const brokenPath = join(dir, "broken.sock");
  const sockets: Socket[] = [];
  const broken = createServer((socket) => {
    sockets.push(socket);
    socket.once("data", () => {
      socket.write(encodeServerMessage({ type: "hello", version: 1, serverId: "srv" }));
      setTimeout(() => socket.end(encodeServerMessage({ type: "attachment", attachment: null }).subarray(0, 5)), 20);
    });
  });
  await new Promise<void>((resolve) => broken.listen(brokenPath, resolve));
  t.after(() => new Promise<void>((resolve) => broken.close(() => resolve())));
  let opened = 0;
  const factory = createUnixTransport({ path: brokenPath });
  const client = new Client({ serverId: "srv", transport: (handlers) => { opened += 1; return factory(handlers); } });
  const states: Array<string | undefined> = [];
  client.onStateChange((state, error) => states.push(`${state}:${(error as ClientError | RemoteError | undefined)?.code ?? ""}`));
  await client.connect();
  await until(() => client.state === "disconnected", "the mid-frame end");
  assert.deepEqual(states, ["connecting:", "connected:", "disconnected:protocol_error"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(opened, 1);

  const limited = new Client({ serverId: "srv", transport: createUnixTransport({ path: listener.path, maxQueuedBytes: 256 }) });
  await limited.connect();
  await assert.rejects(limited.request(limited.serverRoute(), "x".repeat(1024)), (error) => error instanceof ClientError && error.code === "transport_error");
  assert.equal(limited.state, "disconnected");
  for (const socket of sockets) socket.destroy();
});

test("the Unix entries report Windows as unsupported", async (t) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", original));
  assert.throws(() => createUnixTransport({ path: "/tmp/x.sock" }), /not supported on Windows/);
  await assert.rejects(listenUnix(echoServer(), { path: "/tmp/x.sock" }), /not supported on Windows/);
});

test("a graceful connection close destroys a peer that never reads once the timeout passes", async (t) => {
  const dir = scratch(t);
  const connections: ByteConnection[] = [];
  let terminal = 0;
  const listener = await listenUnix({ accept: (connection) => {
    connections.push(connection);
    return { onData: () => undefined, onClose: () => { terminal += 1; }, onError: () => { terminal += 1; } };
  } }, { path: join(dir, "s.sock"), closeTimeoutMs: 150 });
  t.after(() => listener.close());
  const reader = createConnection(listener.path);
  reader.on("error", () => undefined);
  await new Promise<void>((resolve) => reader.once("connect", resolve));
  reader.pause();
  await until(() => connections.length === 1);
  const connection = connections[0]!;
  const sends = Array.from({ length: 64 }, () => connection.send(new Uint8Array(64 * 1024)).catch(() => undefined));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const started = Date.now();
  connection.close();
  connection.close();
  await until(() => listener.connectionCount === 0, "the timed-out close to destroy the socket");
  assert.ok(Date.now() - started >= 100, "close first waited for buffered bytes");
  await Promise.all(sends);
  assert.equal(terminal, 0, "a close the server started reports no terminal callback");
  reader.destroy();
});

test("listener close is repeatable and destroys connections the server still holds", async (t) => {
  const dir = scratch(t);
  const server = echoServer();
  const listener: UnixListener = await listenUnix(server, { path: join(dir, "s.sock") });
  const client = new Client({ serverId: "srv", transport: createUnixTransport({ path: listener.path }) });
  await client.connect();
  await until(() => listener.connectionCount === 1);
  const first = listener.close();
  assert.equal(listener.close(), first);
  await first;
  await until(() => client.state === "disconnected" && server.connectionCount === 0, "the connection to be released");
  assert.equal(existsSync(listener.path), false);
  assert.equal(statSync(dir).isDirectory(), true);
  await server.close();
});
