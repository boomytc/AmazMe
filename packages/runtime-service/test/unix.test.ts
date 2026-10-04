import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, ClientError, RemoteError } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import type { AgentHarness } from "@amazme/durable";
import { Server } from "@amazme/server";
import { listenUnix } from "@amazme/server/unix";
import type { LaneSnapshotDto } from "@amazme/runtime-service";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { openJsonlRuntime } from "@amazme/runtime-service/jsonl";
import { createManagementService, openOwnedRuntimes } from "@amazme/runtime-service/server";
import { finish, gatedModels, pendingText, textDelta, texts, tick, until } from "./support.ts";

/** One process: owned JSONL runtime, protocol server and Unix listener. */
async function start(socket: string, file: string) {
  const errors: Error[] = [];
  const { models, streams } = gatedModels();
  let harness: AgentHarness | undefined;
  let server!: Server;
  server = new Server({
    serverId: "srv-unix",
    service: createManagementService({ removeRuntime: (runtimeId) => server.removeRuntime(runtimeId) }),
    onError: (error) => errors.push(error),
    openRuntime: openOwnedRuntimes({
      async open(runtimeId) {
        if (runtimeId !== "main") return null;
        const resources = await openJsonlRuntime(file, { models, model: { provider: "gated", modelId: "g" } });
        harness = resources.harness;
        return resources;
      },
      publishWindowMs: 5,
      onError: (error) => errors.push(error),
    }),
  });
  const listener = await listenUnix(server, { path: socket, onError: (error) => errors.push(error) });
  const clients: Client[] = [];
  const connect = async () => {
    const client = new Client({ serverId: "srv-unix", transport: createUnixTransport({ path: socket }) });
    clients.push(client);
    await client.connect();
    return { client, remote: new RuntimeClient(client) };
  };
  const stop = async (crash = false) => {
    for (const client of clients) await client.dispose();
    if (crash) harness?.abandon();
    const closing = server.close();
    for (const stream of streams) finish(stream, "teardown");
    await closing;
    await listener.close();
  };
  return {
    get harness() {
      if (!harness) throw new Error("runtime was not opened");
      return harness;
    },
    server,
    listener,
    streams,
    errors,
    connect,
    stop,
  };
}

function workspace(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "amz-rt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, socket: join(dir, "run", "rt.sock"), file: join(dir, "lane.jsonl") };
}

test("the full control and observation loop runs over a real Unix socket with JSONL storage", async (t) => {
  const { socket, file } = workspace(t);
  const node = await start(socket, file);
  try {
    const { remote } = await node.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    await lane.accept({ kind: "prompt", text: "hi", operationId: "op-1" });
    const seen: LaneSnapshotDto[] = [];
    const subscription = await lane.subscribe((snapshot) => seen.push(snapshot));
    const driving = lane.drive("op-1");
    await until(() => node.streams.length === 1, "the model call");
    textDelta(node.streams[0]!, "Hel", "Hel");
    await until(() => pendingText(subscription.current()) === "Hel", "the pending prefix over the socket");
    textDelta(node.streams[0]!, "lo", "Hello");
    await until(() => pendingText(subscription.current()) === "Hello");
    finish(node.streams[0]!, "Hello");
    assert.equal((await driving).kind, "settled");
    await until(() => subscription.current().pendingResponse === null && subscription.current().operationId === null, "the settled snapshot");
    assert.deepEqual(texts(subscription.current()), ["hi", "Hello"]);
    assert.equal((await lane.result("op-1"))?.status, "completed");
    assert.ok(seen.some((snapshot) => pendingText(snapshot) === "Hel"));
    assert.equal(node.streams.length, 1);
    assert.deepEqual(node.errors, []);
  } finally {
    await node.stop();
  }
  assert.equal(existsSync(socket), false, "the listener removed its socket");
});

