import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RemoteLane } from "@amazme/runtime-service/client";
import { addScopedModels, executeSlash, type SlashActions } from "@amazme/tui";

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amz-scoped-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function projectFile(cwd: string): string {
  return join(cwd, ".amazme", "project.json");
}

function readModels(cwd: string): string[] {
  return (JSON.parse(readFileSync(projectFile(cwd), "utf8")) as { scopedModels: string[] }).scopedModels;
}

function actions(cwd: string, provider: string, modelId: string): SlashActions {
  const lane = {
    configure: async () => ({ provider, modelId, thinkingLevel: "off" as const, thinkingLevels: ["off"] }),
  } as unknown as RemoteLane;
  return {
    cwd,
    lane: () => lane,
    active: () => "main",
    list: async () => ["main"],
    open: async () => undefined,
    earlier: async () => "",
    continueRetry: async () => "",
  };
}

test("addScopedModels keeps order, drops duplicates, and writes once", (t) => {
  const cwd = directory(t);
  mkdirSync(join(cwd, ".amazme"));
  writeFileSync(projectFile(cwd), `${JSON.stringify({
    trusted: true,
    settings: { theme: "dark" },
    names: { main: "工作" },
    scopedModels: ["notes", "local/hand-tuned", "deepseek/deepseek-flash"],
  }, null, 2)}\n`);
  const first = addScopedModels(cwd, ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro"], "faux/faux-1");
  assert.equal(first.added, 1);
  assert.deepEqual(first.models, ["notes", "local/hand-tuned", "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
  const saved = JSON.parse(readFileSync(projectFile(cwd), "utf8")) as {
    trusted: boolean;
    settings: Record<string, string>;
    names: Record<string, string>;
    scopedModels: string[];
  };
  assert.equal(saved.trusted, true);
  assert.deepEqual(saved.settings, { theme: "dark" });
  assert.deepEqual(saved.names, { main: "工作" });
  assert.deepEqual(saved.scopedModels, first.models);
  const before = readFileSync(projectFile(cwd), "utf8");
  const again = addScopedModels(cwd, ["deepseek/deepseek-v4-pro"], "other/model");
  assert.equal(again.added, 0);
  assert.equal(readFileSync(projectFile(cwd), "utf8"), before);
});

test("the first write from an empty list inserts the current model once", (t) => {
  const cwd = directory(t);
  const written = addScopedModels(cwd, ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"], "deepseek/deepseek-v4-pro");
  assert.equal(written.added, 2);
  assert.deepEqual(readModels(cwd), ["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"]);
  const empty = directory(t);
  const skipped = addScopedModels(empty, [], "faux/faux-1");
  assert.equal(skipped.added, 0);
  assert.equal(existsSync(projectFile(empty)), false);
  const invalid = addScopedModels(empty, ["noslash", "has space/id"]);
  assert.equal(invalid.added, 0);
  assert.equal(existsSync(projectFile(empty)), false);
});

test("bare /scoped-models groups providers after eight entries", async (t) => {
  const cwd = directory(t);
  const none = await executeSlash({ type: "scoped-models" }, actions(cwd, "deepseek", "deepseek-flash"));
  assert.equal(none.type === "notice" ? none.text : "", "模型循环未限制");
  const eight = [
    "deepseek/deepseek-flash",
    "deepseek/deepseek-v4-pro",
    ...Array.from({ length: 6 }, (_, index) => `anthropic/claude-${index}`),
  ];
  addScopedModels(cwd, eight);
  const listed = await executeSlash({ type: "scoped-models" }, actions(cwd, "deepseek", "deepseek-flash"));
  assert.equal(listed.type === "notice" ? listed.text : "", `模型循环 ${eight.join(" ")} 下一个 deepseek/deepseek-v4-pro`);
  addScopedModels(cwd, ["anthropic/claude-6"]);
  const grouped = await executeSlash({ type: "scoped-models" }, actions(cwd, "deepseek", "deepseek-flash"));
  assert.equal(grouped.type === "notice" ? grouped.text : "", "模型循环 deepseek 2、anthropic 7 下一个 deepseek/deepseek-v4-pro");
});
