import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider } from "@amazme/ai/testing";
import {
  activateProject,
  cycleModels,
  executeSlash,
  loadedTheme,
  packageSkillText,
  parseSlash,
  type SlashActions,
} from "@amazme/tui";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID, runtimeFile, startCodingHost } from "../src/host.ts";

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "amz-align-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function textOf(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((block) => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "").join("");
}

async function openHost(t: test.TestContext, cwd: string) {
  const models = createModels();
  models.setProvider(fauxProvider({ respond: () => fauxAssistant("faux-reply") }));
  const socket = join(cwd, "host.sock");
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close("abort"));
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  await client.connect();
  t.after(() => client.dispose());
  const remote = new RuntimeClient(client);
  await remote.attach(HOST_RUNTIME_ID);
  const lane = remote.lane(HOST_LANE);
  return { remote, lane };
}

async function prompt(lane: { accept(request: { kind: "prompt"; text: string }): Promise<{ operationId: string }>; drive(id: string, options?: { waitForRetry?: boolean }): Promise<{ kind: string; operationId: string }> }, text: string) {
  const admitted = await lane.accept({ kind: "prompt", text });
  const outcome = await lane.drive(admitted.operationId, { waitForRetry: true });
  if (outcome.kind === "waiting") await lane.drive(outcome.operationId, { waitForRetry: true });
}

test("one workspace log keeps tree, fork, clone, compact, import, and export", { timeout: 20_000 }, async (t) => {
  const cwd = directory(t);
  const { remote, lane } = await openHost(t, cwd);
  await prompt(lane, "left-branch");
  const first = await lane.snapshot();
  const user = first.entries.find((entry) => entry.payload.type === "message" && entry.payload.message.role === "user");
  const assistant = first.entries.find((entry) => entry.payload.type === "message" && entry.payload.message.role === "assistant");
  assert.ok(user && assistant);
  assert.equal(textOf(assistant.payload.type === "message" ? assistant.payload.message : { content: "" }), "faux-reply");
  const navigated = await lane.accept({ kind: "navigation", targetId: user.id });
  await lane.drive(navigated.operationId, { waitForRetry: true });
  await prompt(lane, "from-selected");
  const branched = await lane.snapshot();
  const selected = [...branched.entries].reverse().find((entry) => entry.payload.type === "message" && entry.payload.message.role === "user" && textOf(entry.payload.message) === "from-selected");
  assert.ok(selected);
  assert.equal(selected.parentId, user.id);
  const raw = readFileSync(runtimeFile(cwd), "utf8");
  assert.match(raw, /left-branch/);
  assert.match(raw, /faux-reply/);
  assert.match(raw, /from-selected/);

  const actions: SlashActions = {
    cwd,
    lane: () => lane,
    active: () => HOST_LANE,
    list: () => remote.conversations(),
    open: async () => undefined,
    earlier: async () => "",
    continueRetry: async () => "",
  };
  const fork = await executeSlash({ type: "fork", name: "forked" }, actions);
  assert.equal(fork.type, "notice");
  assert.match(fork.type === "notice" ? fork.text : "", /forked/);
  const forked = await remote.lane("forked").snapshot();
  assert.equal(forked.tipId, selected.id);
  const forkedText = forked.entries.map((entry) => entry.payload.type === "message" ? textOf(entry.payload.message) : "").join("\n");
  assert.match(forkedText, /left-branch/);
  assert.match(forkedText, /from-selected/);
  const clone = await executeSlash({ type: "clone" }, { ...actions, lane: () => remote.lane(HOST_LANE), active: () => HOST_LANE });
  assert.match(clone.type === "notice" ? clone.text : "", /会话/);

  const compact = await executeSlash({ type: "compact" }, { ...actions, lane: () => remote.lane(HOST_LANE) });
  assert.equal(compact.type, "notice");
  const compacted = readFileSync(runtimeFile(cwd), "utf8");
  assert.match(compacted, /left-branch/);
  assert.match(compacted, /compaction/);

  writeFileSync(join(cwd, "in.jsonl"), `${JSON.stringify({ role: "user", text: "imported-user" })}\n${JSON.stringify({ role: "assistant", text: "imported-reply" })}\n`);
  const imported = await executeSlash({ type: "import", path: "in.jsonl" }, actions);
  assert.equal(imported.type, "notice");
  const resumed = imported.type === "notice" ? imported.text.replace("会话 ", "").trim() : "";
  assert.match(resumed, /^s\d+$/);
  const opened = await remote.lane(resumed).snapshot();
  const importedText = opened.entries.map((entry) => entry.payload.type === "message" ? textOf(entry.payload.message) : "").join("\n");
  assert.match(importedText, /imported-user/);
  assert.match(importedText, /imported-reply/);
  const exported = await executeSlash({ type: "export", path: "out.jsonl" }, { ...actions, lane: () => remote.lane(resumed), active: () => resumed });
  assert.equal(exported.type, "notice");
  const jsonl = readFileSync(join(cwd, "out.jsonl"), "utf8");
  assert.match(jsonl, /imported-user/);
  const html = await executeSlash({ type: "export", path: "out.html" }, { ...actions, lane: () => remote.lane(resumed), active: () => resumed });
  assert.equal(html.type, "notice");
  assert.match(readFileSync(join(cwd, "out.html"), "utf8"), /imported-reply/);
});

