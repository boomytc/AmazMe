import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { readHostFrame } from "@amazme/tui";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID, startCodingHost } from "../src/host.ts";

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amz-tool-card-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modelsFor(respond: Parameters<typeof fauxProvider>[0]["respond"]) {
  const provider = fauxProvider({ respond });
  const models = createModels();
  models.setProvider(provider);
  return { models, provider };
}

async function attach(socket: string): Promise<{ client: Client; remote: RuntimeClient }> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < 5_000) {
    let client: Client | undefined;
    try {
      client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
      await client.connect();
      const remote = new RuntimeClient(client);
      await remote.attach(HOST_RUNTIME_ID);
      return { client, remote };
    } catch (error) {
      last = error;
      await client?.dispose();
      await delay(10);
    }
  }
  throw last instanceof Error ? last : new Error("attach failed");
}

function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

async function reopenFrame(cwd: string): Promise<string> {
  const host = await startCodingHost({
    cwd,
    socket: join(cwd, "again.sock"),
    provider: "faux",
    model: "faux-1",
    models: modelsFor(() => fauxAssistant("done")).models,
  });
  try {
    return plain(await readHostFrame({
      socket: host.socket,
      serverId: HOST_SERVER_ID,
      runtimeId: HOST_RUNTIME_ID,
      lane: HOST_LANE,
    }));
  } finally {
    await host.close();
  }
}

test("reopening the host still draws the settled tool card", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t);
  const command = "echo hello-card";
  const { models } = modelsFor((_context, _options, state) => state.callCount === 1
    ? fauxAssistant([fauxToolCall("bash", { command })])
    : fauxAssistant("done"));
  const host = await startCodingHost({ cwd, socket: join(cwd, "run.sock"), provider: "faux", model: "faux-1", models });
  const opened = await attach(host.socket);
  try {
    const lane = opened.remote.lane(HOST_LANE);
    const admitted = await lane.accept({ kind: "prompt", text: "run" });
    const outcome = await lane.drive(admitted.operationId, { waitForRetry: true });
    assert.equal(outcome.kind, "settled");
  } finally {
    await opened.client.dispose();
    await host.close();
  }
  const frame = await reopenFrame(cwd);
  assert.match(frame, /bash {2}成功/);
  assert.match(frame, /command=echo hello-card/);
  assert.match(frame, /\d+(ms|s)/);
});

test("reopening the host still draws a denied tool card", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t);
  mkdirSync(join(cwd, ".amazme"), { recursive: true });
  writeFileSync(join(cwd, ".amazme", "settings.json"), JSON.stringify({ approval: { tools: ["bash"] } }));
  const command = "echo denied-card";
  const { models } = modelsFor((_context, _options, state) => state.callCount === 1
    ? fauxAssistant([fauxToolCall("bash", { command })])
    : fauxAssistant("done"));
  const host = await startCodingHost({ cwd, socket: join(cwd, "run.sock"), provider: "faux", model: "faux-1", models });
  const opened = await attach(host.socket);
  try {
    const lane = opened.remote.lane(HOST_LANE);
    const admitted = await lane.accept({ kind: "prompt", text: "run" });
    const parked = await lane.drive(admitted.operationId);
    assert.equal(parked.kind, "waiting");
    const pending = await lane.pendingApprovals();
    await lane.approve(pending.items[0]?.toolCallId ?? "", "deny");
  } finally {
    await opened.client.dispose();
    await host.close();
  }
  const frame = await reopenFrame(cwd);
  assert.match(frame, /bash {2}被拒/);
  assert.match(frame, /command=echo denied-card/);
});
