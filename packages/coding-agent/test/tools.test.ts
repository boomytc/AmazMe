import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@amazme/agent";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { HOST_RUNTIME_ID, HOST_SERVER_ID, startCodingHost } from "../src/host.ts";
import { createBashTool, createCodingTools } from "../src/tools.ts";

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amz-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  return block?.type === "text" ? block.text ?? "" : "";
}

test("bash reports a missing working directory without an uncaught exception", async (t) => {
  const bash = createBashTool(join(directory(t), "missing"));
  let uncaught: unknown;
  const onUncaught = (error: unknown) => { uncaught = error; };
  process.on("uncaughtException", onUncaught);
  try {
    const result = await bash.execute({ command: "echo hi" }, { signal: new AbortController().signal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(uncaught, undefined);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /ENOENT|cwd/i);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});

test("bash removes its abort listener after the command ends and when abort kills it", async () => {
  const bash = createBashTool(tmpdir());
  const finished = new AbortController();
  const result = await bash.execute({ command: "echo hi" }, { signal: finished.signal });
  assert.equal(result.isError, false);
  assert.match(textOf(result), /hi/);
  assert.equal(getEventListeners(finished.signal, "abort").length, 0);
  finished.abort();
  assert.equal(getEventListeners(finished.signal, "abort").length, 0);

  const running = new AbortController();
  const pending = bash.execute({ command: "sleep 30" }, { signal: running.signal });
  running.abort();
  const aborted = await pending;
  assert.equal(aborted.isError, true);
  assert.equal(getEventListeners(running.signal, "abort").length, 0);
});

test("bash keeps only the tail of large output", async () => {
  const bash = createBashTool(tmpdir());
  const result = await bash.execute({
    command: `${process.execPath} -e "process.stdout.write('x'.repeat(80000))"`,
  }, { signal: new AbortController().signal });
  const text = textOf(result);
  assert.match(text, /stdout truncated to the last 32 KiB/);
  assert.ok(Buffer.byteLength(text) < 40_000);
  assert.match(text, /x{1000}/);
});

test("grep find and ls read a fixture tree while a write outside and a network dial stay refused", { timeout: 20_000 }, async (t) => {
  const root = directory(t);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "note.txt"), "alpha needle\nbeta\n");
  writeFileSync(join(root, "src", "other.md"), "needle too\n");
  const tools = createCodingTools(root);
  const write = tools.find((tool) => tool.name === "write");
  const bash = tools.find((tool) => tool.name === "bash");
  const grep = tools.find((tool) => tool.name === "grep");
  const find = tools.find((tool) => tool.name === "find");
  const ls = tools.find((tool) => tool.name === "ls");
  assert.ok(write && bash && grep && find && ls);
  const signal = new AbortController().signal;
  const matches = await grep.execute({ pattern: "needle", path: "src" }, { signal });
  assert.equal(Boolean(matches.isError), false);
  assert.match(textOf(matches), /src\/note\.txt:1:alpha needle/);
  assert.match(textOf(matches), /src\/other\.md:1:needle too/);
  const paths = await find.execute({ pattern: "*.txt", path: "." }, { signal });
  assert.match(textOf(paths), /src\/note\.txt/);
  assert.equal(textOf(paths).includes("other.md"), false);
  const listed = await ls.execute({ path: "src" }, { signal });
  assert.match(textOf(listed), /note\.txt/);
  assert.match(textOf(listed), /other\.md/);
  await assert.rejects(
    () => write.execute({ path: "../outside.txt", content: "no" }, { signal }),
    /escapes the workspace/,
  );
  const network = await bash.execute({
    command: `${JSON.stringify(process.execPath)} -e "const s=require('net').connect(9,'127.0.0.1'); s.on('error',e=>{console.log(e.code); process.exit(0)}); s.on('connect',()=>{console.log('OPEN'); process.exit(0)}); setTimeout(()=>{console.log('TIMEOUT'); process.exit(0)},1500)"`,
  }, { signal });
  assert.match(textOf(network), /EPERM/);
  assert.equal(textOf(network).includes("OPEN"), false);
});

test("the model can grep from a one-shot agent and from the hosted session", { timeout: 20_000 }, async (t) => {
  const root = directory(t);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "note.txt"), "alpha needle\n");
  const respond = (_context: unknown, _options: unknown, state: { callCount: number }) =>
    state.callCount === 1 ? fauxAssistant([fauxToolCall("grep", { pattern: "needle", path: "src" })]) : fauxAssistant("done");
  const models = createModels();
  const provider = fauxProvider({ respond });
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  const produced = await new Agent({ model, streamFn: models.streamSimple.bind(models), tools: createCodingTools(root) }).prompt("search");
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" ? messageText(result) : "", "src/note.txt:1:alpha needle");

  const hosted = createModels();
  hosted.setProvider(fauxProvider({ respond }));
  const socket = join(root, "host.sock");
  const host = await startCodingHost({ cwd: root, socket, provider: "faux", model: "faux-1", models: hosted });
  t.after(() => host.close("abort"));
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  await client.connect();
  t.after(() => client.dispose());
  const remote = new RuntimeClient(client);
  await remote.attach(HOST_RUNTIME_ID);
  const lane = remote.lane("main");
  const admitted = await lane.accept({ kind: "prompt", text: "search" });
  const outcome = await lane.drive(admitted.operationId, { waitForRetry: true });
  if (outcome.kind === "waiting") await lane.drive(outcome.operationId, { waitForRetry: true });
  const snap = await lane.snapshot();
  const hostedResult = snap.entries.map((entry) => entry.payload.type === "message" ? entry.payload.message : undefined).find((message) => message?.role === "toolResult");
  const hostedText = hostedResult && "content" in hostedResult && Array.isArray(hostedResult.content)
    ? hostedResult.content.map((block) => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "").join("")
    : "";
  assert.equal(hostedText, "src/note.txt:1:alpha needle");
});

test("write and edit share a queue inside one tool set and not across sets", async (t) => {
  const root = directory(t);
  const other = directory(t);
  const [read, write, edit] = createCodingTools(root);
  const second = createCodingTools(other);
  assert.ok(read && write && edit && second[1]);
  await write.execute({ path: "note.txt", content: "one" }, { signal: new AbortController().signal });
  await edit.execute({ path: "note.txt", old: "one", replacement: "two" }, { signal: new AbortController().signal });
  const updated = await read.execute({ path: "note.txt" }, { signal: new AbortController().signal });
  assert.equal(textOf(updated), "two");
  await second[1].execute({ path: "note.txt", content: "other" }, { signal: new AbortController().signal });
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "two");
  assert.equal(readFileSync(join(other, "note.txt"), "utf8"), "other");
});
