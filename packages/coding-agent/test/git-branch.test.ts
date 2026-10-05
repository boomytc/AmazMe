import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readGitBranch } from "../src/host.ts";

test("readGitBranch is null outside a repository and returns the branch name", () => {
  const dir = mkdtempSync(join(tmpdir(), "amz-branch-"));
  try {
    assert.equal(readGitBranch(dir), null);
    const init = spawnSync("git", ["init", "-b", "feature"], { cwd: dir, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    assert.equal(readGitBranch(dir), "feature");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
