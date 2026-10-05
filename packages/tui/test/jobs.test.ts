import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RemoteLane } from "@amazme/runtime-service/client";
import { executeSlash, parseSlash, type SlashActions } from "@amazme/tui";

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-jobs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function actions(cwd?: string): SlashActions {
  const lane = {
    snapshot: async () => ({ operationId: null }),
    requestAbort: async () => undefined,
  } as unknown as RemoteLane;
  return {
    ...(cwd ? { cwd } : {}),
    lane: () => lane,
    active: () => "main",
    list: async () => ["main"],
    open: async () => undefined,
    earlier: async () => "",
    continueRetry: async () => "",
  };
}

test("/jobs lists id, status, and summary from the workspace registry", async (t) => {
  const cwd = directory(t);
  const help = parseSlash("/help");
  assert.equal(help.type, "notice");
  if (help.type === "notice") assert.match(help.text, /\/jobs 列出后台任务/);
  assert.deepEqual(parseSlash("/jobs"), { type: "jobs" });
  const usage = parseSlash("/jobs extra");
  assert.equal(usage.type, "notice");
  if (usage.type === "notice") assert.match(usage.text, /用法：\/jobs/);

  const missing = await executeSlash({ type: "jobs" }, actions(cwd));
  assert.equal(missing.type, "notice");
  if (missing.type === "notice") assert.equal(missing.text, "没有后台任务");

  const noCwd = await executeSlash({ type: "jobs" }, actions());
  assert.equal(noCwd.type, "notice");
  if (noCwd.type === "notice") assert.equal(noCwd.text, "当前客户端没有工作区");

  mkdirSync(join(cwd, ".amazme", "runtime"), { recursive: true });
  writeFileSync(join(cwd, ".amazme", "runtime", "jobs.json"), JSON.stringify({
    next: 3,
    jobs: [
      { id: "j1", status: "running", summary: "sleep 30" },
      { id: "j2", status: "lost", summary: "echo hi" },
    ],
  }));
  const listed = await executeSlash({ type: "jobs" }, actions(cwd));
  assert.equal(listed.type, "notice");
  if (listed.type === "notice") {
    assert.match(listed.text, /j1 running sleep 30/);
    assert.match(listed.text, /j2 lost echo hi/);
  }

  writeFileSync(join(cwd, ".amazme", "runtime", "jobs.json"), "{");
  const broken = await executeSlash({ type: "jobs" }, actions(cwd));
  assert.equal(broken.type, "notice");
  if (broken.type === "notice") assert.equal(broken.text, "无法读取后台任务");
});
