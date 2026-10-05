import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listWorkspaceFiles } from "../src/files.ts";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("git listing skips ignored files and does not return paths outside the workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amz-files-"));
  const outside = join(tmpdir(), `amz-outside-${process.pid}.txt`);
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export {}\n");
    writeFileSync(join(dir, ".gitignore"), "secret.log\n");
    writeFileSync(join(dir, "notes.md"), "n\n");
    writeFileSync(join(dir, "secret.log"), "nope\n");
    writeFileSync(outside, "out\n");
    git(dir, ["init"]);
    git(dir, ["add", "src/a.ts", ".gitignore"]);
    const all = await listWorkspaceFiles(dir, "");
    assert.equal(all.includes("src/a.ts"), true);
    assert.equal(all.includes("notes.md"), true);
    assert.equal(all.includes("secret.log"), false);
    assert.equal(all.includes(outside), false);
    assert.equal(all.some((path) => path.startsWith("/") || path.split("/").includes("..")), false);
    assert.deepEqual(await listWorkspaceFiles(dir, "src/a"), ["src/a.ts"]);
    assert.deepEqual(await listWorkspaceFiles(dir, "notes"), ["notes.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("a directory without git skips .git and node_modules and returns at most 200 files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amz-walk-"));
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), "x\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "pkg.js"), "x\n");
    writeFileSync(join(dir, "keep.txt"), "k\n");
    const small = await listWorkspaceFiles(dir, "");
    assert.deepEqual(small, ["keep.txt"]);
    for (let index = 0; index < 205; index += 1) writeFileSync(join(dir, `n${index}.txt`), "n\n");
    const capped = await listWorkspaceFiles(dir, "");
    assert.equal(capped.length, 200);
    assert.equal(capped.some((path) => path.startsWith(".git") || path.includes("node_modules")), false);
    assert.deepEqual(await listWorkspaceFiles(dir, "keep"), ["keep.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fullscreen client does not scan the workspace itself", () => {
  const root = fileURLToPath(new URL("../../tui/src", import.meta.url));
  const text = walk(root).filter((file) => file.endsWith(".ts")).map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(text.includes("ls-files"), false);
  const menu = ["present.ts", "reduce.ts", "commands.ts", "images.ts"]
    .map((name) => readFileSync(join(root, name), "utf8"))
    .join("\n");
  assert.equal(menu.includes("readdir"), false);
  assert.match(readFileSync(join(root, "present.ts"), "utf8"), /\.files\(/);
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
