import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("amazme login prints a handback and does not open a browser or build a TUI", () => {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const host = readFileSync(new URL("../src/host.ts", import.meta.url), "utf8");
  const login = readFileSync(new URL("../src/login.ts", import.meta.url), "utf8");
  assert.equal(host.includes('join(cwd, "skills")'), true);
  assert.equal(host.includes("appendSkillText"), true);
  assert.equal(source.includes("appendMcpTools"), false);
  assert.equal(source.includes("McpClient"), false);
  assert.equal(source.includes("--mcp"), false);
  assert.equal(source.includes('process.argv[2] === "login"'), true);
  assert.equal(source.includes("onHandback"), true);
  assert.equal(source.includes("child_process"), false);
  assert.equal(source.includes("xdg-open"), false);
  assert.equal(login.includes("auth.oauth.login"), true);
  assert.equal(login.includes("child_process"), false);
  assert.equal(login.includes("xdg-open"), false);
});