test("over a Unix socket a disconnect neither cancels nor resends, and drain then reopen does not drive", async (t) => {
  const { socket, file } = workspace(t);
  const node = await start(socket, file);
  let reopened: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const first = await node.connect();
    await first.remote.attach("main");
    const lane = first.remote.lane("main");
    await lane.accept({ kind: "prompt", text: "go", operationId: "op" });
    const driving = lane.drive("op");
    await until(() => node.streams.length === 1);
    textDelta(node.streams[0]!, "part", "part");
    await first.client.disconnect();
    await assert.rejects(driving, (error) => error instanceof ClientError && error.code === "disconnected");
    await until(() => node.server.connectionCount === 0 && node.listener.connectionCount === 0, "the server to release the socket");
    assert.equal((await node.harness.lane("main").inspect()).status, "open");
    finish(node.streams[0]!, "part and rest");
    await until(async () => {
      try {
        return (await node.harness.lane("main").inspect()).operationId === null;
      } catch (error) {
        return error instanceof Error && error.message === "storage is closed";
      }
    }, "the drive to settle or the idle runtime to close");

    await first.client.connect();
    await until(async () => {
      try {
        await first.remote.attach("main");
        return true;
      } catch (error) {
        if (error instanceof RemoteError && error.code === "runtime_busy") return false;
        throw error;
      }
    }, "reattach after reclaim");
    assert.deepEqual(texts(await lane.snapshot()), ["go", "part and rest"]);
    assert.equal((await lane.result("op"))?.status, "completed");
    assert.equal(node.streams.length, 1);
    assert.deepEqual(node.errors, []);
    const settled = await lane.snapshot();
    await node.stop();
    assert.equal(existsSync(file), true, "drain releases the lock and keeps the file");

    reopened = await start(socket, file);
    const again = await reopened.connect();
    await again.remote.attach("main");
    assert.deepEqual(await again.remote.lane("main").snapshot(), settled);
    await tick(20);
    assert.equal(reopened.streams.length, 0, "opening does not drive or resend the model request");
    assert.deepEqual(reopened.errors, []);
  } finally {
    await reopened?.stop();
    await node.stop();
  }
});

test("after a crash, JSONL reopen serves the same snapshot and an explicit drive recovers without a model request", async (t) => {
  const { socket, file, dir } = workspace(t);
  const before = await start(socket, file);
  let crashed: LaneSnapshotDto;
  try {
    const { remote } = await before.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    await lane.accept({ kind: "prompt", text: "hi", operationId: "op" });
    const subscription = await lane.subscribe(() => undefined);
    void lane.drive("op").catch(() => undefined);
    await until(() => before.streams.length === 1);
    textDelta(before.streams[0]!, "partial", "partial");
    await until(() => pendingText(subscription.current()) === "partial");
    before.harness.abandon();
    crashed = await lane.snapshot();
    assert.equal(crashed.phase, "assistant_effect_pending");
  } finally {
    await before.stop(true);
  }
  assert.deepEqual(readdirSync(join(dir, "run")), [], "the stopped listener left no socket");

  const after = await start(socket, file);
  try {
    const { remote } = await after.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    assert.deepEqual(await lane.snapshot(), crashed, "the reopened JSONL serves the same snapshot");
    assert.equal(await lane.result("op"), null);
    await tick(20);
    assert.equal(after.streams.length, 0, "reading does not recover or call the model");
    const outcome = await lane.drive("op");
    assert.equal(outcome.kind === "settled" && outcome.result.status, "aborted");
    assert.equal(after.streams.length, 0, "recovery does not resend the model request");
    const recovered = await lane.snapshot();
    assert.deepEqual(texts(recovered), ["hi", "partial"]);
    assert.equal(recovered.pendingResponse, null);
    assert.equal((await lane.result("op"))?.status, "aborted");
    assert.deepEqual(after.errors, []);
    await remote.remove("main");
    assert.equal(existsSync(file), false, "remove deletes the JSONL file");
    await remote.remove("main");
    await remote.attach("main");
    assert.deepEqual(texts(await lane.snapshot()), [], "the reopened runtime is a new file");
    assert.equal(after.streams.length, 0);
  } finally {
    await after.stop();
  }
});
