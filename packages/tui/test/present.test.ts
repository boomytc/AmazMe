import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import type { JsonValue } from "@amazme/protocol";
import { Server, ServiceError, type RuntimeCallContext, type RuntimeHandle, type RuntimeService, type SubscriptionSink } from "@amazme/server";
import { listenUnix } from "@amazme/server/unix";
import { emptyActivity, type LaneSnapshotDto } from "@amazme/runtime-service";
import { emptyTui, presentHost, reduceTui, renderTui, windowFrom, type TuiWindow } from "@amazme/tui";
import { createModels } from "@amazme/ai";
import { deepseekProvider } from "@amazme/ai/providers/deepseek";
import { codingLoginAccount, refuseImageTurn } from "../../coding-agent/src/tui/run.ts";

const LANE = "main";

test("present parks the cursor on one line, many lines, and CJK", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-cursor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await fakeHost(join(dir, "host.sock"));
  t.after(() => host.close());
  const tty = fakeTTY();
  tty.columns = 80;
  tty.rows = 24;
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE },
    tty.stdin,
    tty.stdout,
  );
  try {
    await until(() => tty.since(0).includes("空闲"), "the first paint");
    tty.push("hi");
    assert.equal(tty.chunks.at(-1), "\x1b[23;6H");
    tty.push("\u0003");
    tty.push("ab\x1b\rcd");
    tty.push("\x1b[A");
    assert.equal(tty.chunks.at(-1), "\x1b[22;6H");
    tty.push("\u0003");
    tty.push("中文");
    assert.equal(tty.chunks.at(-1), "\x1b[23;8H");
    tty.push("\u0003");
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u0004");
    await Promise.race([
      screen.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\npaint=${tty.chunks.at(-1)}`);
  }
});

test("typing fills the composer and enter submits", () => {
  let state = emptyTui();
  state = reduceTui(state, { type: "key", key: { type: "char", value: "h" } }).state;
  state = reduceTui(state, { type: "key", key: { type: "char", value: "i" } }).state;
  assert.equal(state.input, "hi");
  assert.equal(state.cursor, 2);
  const submitted = reduceTui(state, { type: "key", key: { type: "enter" } });
  assert.deepEqual(submitted.effect, { type: "submit", text: "hi" });
  assert.equal(submitted.state.input, "");
});

test("a busy composer still submits, and ctrl-c asks to abort", () => {
  const busy = reduceTui(emptyTui(), { type: "window", window: window({ busy: true }) }).state;
  assert.equal(reduceTui(busy, { type: "key", key: { type: "enter" } }).effect, null);
  let typing = busy;
  for (const value of ["n", "e", "x", "t"]) {
    typing = reduceTui(typing, { type: "key", key: { type: "char", value } }).state;
  }
  const follow = reduceTui(typing, { type: "key", key: { type: "enter" } });
  assert.deepEqual(follow.effect, { type: "submit", text: "next" });
  const aborted = reduceTui(busy, { type: "key", key: { type: "ctrl-c" } });
  assert.deepEqual(aborted.effect, { type: "abort" });
  assert.equal(aborted.state.exitArmed, false);
});

test("the attached screen submits, follows up while busy, aborts, and redraws on resize", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-present-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await fakeHost(join(dir, "host.sock"));
  t.after(() => host.close());
  const tty = fakeTTY();
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE },
    tty.stdin,
    tty.stdout,
  );
  try {
    await until(() => tty.since(0).includes("空闲"), "the first paint");
    tty.push("hi");
    await until(() => tty.since(0).includes("hi"), "the typed composer");
    tty.push("\r");
    await until(() => host.calls.some((call) => call.method === "accept" && call.text === "hi"), "the idle submit");
    await until(() => host.calls.some((call) => call.method === "drive"), "the drive after submit");
    const beforeBusy = tty.chunks.length;
    await host.hold("op-live");
    await until(() => tty.since(beforeBusy).includes("忙"), "the busy status");
    tty.push("later");
    await until(() => tty.since(beforeBusy).includes("later"), "the follow-up draft");
    tty.push("\r");
    await until(() => host.calls.some((call) => call.method === "followUp" && call.text === "later"), "followUp while an operation is open");
    await until(() => tty.since(beforeBusy).includes("排队 1"), "queued follow-up count");
    assert.equal(host.calls.filter((call) => call.method === "accept").length, 1);
    tty.push("\u0003");
    await until(() => host.calls.some((call) => call.method === "requestAbort" && call.operationId === "op-live"), "requestAbort");
    const beforeIdle = tty.chunks.length;
    await host.release();
    await until(() => tty.since(beforeIdle).includes("空闲"), "idle after the operation leaves");
    const beforeResize = tty.chunks.length;
    tty.columns = 20;
    tty.rows = 10;
    tty.emitResize();
    await until(() => tty.chunks.length > beforeResize, "a redraw after resize");
    const redraw = tty.since(beforeResize);
    assert.match(redraw, /─{20}/);
    assert.equal(redraw.includes("─".repeat(80)), false);
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u0004");
    await Promise.race([
      screen.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\ncalls=${JSON.stringify(host.calls)}\npaint=${tty.chunks.join("")}`);
  }
});

