import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "pkg.js"), "x\n");
    writeFileSync(outside, "out\n");
    git(dir, ["init"]);
    git(dir, ["add", "src/a.ts", ".gitignore"]);
    git(dir, ["add", "-f", "node_modules/pkg.js"]);
    const all = await listWorkspaceFiles(dir, "");
    assert.equal(all.includes("src/a.ts"), true);
    assert.equal(all.includes("notes.md"), true);
    assert.equal(all.includes("secret.log"), false);
    assert.equal(all.includes("node_modules/pkg.js"), false);
    assert.equal(all.some((path) => path.startsWith("node_modules/") || path.startsWith(".git/")), false);
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
  const smallDir = mkdtempSync(join(tmpdir(), "amz-walk-"));
  const cappedDir = mkdtempSync(join(tmpdir(), "amz-cap-"));
  try {
    mkdirSync(join(smallDir, ".git"));
    writeFileSync(join(smallDir, ".git", "config"), "x\n");
    mkdirSync(join(smallDir, "node_modules"));
    writeFileSync(join(smallDir, "node_modules", "pkg.js"), "x\n");
    writeFileSync(join(smallDir, "keep.txt"), "k\n");
    assert.deepEqual(await listWorkspaceFiles(smallDir, ""), ["keep.txt"]);
    writeFileSync(join(cappedDir, "keep.txt"), "k\n");
    for (let index = 0; index < 205; index += 1) writeFileSync(join(cappedDir, `n${index}.txt`), "n\n");
    const capped = await listWorkspaceFiles(cappedDir, "");
    assert.equal(capped.length, 200);
    assert.equal(capped.some((path) => path.startsWith(".git") || path.includes("node_modules")), false);
    assert.deepEqual(await listWorkspaceFiles(cappedDir, "keep"), ["keep.txt"]);
  } finally {
    rmSync(smallDir, { recursive: true, force: true });
    rmSync(cappedDir, { recursive: true, force: true });
  }
});

test("five lists inside three seconds scan once, and a list after the cache expires scans again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amz-cache-"));
  const log = join(dir, "git-log");
  const bin = join(dir, "bin");
  const real = spawnSync("which", ["git"], { encoding: "utf8" });
  assert.equal(real.status, 0, real.stderr);
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = "ls-files" ]; then
  printf 'ls\\n' >> "$AMZ_GIT_LOG"
  "$REAL_GIT" "$@"
  status=$?
  printf '.git/config\\0node_modules/injected.js\\0'
  exit "$status"
fi
exec "$REAL_GIT" "$@"
`.replaceAll("$REAL_GIT", real.stdout.trim()));
  chmodSync(join(bin, "git"), 0o755);
  const previousPath = process.env.PATH;
  const previousLog = process.env.AMZ_GIT_LOG;
  const scans = (): number => readFileSync(log, "utf8").split("\n").filter((line) => line === "ls").length;
  try {
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, ["init"]);
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    process.env.AMZ_GIT_LOG = log;
    const first = await Promise.all([0, 1, 2, 3, 4].map(() => listWorkspaceFiles(dir, "")));
    for (const row of first) {
      assert.equal(row.includes("a.txt"), true);
      assert.equal(row.includes(".git/config"), false);
      assert.equal(row.includes("node_modules/injected.js"), false);
    }
    assert.equal(scans(), 1);
    writeFileSync(join(dir, "b.txt"), "b\n");
    const cached = await listWorkspaceFiles(dir, "");
    assert.equal(cached.includes("b.txt"), false);
    assert.equal(scans(), 1);
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const fresh = await listWorkspaceFiles(dir, "");
    assert.equal(fresh.includes("a.txt"), true);
    assert.equal(fresh.includes("b.txt"), true);
    assert.equal(fresh.includes(".git/config"), false);
    assert.equal(fresh.includes("node_modules/injected.js"), false);
    assert.equal(scans(), 2);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.AMZ_GIT_LOG;
    else process.env.AMZ_GIT_LOG = previousLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fullscreen client does not scan the workspace itself", () => {
  const root = fileURLToPath(new URL("../../tui/src", import.meta.url));
  const text = walk(root).filter((file) => file.endsWith(".ts")).map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(text.includes("ls-files"), false);
  const lister = readFileSync(fileURLToPath(new URL("../src/files.ts", import.meta.url)), "utf8");
  assert.equal(lister.includes("spawnSync"), false);
  assert.equal(lister.includes("execFile"), true);
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