test("a trusted package loads skills, prompts, themes, and an extension command", async (t) => {
  const cwd = directory(t);
  const root = join(cwd, ".amazme");
  mkdirSync(join(root, "skills", "ship"), { recursive: true });
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(join(root, "themes"), { recursive: true });
  mkdirSync(join(root, "extensions"), { recursive: true });
  mkdirSync(join(root, "skills", "hidden"), { recursive: true });
  writeFileSync(join(root, "skills", "ship", "SKILL.md"), "---\nname: ship\ndescription: Ship the change\n---\nBODY\n");
  writeFileSync(join(root, "skills", "hidden", "SKILL.md"), "---\nname: hidden\ndisableModelInvocation: true\n---\nSECRET\n");
  writeFileSync(join(root, "prompts", "review.md"), "Review this diff");
  writeFileSync(join(root, "themes", "dark.json"), `${JSON.stringify({ accent: "147" })}\n`);
  writeFileSync(join(root, "extensions", "ping.mjs"), "export function register(api) { api.registerCommand('ping', (args) => `pong ${args}`.trim()); }\n");
  const before = await activateProject(cwd);
  assert.match(before, /未信任/);
  assert.equal(packageSkillText(cwd), "");
  const actions: SlashActions = {
    cwd,
    lane: () => { throw new Error("no lane"); },
    active: () => "main",
    list: async () => ["main"],
    open: async () => undefined,
    earlier: async () => "",
    continueRetry: async () => "",
  };
  const trusted = await executeSlash({ type: "trust" }, actions);
  assert.match(trusted.type === "notice" ? trusted.text : "", /已信任/);
  const skills = packageSkillText(cwd);
  assert.match(skills, /ship/);
  assert.equal(skills.includes("hidden"), false);
  assert.equal(skills.includes("SECRET"), false);
  assert.equal(loadedTheme(cwd)?.accent, "147");
  const expanded = parseSlash("/review the patch");
  assert.equal(expanded.type, "template");
  const submitted = await executeSlash(expanded.type === "template" ? expanded : { type: "trust" }, actions);
  assert.equal(submitted.type, "submit");
  assert.match(submitted.type === "submit" ? submitted.text : "", /Review this diff/);
  assert.match(submitted.type === "submit" ? submitted.text : "", /the patch/);
  const ping = await executeSlash(parseSlash("/ping there"), actions);
  assert.match(ping.type === "notice" ? ping.text : "", /pong there/);
  writeFileSync(join(root, "extensions", "pong.mjs"), "export function register(api) { api.registerCommand('later', () => 'later-ok'); }\n");
  const reloaded = await executeSlash({ type: "reload" }, actions);
  assert.match(reloaded.type === "notice" ? reloaded.text : "", /已重新加载/);
  const later = await executeSlash(parseSlash("/later"), actions);
  assert.match(later.type === "notice" ? later.text : "", /later-ok/);
  const setting = await executeSlash({ type: "settings", key: "theme", value: "dark" }, actions);
  assert.match(setting.type === "notice" ? setting.text : "", /theme=dark/);
  const again = await activateProject(cwd);
  assert.match(again, /已重新加载/);
  const read = await executeSlash({ type: "settings", key: "theme" }, actions);
  assert.match(read.type === "notice" ? read.text : "", /dark/);
  await executeSlash({ type: "scoped-models", spec: "faux/faux-1" }, actions);
  assert.equal(cycleModels(["faux/faux-1"], "openai/gpt-4o-mini"), "faux/faux-1");
  const share = await executeSlash({ type: "external", name: "share" }, actions);
  assert.match(share.type === "notice" ? share.text : "", /未配置/);
  assert.equal((share.type === "notice" ? share.text : "").includes("成功"), false);
  const unknown = parseSlash("/not-a-command");
  assert.equal(unknown.type, "notice");
  assert.match(unknown.type === "notice" ? unknown.text : "", /未知命令/);
});