test("ctrl-y writes the last assistant reply with OSC 52", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-copy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await fakeHost(join(dir, "host.sock"));
  t.after(() => host.close());
  const tty = fakeTTY();
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE },
    tty.stdin,
    tty.stdout,
  );
  try {
    await until(() => tty.since(0).includes("空闲"), "the first paint");
    const before = tty.chunks.length;
    tty.push("\u0019");
    await until(() => tty.since(before).includes("没有助手回复"), "notice when nothing was said");
    assert.equal(tty.since(before).includes("\x1b]52;"), false);
    await host.showAssistant("hello-reply");
    await until(() => tty.since(0).includes("hello-reply"), "the assistant reply");
    const mark = tty.chunks.length;
    tty.push("\u0019");
    const payload = Buffer.from("hello-reply", "utf8").toString("base64");
    await until(() => tty.since(mark).includes(`\x1b]52;c;${payload}\x07`), "OSC 52");
    assert.match(tty.since(mark), /已复制/);
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u0004");
    await Promise.race([
      screen.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\npaint=${tty.since(0)}`);
  }
});

test("/copy code writes the last fence and does not emit OSC 52 when there is none", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-copy-code-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await fakeHost(join(dir, "host.sock"));
  t.after(() => host.close());
  const tty = fakeTTY();
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE },
    tty.stdin,
    tty.stdout,
  );
  try {
    await until(() => tty.since(0).includes("空闲"), "the first paint");
    await host.showAssistant("plain answer");
    await until(() => tty.since(0).includes("plain answer"), "the plain reply");
    const before = tty.chunks.length;
    tty.push("/copy code\r");
    await until(() => tty.since(before).includes("没有代码块"), "notice when the reply has no fence");
    assert.equal(tty.since(before).includes("\x1b]52;"), false);
    await host.showAssistant("intro\n```ts\nconst first = 1;\n```\n```js\nconst last = 2;\n```");
    await until(() => tty.since(0).includes("const last = 2;"), "the fenced reply");
    const mark = tty.chunks.length;
    tty.push("/copy code\r");
    const payload = Buffer.from("const last = 2;", "utf8").toString("base64");
    await until(() => tty.since(mark).includes(`\x1b]52;c;${payload}\x07`), "OSC 52 of the last fence");
    assert.match(tty.since(mark), /已复制/);
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u0004");
    await Promise.race([
      screen.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\npaint=${tty.since(0)}`);
  }
});

test("a failed assistant turn shows its error in the conversation", () => {
  const snapshot: LaneSnapshotDto = {
    version: 0,
    lane: LANE,
    tipId: "e1",
    phase: null,
    operationId: null,
    lastOperationId: null,
    status: null,
    pendingResponse: null,
    tools: [],
    entries: [{
      id: "e1",
      parentId: null,
      seq: 0,
      timestamp: 1,
      payload: {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "OpenAI completions 401 authentication: invalid api key",
        },
      },
    }],
    activity: emptyActivity(),
  };
  const view = windowFrom(snapshot, [LANE], LANE);
  assert.equal(view.entries[0]?.text, "OpenAI completions 401 authentication: invalid api key");
  const painted = renderTui(reduceTui(emptyTui(), { type: "window", window: view }).state, 100);
  assert.match(painted, /401/);
  assert.match(painted, /空闲/);
});

