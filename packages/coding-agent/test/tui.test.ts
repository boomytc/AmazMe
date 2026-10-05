import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { shouldOpenFullscreen } from "../src/tui/run.ts";

test("fullscreen opens only with an empty prompt on a terminal", () => {
  assert.equal(shouldOpenFullscreen("", true), true);
  assert.equal(shouldOpenFullscreen("一句话", true), false);
  assert.equal(shouldOpenFullscreen("", false), false);
});

test("the fullscreen view does not own the model or the in-memory agent", () => {
  const root = fileURLToPath(new URL("../src/tui/run.ts", import.meta.url));
  const source = readFileSync(root, "utf8");
  assert.equal(source.includes("@amazme/agent"), false);
  assert.equal(source.includes("AgentSession"), false);
  const viewRoot = fileURLToPath(new URL("../../tui/src", import.meta.url));
  const view = walk(viewRoot).filter((file) => file.endsWith(".ts")).map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(view.includes("@amazme/agent"), false);
  assert.equal(view.includes("@amazme/ai"), false);
  assert.equal(view.includes("@amazme/durable"), false);
  assert.equal(view.includes("@amazme/coding-agent"), false);
  assert.equal(view.includes("streamFn"), false);
  assert.equal(view.includes("createModels"), false);
  assert.equal(view.includes("fauxProvider"), false);
});

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}
