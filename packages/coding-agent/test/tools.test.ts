import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