function window(partial: Partial<TuiWindow>): TuiWindow {
  return {
    entries: [],
    pendingText: "",
    tools: [],
    busy: false,
    sessions: [LANE],
    active: LANE,
    ...partial,
  };
}

type Recorded =
  | { method: "accept"; text: string }
  | { method: "drive"; operationId: string }
  | { method: "followUp"; text: string }
  | { method: "requestAbort"; operationId: string };

test("account login is told the current lane model", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-account-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await fakeHost(join(dir, "host.sock"));
  t.after(() => host.close());
  const tty = fakeTTY();
  let seen = "";
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE, cwd: dir },
    tty.stdin,
    tty.stdout,
    {
      login: async (_provider, _handback, current) => {
        seen = current ?? "";
        return "已保存 anthropic，模型循环加入 1 个";
      },
      logout: async () => "",
      catalog: async () => [{ id: "anthropic", name: "Anthropic", stored: false, storedType: null, oauth: true, apiKey: false }],
    },
  );
  try {
    await until(() => tty.since(0).includes("空闲"), "the first paint");
    tty.push("/login anthropic\r");
    await until(() => seen === "faux/faux-1", "the lane model");
    assert.equal(seen, "faux/faux-1");
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u0004");
    await Promise.race([
      screen.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\npaint=${tty.chunks.at(-1)}`);
  }
});

test("an API key login writes scoped models and /model sees them without a restart", { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-login-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await fakeHost(join(dir, "host.sock"), [
    { provider: "faux", modelId: "faux-1" },
    { provider: "deepseek", modelId: "deepseek-flash" },
    { provider: "deepseek", modelId: "deepseek-v4-pro" },
    { provider: "other", modelId: "hidden" },
  ]);
  t.after(() => host.close());
  const tty = fakeTTY();
  tty.columns = 120;
  tty.rows = 40;
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE, cwd: dir },
    tty.stdin,
    tty.stdout,
    codingLoginAccount({ cwd: dir, credentialsFile: join(dir, "credentials.json") }),
  );
  try {
    await until(() => tty.since(0).includes("空闲"), "the first paint");
    tty.push("/login deepseek\r");
    await until(() => tty.since(0).includes("API key for"), "the API key prompt");
    tty.push("sk-deepseek\r");
    await until(() => tty.since(0).includes("模型循环加入 3 个"), "the saved notice");
    tty.push("/model\r");
    await until(() => tty.since(0).includes("deepseek/deepseek-v4-pro"), "the model picker");
    const painted = tty.since(0);
    assert.equal(painted.includes("deepseek/deepseek-flash"), true);
    assert.equal(painted.includes("other/hidden"), false);
    const saved = JSON.parse(readFileSync(join(dir, ".amazme", "project.json"), "utf8")) as { scopedModels: string[] };
    assert.deepEqual(saved.scopedModels, ["faux/faux-1", "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
    tty.push("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 80));
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 80));
    tty.push("\u0004");
    await Promise.race([
      screen.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\npaint=${tty.chunks.at(-1)}`);
  }
});

