import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readApprovalSettings, readRouterSettings, settingsFile } from "../src/settings.ts";

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amz-approval-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSettings(cwd: string, value: unknown): void {
  mkdirSync(join(cwd, ".amazme"), { recursive: true });
  writeFileSync(settingsFile(cwd), JSON.stringify(value));
}

test("missing approval and an empty tool list stay off", (t) => {
  const cwd = directory(t);
  assert.equal(readApprovalSettings(cwd), undefined);
  writeSettings(cwd, {});
  assert.equal(readApprovalSettings(cwd), undefined);
  writeSettings(cwd, { approval: { tools: [] } });
  assert.equal(readApprovalSettings(cwd), undefined);
  writeSettings(cwd, { router: { classifier: "typesafe/jev-latest", strong: "hand/strong", cheap: "hand/cheap" } });
  assert.equal(readApprovalSettings(cwd), undefined);
  assert.equal(readRouterSettings(cwd)?.strong, "hand/strong");
});

test("approval names the tools and can sit beside the router", (t) => {
  const cwd = directory(t);
  writeSettings(cwd, {
    router: { classifier: "typesafe/jev-latest", strong: "hand/strong", cheap: "hand/cheap" },
    approval: { tools: ["bash", "bash", "write"] },
  });
  assert.deepEqual(readApprovalSettings(cwd), { tools: ["bash", "write"] });
  assert.equal(readRouterSettings(cwd)?.cheap, "hand/cheap");
});

test("a present approval that does not match the schema throws", (t) => {
  const cwd = directory(t);
  writeSettings(cwd, { approval: { tools: [""] } });
  assert.throws(() => readApprovalSettings(cwd), /approval tools must be an array of tool names/);
  writeSettings(cwd, { theme: "dim" });
  assert.throws(() => readApprovalSettings(cwd), /only allows router and approval/);
  assert.throws(() => readRouterSettings(cwd), /only allows router and approval/);
});
