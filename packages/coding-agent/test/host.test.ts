import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/providers/faux";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID, runtimeFile, startCodingHost } from "../src/host.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hostModule = new URL("../src/host.ts", import.meta.url).href;

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

function textModels() {
  const models = createModels();
  models.setProvider(fauxProvider({ respond: () => fauxAssistant("continued") }));
  return models;
}

function modelsFor(command: string) {
  const provider = fauxProvider({
    respond: (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([fauxToolCall("bash", { command })])
      : fauxAssistant("done"),
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, provider };
}

async function connect(socket: string): Promise<{ client: Client; remote: RuntimeClient }> {
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  await client.connect();
  return { client, remote: new RuntimeClient(client) };
}

async function attach(socket: string): Promise<{ client: Client; remote: RuntimeClient }> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < 5_000) {
    let client: Client | undefined;
    try {
      const opened = await connect(socket);
      client = opened.client;
      await opened.remote.attach(HOST_RUNTIME_ID);
      return opened;
    } catch (error) {
      last = error;
      await client?.dispose();
      await delay(10);
    }
  }
  throw last instanceof Error ? last : new Error("attach failed");
}

test("a client can drive bash over Unix JSONL, disconnect, and read the settled result", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t, "amz-host-");
  const socket = join(cwd, "run.sock");
  const started = join(cwd, "started");
  const release = join(cwd, "release");
  const finished = join(cwd, "finished");
  const command = `echo started > ${JSON.stringify(started)}; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done; echo done > ${JSON.stringify(finished)}`;
  const { models, provider } = modelsFor(command);
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const first = await attach(socket);
  assert.equal(provider.state.callCount, 0, "opening a runtime does not call the model");
  const lane = first.remote.lane(HOST_LANE);
  const admission = await lane.accept({ kind: "prompt", text: "run the command" });
  const driving = lane.drive(admission.operationId);
  let driveError: unknown;
  void driving.then(() => undefined, (error: unknown) => { driveError = error; });
  await until(() => existsSync(started), "the bash command started");
  assert.equal(provider.state.callCount, 1);
  await first.client.dispose();
  await until(() => driveError !== undefined, "the disconnected drive wait rejected");
  assert.equal(existsSync(finished), false);
  assert.equal(provider.state.callCount, 1, "disconnect does not start another model call");
  writeFileSync(release, "");
  await until(() => existsSync(finished), "bash finished after the client left");
  await until(() => provider.state.callCount === 2, "the admitted drive finished the turn");
  const second = await attach(socket);
  t.after(() => second.client.dispose());
  const snapshot = await second.remote.lane(HOST_LANE).snapshot();
  assert.match(JSON.stringify(snapshot), /bash/);
  assert.match(JSON.stringify(snapshot), /done/);
  assert.equal(provider.state.callCount, 2);
});

test("startup fails before a listener or a JSONL lock exists", async (t) => {
  const cwd = directory(t, "amz-host-fail-");
  const { models } = modelsFor("echo hi");
  const missingSocket = join(cwd, "missing.sock");
  await assert.rejects(
    () => startCodingHost({ cwd, socket: missingSocket, provider: "faux", model: "missing", models }),
    /unknown model faux\/missing/,
  );
  assert.equal(existsSync(missingSocket), false);
  assert.equal(existsSync(runtimeFile(cwd)), false);

  const blocked = join(cwd, "blocked.sock");
  writeFileSync(blocked, "not a socket");
  await assert.rejects(
    () => startCodingHost({ cwd, socket: blocked, provider: "faux", model: "faux-1", models }),
  );
  assert.equal(existsSync(runtimeFile(cwd)), false);
  const host = await startCodingHost({ cwd, socket: join(cwd, "ok.sock"), provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const opened = await attach(host.socket);
  t.after(() => opened.client.dispose());
});

test("SIGTERM drains the serve process and leaves the JSONL reusable", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t, "amz-host-stop-");
  const socket = join(cwd, "serve.sock");
  const child = spawn(process.execPath, ["--import", "tsx", cli, "serve", "--socket", socket, "--cwd", cwd, "--provider", "faux", "--model", "faux-1"], {
    cwd: repo,
    env: {
      ...process.env,
      AMAZME_CREDENTIALS: join(cwd, "credentials.json"),
      AMAZME_DEVICE_ID_FILE: join(cwd, "device-id"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`serve did not exit\n${stdout}\n${stderr}`));
    }, 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited.catch(() => undefined);
  });
  await until(() => stdout.includes("\n"), "serve announced the socket");
  const ready = JSON.parse(stdout.slice(0, stdout.indexOf("\n"))) as { socket: string; runtimeId: string; lane: string };
  assert.equal(ready.runtimeId, HOST_RUNTIME_ID);
  assert.equal(ready.lane, HOST_LANE);
  const opened = await attach(ready.socket);
  await opened.client.dispose();
  assert.equal(existsSync(runtimeFile(cwd)), true);
  child.kill("SIGTERM");
  assert.equal(await exited, 0, stderr);
  await assert.rejects(() => connect(ready.socket));
  const again = await startCodingHost({
    cwd,
    socket: join(cwd, "again.sock"),
    provider: "faux",
    model: "faux-1",
    models: modelsFor("echo hi").models,
  });
  t.after(() => again.close());
  const reopened = await attach(again.socket);
  t.after(() => reopened.client.dispose());
});