test("/model lists scoped models, filters, and enter plus ctrl-p configure the lane", { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-model-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".amazme"));
  writeFileSync(join(dir, ".amazme", "project.json"), `${JSON.stringify({
    trusted: false,
    settings: {},
    names: {},
    scopedModels: ["faux/faux-1", "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro", "typesafe/jev-latest", "notes"],
  }, null, 2)}\n`);
  const host = await fakeHost(join(dir, "host.sock"), [
    { provider: "faux", modelId: "faux-1" },
    { provider: "deepseek", modelId: "deepseek-flash" },
    { provider: "deepseek", modelId: "deepseek-v4-pro" },
    { provider: "catalog-only", modelId: "not-scoped" },
    { provider: "typesafe", modelId: "jev-latest" },
  ]);
  t.after(() => host.close());
  const tty = fakeTTY();
  tty.columns = 60;
  tty.rows = 16;
  const attach = { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE, cwd: dir };
  const screen = presentHost(attach, tty.stdin, tty.stdout);
  try {
    await until(() => tty.since(0).includes("空闲"), "the first paint");
    tty.push("\u0010");
    await until(() => tty.since(0).includes("模型 deepseek/deepseek-flash"), "ctrl-p notice");
    tty.push("/model\r");
    await until(() => tty.since(0).includes("Select model:"), "the model picker");
    const opened = tty.since(0);
    assert.equal(opened.includes("deepseek/deepseek-flash"), true);
    assert.equal(opened.includes("deepseek/deepseek-v4-pro"), true);
    assert.equal(opened.includes("catalog-only/not-scoped"), false);
    assert.equal(opened.includes("jev"), false);
    assert.equal(opened.includes("notes"), false);
    tty.push("v4\r");
    await until(() => host.configures.some((call) => call.provider === "deepseek" && call.modelId === "deepseek-v4-pro"), "enter configure");
    await until(() => tty.since(0).includes("模型 deepseek/deepseek-v4-pro"), "the switched notice");
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u001b");
    tty.push("\u0004");
    await Promise.race([screen.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\npaint=${tty.chunks.at(-1)}`);
  }

  const again = fakeTTY();
  again.columns = 60;
  again.rows = 16;
  const reopened = presentHost(attach, again.stdin, again.stdout);
  try {
    await until(() => again.since(0).includes("deepseek/deepseek-v4-pro"), "the reopened model");
    again.push("\u0004");
    await reopened;
  } catch (error) {
    again.push("\u0004");
    await Promise.race([reopened.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\npaint=${again.chunks.at(-1)}`);
  }
});

test("an empty scoped list does not dump the catalog", { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-empty-model-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await fakeHost(join(dir, "host.sock"), [
    { provider: "catalog-only", modelId: "not-scoped" },
    { provider: "typesafe", modelId: "jev-latest" },
  ]);
  t.after(() => host.close());
  const tty = fakeTTY();
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE, cwd: dir },
    tty.stdin,
    tty.stdout,
  );
  try {
    await until(() => tty.since(0).includes("空闲"), "the first paint");
    tty.push("/model\r");
    await until(() => tty.since(0).includes("no match"), "the empty picker");
    const painted = tty.since(0);
    assert.equal(painted.includes("catalog-only/not-scoped"), false);
    assert.equal(painted.includes("jev"), false);
    tty.push("\u001b");
    tty.push("\u0010");
    await until(() => tty.since(0).includes("模型循环未限制"), "ctrl-p with nothing scoped");
    assert.equal(host.configures.some((call) => call.provider !== undefined), false);
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u001b");
    tty.push("\u0004");
    await Promise.race([screen.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\npaint=${tty.chunks.at(-1)}`);
  }
});

test("/thinking lists the current model's levels; deepseek-flash is off, low, and high", { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-thinking-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await fakeHost(join(dir, "host.sock"), [], {
    provider: "deepseek",
    modelId: "deepseek-flash",
    thinkingLevel: "off",
    thinkingLevels: ["off", "low", "high"],
  });
  t.after(() => host.close());
  const tty = fakeTTY();
  tty.columns = 80;
  tty.rows = 32;
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE, cwd: dir },
    tty.stdin,
    tty.stdout,
  );
  try {
    await until(() => tty.since(0).includes("空闲"), "the first paint");
    const opened = tty.chunks.length;
    tty.push("/thinking\r");
    await until(() => tty.since(opened).includes("Select thinking level:"), "the thinking picker");
    const listed = tty.since(opened);
    assert.equal(listed.includes("low"), true);
    assert.equal(listed.includes("high"), true);
    assert.equal(listed.includes("minimal"), false);
    assert.equal(listed.includes("medium"), false);
    tty.push("\u001b");
    const rejected = tty.chunks.length;
    tty.push("/thinking medium\r");
    await until(() => tty.since(rejected).includes("未知思考级别。可用 off low high"), "the model levels");
    assert.equal(tty.since(rejected).includes("minimal"), false);
    assert.equal(host.configures.some((call) => call.thinkingLevel === "medium"), false);
    const accepted = tty.chunks.length;
    tty.push("/thinking high\r");
    await until(() => host.configures.some((call) => call.thinkingLevel === "high"), "high applied");
    await until(() => tty.since(accepted).includes("思考 high"), "the high notice");
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u001b");
    tty.push("\u0004");
    await Promise.race([screen.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\npaint=${tty.since(0)}`);
  }
});

