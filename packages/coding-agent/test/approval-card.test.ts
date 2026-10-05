import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { emptyTui, readHostFrame, renderTui, type TuiApproval } from "@amazme/tui";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID, startCodingHost } from "../src/host.ts";

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amz-approval-card-"));
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

function bashThenText(command: string) {
  return modelsFor((_context, _options, state) => state.callCount === 1
    ? fauxAssistant([fauxToolCall("bash", { command })])
    : fauxAssistant("done"));
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

function writeApproval(cwd: string, tools: string[]): void {
  mkdirSync(join(cwd, ".amazme"), { recursive: true });
  writeFileSync(join(cwd, ".amazme", "settings.json"), JSON.stringify({ approval: { tools } }));
}

function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

test("without approval settings a tool runs and nothing is parked", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t);
  const marker = join(cwd, "ran");
  const { models } = bashThenText(`echo ran > ${JSON.stringify(marker)}`);
  const host = await startCodingHost({ cwd, socket: join(cwd, "run.sock"), provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const opened = await attach(host.socket);
  t.after(() => opened.client.dispose());
  const lane = opened.remote.lane(HOST_LANE);
  const admitted = await lane.accept({ kind: "prompt", text: "run" });
  const outcome = await lane.drive(admitted.operationId, { waitForRetry: true });
  assert.equal(outcome.kind, "settled");
  assert.deepEqual((await lane.pendingApprovals()).items, []);
  assert.equal(existsSync(marker), true);
});

test("an enabled tool parks, deny feeds the model, and allow runs it once", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t);
  writeApproval(cwd, ["bash"]);
  const marker = join(cwd, "ran");
  const command = `echo ran > ${JSON.stringify(marker)}`;
  const denied = bashThenText(command);
  const denyHost = await startCodingHost({
    cwd,
    socket: join(cwd, "deny.sock"),
    provider: "faux",
    model: "faux-1",
    models: denied.models,
  });
  const denyClient = await attach(denyHost.socket);
  try {
    const lane = denyClient.remote.lane(HOST_LANE);
    const admitted = await lane.accept({ kind: "prompt", text: "run" });
    const parked = await lane.drive(admitted.operationId);
    assert.equal(parked.kind, "waiting");
    assert.equal(parked.kind === "waiting" ? parked.reason : "", "approval");
    const pending = await lane.pendingApprovals();
    assert.equal(pending.items.length, 1);
    assert.equal(pending.items[0]?.name, "bash");
    assert.deepEqual(pending.items[0]?.arguments, { command });
    assert.equal(existsSync(marker), false);
    await lane.approve(pending.items[0]?.toolCallId ?? "", "deny");
    assert.equal(existsSync(marker), false);
    assert.equal(denied.provider.state.callCount, 2);
    assert.match(JSON.stringify(denied.provider.state.contexts[1]), /Tool call denied/);
    assert.deepEqual((await lane.pendingApprovals()).items, []);
  } finally {
    await denyClient.client.dispose();
    await denyHost.close();
  }

  const allowed = bashThenText(command);
  const allowHost = await startCodingHost({
    cwd,
    socket: join(cwd, "allow.sock"),
    provider: "faux",
    model: "faux-1",
    models: allowed.models,
  });
  t.after(() => allowHost.close());
  const allowClient = await attach(allowHost.socket);
  t.after(() => allowClient.client.dispose());
  const lane = allowClient.remote.lane(HOST_LANE);
  const admitted = await lane.accept({ kind: "prompt", text: "run" });
  const parked = await lane.drive(admitted.operationId);
  assert.equal(parked.kind, "waiting");
  const pending = await lane.pendingApprovals();
  await lane.approve(pending.items[0]?.toolCallId ?? "", "allow");
  assert.equal(existsSync(marker), true);
  assert.equal(allowed.provider.state.callCount, 2);
  assert.deepEqual((await lane.pendingApprovals()).items, []);
});

test("session allow runs the next call of that tool without another card", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t);
  writeApproval(cwd, ["bash"]);
  const first = join(cwd, "first");
  const second = join(cwd, "second");
  const { models, provider } = modelsFor((_context, _options, state) => {
    if (state.callCount === 1) return fauxAssistant([fauxToolCall("bash", { command: `echo a > ${JSON.stringify(first)}` })]);
    if (state.callCount === 2) return fauxAssistant([fauxToolCall("bash", { command: `echo b > ${JSON.stringify(second)}` })]);
    return fauxAssistant("done");
  });
  const host = await startCodingHost({ cwd, socket: join(cwd, "run.sock"), provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const opened = await attach(host.socket);
  t.after(() => opened.client.dispose());
  const lane = opened.remote.lane(HOST_LANE);
  const admitted = await lane.accept({ kind: "prompt", text: "run" });
  const parked = await lane.drive(admitted.operationId);
  assert.equal(parked.kind, "waiting");
  const pending = await lane.pendingApprovals();
  await lane.approve(pending.items[0]?.toolCallId ?? "", "allow", { session: true });
  assert.equal(existsSync(first), true);
  assert.equal(existsSync(second), true);
  assert.equal(provider.state.callCount, 3);
  assert.deepEqual((await lane.pendingApprovals()).items, []);
});

test("reopening the host still shows the parked approval card", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t);
  writeApproval(cwd, ["bash"]);
  const marker = join(cwd, "ran");
  const command = `echo ran > ${JSON.stringify(marker)}`;
  const firstModels = bashThenText(command);
  const first = await startCodingHost({
    cwd,
    socket: join(cwd, "first.sock"),
    provider: "faux",
    model: "faux-1",
    models: firstModels.models,
  });
  t.after(() => first.close());
  const opened = await attach(first.socket);
  const lane = opened.remote.lane(HOST_LANE);
  const admitted = await lane.accept({ kind: "prompt", text: "run" });
  const parked = await lane.drive(admitted.operationId);
  assert.equal(parked.kind, "waiting");
  const pending = await lane.pendingApprovals();
  const toolCallId = pending.items[0]?.toolCallId ?? "";
  assert.equal(pending.items[0]?.name, "bash");
  await opened.client.dispose();
  await first.close();

  const second = await startCodingHost({
    cwd,
    socket: join(cwd, "second.sock"),
    provider: "faux",
    model: "faux-1",
    models: modelsFor(() => fauxAssistant("done")).models,
  });
  t.after(() => second.close());
  const frame = plain(await readHostFrame({
    socket: second.socket,
    serverId: HOST_SERVER_ID,
    runtimeId: HOST_RUNTIME_ID,
    lane: HOST_LANE,
  }));
  assert.match(frame, /审批/);
  assert.match(frame, /bash/);
  assert.match(frame, /command=/);
  assert.match(frame, /y 允许/);
  const again = await attach(second.socket);
  t.after(() => again.client.dispose());
  const restored = await again.remote.lane(HOST_LANE).pendingApprovals();
  assert.equal(restored.items[0]?.toolCallId, toolCallId);
  assert.equal(existsSync(marker), false);
  await again.remote.lane(HOST_LANE).approve(toolCallId, "allow");
  assert.equal(existsSync(marker), true);
  assert.deepEqual((await again.remote.lane(HOST_LANE).pendingApprovals()).items, []);
  const cards: TuiApproval[] = restored.items.map((item) => ({
    toolCallId: item.toolCallId,
    name: item.name,
    summary: "command=ls",
  }));
  assert.match(plain(renderTui({ ...emptyTui(), approvals: cards })), /bash/);
});