test("a killed host does not replay bash when the runtime is opened again", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t, "amz-host-crash-");
  const socket = join(cwd, "crash.sock");
  const marker = join(cwd, "marker");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { startCodingHost } from ${JSON.stringify(hostModule)};
    import { createModels } from "@amazme/ai";
    import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/providers/faux";
    const marker = process.env.HOST_MARKER;
    const command = "echo $$ >> " + JSON.stringify(marker) + "; sleep 60";
    const models = createModels();
    models.setProvider(fauxProvider({
      respond: (_context, _options, state) => state.callCount === 1
        ? fauxAssistant([fauxToolCall("bash", { command })])
        : fauxAssistant("continued"),
    }));
    const host = await startCodingHost({
      cwd: process.env.HOST_CWD,
      socket: process.env.HOST_SOCKET,
      provider: "faux",
      model: "faux-1",
      models,
    });
    process.stdout.write(JSON.stringify({ socket: host.socket }) + "\\n");
    await new Promise(() => undefined);
  `], {
    cwd: repo,
    env: {
      ...process.env,
      HOST_CWD: cwd,
      HOST_SOCKET: socket,
      HOST_MARKER: marker,
      AMAZME_CREDENTIALS: join(cwd, "credentials.json"),
      AMAZME_DEVICE_ID_FILE: join(cwd, "device-id"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.on("close", (_code, signal) => resolve(signal));
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
  });
  await until(() => stdout.includes("\n"), `crash host did not start\n${stderr}`);
  const opened = await attach(socket);
  const lane = opened.remote.lane(HOST_LANE);
  const admission = await lane.accept({ kind: "prompt", text: "mark" });
  void lane.drive(admission.operationId).then(() => undefined, () => undefined);
  await until(() => existsSync(marker) && readFileSync(marker, "utf8").trim().length > 0, "bash wrote its pid");
  const pid = Number(readFileSync(marker, "utf8").trim().split("\n")[0]);
  child.kill("SIGKILL");
  assert.equal(await exited, "SIGKILL");
  await opened.client.dispose();
  if (Number.isInteger(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* the shell already exited with the host */ }
  }
  const recovered = await startCodingHost({
    cwd,
    socket: join(cwd, "recovered.sock"),
    provider: "faux",
    model: "faux-1",
    models: textModels(),
  });
  t.after(() => recovered.close());
  const client = await attach(recovered.socket);
  t.after(() => client.client.dispose());
  const outcome = await client.remote.lane(HOST_LANE).drive(admission.operationId);
  assert.equal(outcome.kind, "settled");
  const snapshot = await client.remote.lane(HOST_LANE).snapshot();
  assert.match(JSON.stringify(snapshot), /interrupted before settlement/);
  assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 1);
});

test("serve requires a socket and does not ask for a prompt", async (t) => {
  const cwd = directory(t, "amz-host-cli-");
  const child = spawn(process.execPath, ["--import", "tsx", cli, "serve", "--cwd", cwd], {
    cwd: repo,
    env: { ...process.env, AMAZME_CREDENTIALS: join(cwd, "credentials.json"), AMAZME_DEVICE_ID_FILE: join(cwd, "device-id") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number>((resolve) => child.on("close", (status) => resolve(status ?? 1)));
  assert.equal(code, 1);
  assert.match(stderr, /serve requires --socket/);
  assert.doesNotMatch(stderr, /missing prompt/);
});