test("deepseek-v4-pro restores the composer and does not accept an image", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-image-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const host = await fakeHost(join(dir, "host.sock"), [], { provider: "deepseek", modelId: "deepseek-v4-pro" });
  t.after(() => host.close());
  const models = createModels();
  models.setProvider(deepseekProvider());
  const tty = fakeTTY();
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE, cwd: dir },
    tty.stdin,
    tty.stdout,
    undefined,
    {
      refuseImages: (provider, modelId, content) => refuseImageTurn(models, provider, modelId, content),
    },
  );
  try {
    await until(() => tty.since(0).includes("空闲"), "the first paint");
    tty.push("look @shot.png");
    await until(() => tty.since(0).includes("look @shot.png"), "the image draft");
    tty.push("\r");
    await until(() => tty.since(0).includes("Model deepseek-v4-pro does not accept image input"), "the refusal");
    assert.equal(tty.since(0).includes("look @shot.png"), true);
    assert.equal(host.calls.some((call) => call.method === "accept" || call.method === "followUp"), false);
    tty.push("\u0003");
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u0003");
    tty.push("\u0004");
    await Promise.race([
      screen.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\ncalls=${JSON.stringify(host.calls)}\npaint=${tty.since(0)}`);
  }
});

async function fakeHost(
  socket: string,
  models: Array<{ provider: string; modelId: string }> = [],
  initial: {
    provider: string;
    modelId: string;
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
    thinkingLevels?: readonly ("off" | "minimal" | "low" | "medium" | "high")[];
  } = { provider: "faux", modelId: "faux-1" },
) {
  const calls: Recorded[] = [];
  const configures: Array<{ provider?: string; modelId?: string; thinkingLevel?: string }> = [];
  let provider = initial.provider;
  let modelId = initial.modelId;
  let thinkingLevel = initial.thinkingLevel ?? "off";
  const thinkingLevels = [...(initial.thinkingLevels ?? ["off"])];
  let version = 1;
  let operationId: string | null = null;
  let assistantReply: string | null = null;
  let sink: SubscriptionSink | undefined;
  const entries = () => assistantReply === null ? [] : [{
    id: "reply-1",
    parentId: null,
    seq: 0,
    timestamp: 1,
    payload: {
      type: "message" as const,
      message: { role: "assistant", content: [{ type: "text", text: assistantReply }] },
    },
  }];
  const view = () => ({
    version,
    lane: LANE,
    tipId: assistantReply === null ? null : "reply-1",
    phase: operationId ? "assistant_ready" as const : null,
    operationId,
    lastOperationId: null,
    status: operationId ? "open" as const : null,
    entries: entries(),
    pendingResponse: null,
    tools: [],
    omitted: 0,
    skipped: 0,
    pendingOmitted: false,
    activity: emptyActivity(),
  });
  const publish = async (): Promise<void> => {
    if (!sink || sink.closed) return;
    await sink.send({ kind: "advance", advance: view() });
  };
  const commit = async (next: string | null): Promise<void> => {
    version += 1;
    operationId = next;
    await publish();
  };
  const service: RuntimeService = {
    async call(raw: JsonValue, context: RuntimeCallContext): Promise<JsonValue | undefined> {
      if (!isObject(raw) || typeof raw.method !== "string") throw new ServiceError("invalid_call", "invalid runtime call");
      switch (raw.method) {
        case "subscribe": {
          if (typeof raw.subscriptionId !== "string") throw new ServiceError("invalid_call", "missing subscription");
          sink = context.openSubscription(raw.subscriptionId);
          return view();
        }
        case "unsubscribe":
          sink?.close();
          sink = undefined;
          return null;
        case "configure": {
          const nextProvider = typeof raw.provider === "string" ? raw.provider : undefined;
          const nextModel = typeof raw.modelId === "string" ? raw.modelId : undefined;
          const nextThinking = typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : undefined;
          configures.push({
            ...(nextProvider !== undefined ? { provider: nextProvider } : {}),
            ...(nextModel !== undefined ? { modelId: nextModel } : {}),
            ...(nextThinking !== undefined ? { thinkingLevel: nextThinking } : {}),
          });
          if (nextProvider !== undefined && nextModel !== undefined) {
            provider = nextProvider;
            modelId = nextModel;
          }
          if (nextThinking !== undefined) {
            const level = thinkingLevels.find((item) => item === nextThinking);
            if (!level) {
              throw new ServiceError("invalid_call", `thinking level ${nextThinking} is not supported; available: ${thinkingLevels.join(", ")}`);
            }
            thinkingLevel = level;
          }
          return { provider, modelId, thinkingLevel, thinkingLevels };
        }
        case "catalog":
          return { directory: "work", models, thinkingLevels };
        case "snapshot":
          return {
            version,
            lane: LANE,
            tipId: assistantReply === null ? null : "reply-1",
            phase: operationId ? "assistant_ready" : null,
            operationId,
            lastOperationId: null,
            status: operationId ? "open" : null,
            entries: entries(),
            pendingResponse: null,
            tools: [],
            activity: emptyActivity(),
          };
        case "accept": {
          const request = raw.request;
          const text = isObject(request) && typeof request.text === "string" ? request.text : "";
          calls.push({ method: "accept", text });
          await commit("op-1");
          return { operationId: "op-1", kind: "run", startedAt: 1 };
        }
        case "drive": {
          const id = typeof raw.operationId === "string" ? raw.operationId : "";
          calls.push({ method: "drive", operationId: id });
          await commit(null);
          return {
            kind: "settled",
            result: {
              operationId: id,
              lane: LANE,
              kind: "run",
              status: "completed",
              fromTipId: null,
              tipId: null,
              startedAt: 1,
              endedAt: 2,
            },
          };
        }
        case "followUp": {
          const text = typeof raw.text === "string" ? raw.text : "";
          calls.push({ method: "followUp", text });
          return { entryId: "follow-1" };
        }
        case "requestAbort": {
          const id = typeof raw.operationId === "string" ? raw.operationId : "";
          calls.push({ method: "requestAbort", operationId: id });
          return { operationId: id, newlyRequested: true };
        }
        case "pendingApprovals":
          return { version, items: [] };
        case "files":
          return { paths: [] };
        case "approve":
          return null;
        default:
          throw new ServiceError("invalid_call", `unexpected ${raw.method}`);
      }
    },
  };
  const handle: RuntimeHandle = {
    acquire: () => ({ service, release() {} }),
    close: () => Promise.resolve(),
    idle: () => true,
  };
  const errors: Error[] = [];
  const server = new Server({
    serverId: "tui-test",
    onError: (error) => errors.push(error),
    service: {
      async call(raw, context) {
        if (!isObject(raw) || raw.method !== "attach" || raw.runtimeId !== "main") {
          throw new ServiceError("invalid_call", "attach main only");
        }
        await context.attach("main");
        return { attached: true };
      },
    },
    openRuntime(runtimeId) {
      return Promise.resolve(runtimeId === "main" ? handle : null);
    },
  });
  const listener = await listenUnix(server, { path: socket, onError: (error) => errors.push(error) });
  return {
    path: socket,
    calls,
    configures,
    errors,
    hold: (id: string) => commit(id),
    release: () => commit(null),
    showAssistant: async (text: string) => {
      assistantReply = text;
      version += 1;
      await publish();
    },
    close: async () => {
      await server.close();
      await listener.close();
    },
  };
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fakeTTY() {
  const input = new EventEmitter();
  const output = new EventEmitter();
  const chunks: string[] = [];
  const stdin = Object.assign(input, {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      this.isRaw = mode;
      return this;
    },
    resume() { return this; },
    pause() { return this; },
  });
  const stdout = Object.assign(output, {
    isTTY: true,
    columns: 80,
    rows: 24,
    write(chunk: string | Uint8Array) {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
  });
  return {
    stdin: stdin as unknown as ReadStream,
    stdout: stdout as unknown as WriteStream,
    chunks,
    get columns() { return stdout.columns; },
    set columns(value: number) { stdout.columns = value; },
    get rows() { return stdout.rows; },
    set rows(value: number) { stdout.rows = value; },
    push(text: string) { input.emit("data", text); },
    emitResize() { output.emit("resize"); },
    since(mark: number) { return chunks.slice(mark).join(""); },
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 5_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
