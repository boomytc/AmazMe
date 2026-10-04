import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Agent, type AgentEvent, type AgentHook, type AgentTool } from "@amazme/agent";
import { createModels, messageText, type AssistantMessage, type ToolResultMessage } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall, type FauxResponder } from "@amazme/ai/providers/faux";
import { AgentSession, SessionStore } from "@amazme/coding-agent";
import { FullscreenController, type FullscreenSession } from "../src/tui/controller.ts";
import { paintAnsi, renderFrame, statusText } from "../src/tui/frame.ts";
import { decodeKeys } from "../src/tui/keys.ts";
import { createFullscreenSession, shouldOpenFullscreen } from "../src/tui/run.ts";
import { Transcript } from "../src/tui/transcript.ts";

const usage = { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } };

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
}

function toolResult(text: string, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call_read",
    toolName: "read",
    content: [{ type: "text", text }],
    isError,
    timestamp: 2,
  };
}

function turnEnd(): AgentEvent {
  return { type: "turn_end", message: assistant("done"), toolResults: [] };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true);
}

function fakeSession(prompt: FullscreenSession["prompt"]) {
  const hooks: AgentHook[] = [];
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    prompt,
    agent: {
      hooks,
      subscribe(listener: (event: AgentEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(event: AgentEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

function readTool(onRun?: () => void): AgentTool {
  return {
    name: "read",
    description: "read",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute() {
      onRun?.();
      return { content: [{ type: "text", text: "file-body" }] };
    },
  };
}

function liveSession(respond: FauxResponder, tools: AgentTool[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "amazme-tui-"));
  const provider = fauxProvider({ respond });
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  const file = join(dir, "session.jsonl");
  const agent = new Agent({
    model,
    streamFn: models.streamSimple.bind(models),
    systemPrompt: "coder",
    tools,
  });
  const session = new AgentSession(SessionStore.create(file, dir), agent);
  return { session, file, provider, dir };
}

test("scroll area paints user text, assistant deltas, thinking, and the tool block in order", () => {
  const transcript = new Transcript();
  const partial = assistant("");
  transcript.apply({ type: "turn_start" });
  assert.equal(transcript.busy, true);
  transcript.apply({ type: "message_start", message: { role: "user", content: "你好", timestamp: 1 } });
  transcript.apply({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你", partial },
    delta: "你",
  });
  transcript.apply({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "好呀", partial },
    delta: "好呀",
  });
  transcript.apply({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "想一下", partial },
    delta: "想一下",
  });
  transcript.apply({ type: "tool_execution_start", toolCallId: "call_read", toolName: "read", args: { path: "a.txt" } });
  transcript.apply({ type: "tool_execution_update", toolCallId: "call_read", partial: "reading" });
  transcript.apply({
    type: "tool_execution_end",
    toolCallId: "call_read",
    toolName: "read",
    result: toolResult("file-body"),
    isError: false,
  });
  transcript.apply({ type: "message_end", message: assistant("你好呀") });

  assert.deepEqual(transcript.entries.map((entry) => entry.kind), ["user", "assistant", "thinking", "tool"]);
  const lines = transcript.lines();
  assert.equal(lines[0], "用户 你好");
  assert.equal(lines[1], "助手 你好呀");
  assert.equal(lines[2], "思考 想一下");
  assert.match(lines[3] ?? "", /read 开始/);
  assert.match(lines[3] ?? "", /reading/);
  assert.match(lines[3] ?? "", /read 结束 file-body/);
  assert.ok((lines[3] ?? "").indexOf("开始") < (lines[3] ?? "").indexOf("结束"));
  assert.equal(transcript.entries.filter((entry) => entry.kind === "assistant").length, 1);

  transcript.apply(turnEnd());
  assert.equal(transcript.busy, false);
  const state = {
    lines,
    busy: transcript.busy,
    notice: null,
    failure: null,
    queued: 0,
    input: "",
    confirmation: null,
  };
  assert.equal(statusText(state), "空闲");
  const frame = renderFrame(state, 80, 12);
  assert.equal(frame.status, "空闲");
  assert.equal(frame.status.includes("忙"), false);
  const painted = paintAnsi(frame.body);
  assert.match(painted, /用户 你好/);
  assert.match(painted, /思考 想一下/);
  assert.match(painted, /read 结束 file-body/);
  assert.equal(painted.includes("忙"), false);
  const visible = painted.replaceAll(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const userAt = visible.indexOf("用户 你好");
  const thoughtAt = visible.indexOf("思考 想一下");
  const toolAt = visible.indexOf("read 开始");
  assert.ok(userAt >= 0 && thoughtAt > userAt && toolAt > thoughtAt);
});

test("submit calls prompt once", async () => {
  const calls: string[] = [];
  let resolvePrompt: () => void = () => {};
  const session = fakeSession((input) => {
    calls.push(input);
    return new Promise((resolve) => {
      resolvePrompt = () => resolve(undefined);
    });
  });
  const ui = new FullscreenController(session);
  const pending = ui.submit("  hello  ");
  assert.deepEqual(calls, ["hello"]);
  session.emit({ type: "turn_start" });
  session.emit(turnEnd());
  resolvePrompt();
  await pending;
  assert.deepEqual(calls, ["hello"]);
  assert.equal(ui.busy, false);
});

test("a second line typed while busy is not another prompt before turn_end", async () => {
  const calls: string[] = [];
  let resolvePrompt: () => void = () => {};
  const session = fakeSession((input) => {
    calls.push(input);
    return new Promise((resolve) => {
      resolvePrompt = () => resolve(undefined);
    });
  });
  const ui = new FullscreenController(session);
  const first = ui.submit("one");
  session.emit({ type: "turn_start" });
  assert.equal(ui.busy, true);
  ui.handleInput({ type: "char", value: "t" });
  ui.handleInput({ type: "char", value: "w" });
  ui.handleInput({ type: "char", value: "o" });
  ui.handleInput({ type: "enter" });
  assert.equal(ui.queuedCount, 1);
  assert.deepEqual(calls, ["one"]);
  session.emit(turnEnd());
  assert.equal(ui.busy, false);
  assert.deepEqual(calls, ["one"]);
  const releaseFirst = resolvePrompt;
  releaseFirst();
  await first;
  assert.deepEqual(calls, ["one", "two"]);
  session.emit({ type: "turn_start" });
  session.emit(turnEnd());
  resolvePrompt();
  await until(() => ui.queuedCount === 0 && !ui.busy);
});

test("queued lines stay one prompt at a time on the same session", async () => {
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const { session, file, provider } = liveSession(async (context, _options, state) => {
    if (state.callCount === 1) await gate;
    const text = [...context.messages].reverse().find((message) => message.role === "user");
    return fauxAssistant(`faux:${text ? messageText(text) : ""}`);
  });
  let prompts = 0;
  const original = session.prompt.bind(session);
  session.prompt = (input) => {
    prompts += 1;
    return original(input);
  };
  const ui = new FullscreenController(session);
  const first = ui.submit("one");
  await until(() => ui.busy && prompts === 1);
  const second = ui.submit("two");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts, 1);
  assert.equal(provider.state.callCount, 1);
  assert.equal(ui.queuedCount, 1);
  releaseFirst();
  await first;
  assert.equal(prompts, 2);
  await second;
  assert.equal(prompts, 2);
  assert.equal(ui.busy, false);
  const raw = readFileSync(file, "utf8");
  assert.match(raw, /"type":"session"/);
  assert.match(raw, /"version":3/);
  assert.match(raw, /"content":"one"/);
  assert.match(raw, /"content":"two"/);
  assert.match(raw, /faux:one/);
  assert.match(raw, /faux:two/);
  session.close();
});

test("a line queued during a tool turn is not a prompt until that prompt returns", async () => {
  let releaseFollowUp: () => void = () => {};
  const followUp = new Promise<void>((resolve) => {
    releaseFollowUp = resolve;
  });
  const { session, provider } = liveSession(async (context, _options, state) => {
    if (state.callCount === 1) return fauxAssistant([fauxToolCall("read", { path: "a.txt" })]);
    await followUp;
    const tool = context.messages.find((message) => message.role === "toolResult");
    return fauxAssistant(tool ? messageText(tool) : "missing");
  }, [readTool()]);
  let prompts = 0;
  const original = session.prompt.bind(session);
  session.prompt = (input) => {
    prompts += 1;
    return original(input);
  };
  const ui = new FullscreenController(session);
  const first = ui.submit("one");
  await until(() => ui.confirmation !== null);
  const second = ui.submit("two");
  assert.equal(ui.queuedCount, 1);
  assert.equal(prompts, 1);
  ui.handleInput({ type: "char", value: "n" });
  await until(() => provider.state.callCount === 2);
  assert.equal(prompts, 1);
  assert.equal(ui.busy, true);
  releaseFollowUp();
  await first;
  assert.equal(prompts, 2);
  await second;
  assert.equal(ui.busy, false);
  session.close();
});

test("beforeToolCall asks on the same screen and rejection does not execute the tool", async () => {
  let runs = 0;
  const { session } = liveSession((context, _options, state) => {
    if (state.callCount === 1) return fauxAssistant([fauxToolCall("read", { path: "a.txt" })]);
    const tool = context.messages.find((message) => message.role === "toolResult");
    return fauxAssistant(tool ? messageText(tool) : "missing");
  }, [readTool(() => { runs += 1; })]);
  const ui = new FullscreenController(session);
  const done = ui.submit("go");
  await until(() => ui.confirmation !== null);
  assert.equal(ui.confirmation?.toolName, "read");
  assert.equal(runs, 0);
  const frame = renderFrame(ui.snapshot(), 80, 16);
  assert.match(frame.prompt, /允许执行 read/);
  assert.match(frame.scroll.join("\n"), /read 开始/);
  ui.handleInput({ type: "char", value: "n" });
  await done;
  assert.equal(runs, 0);
  assert.equal(ui.confirmation, null);
  const toolLine = ui.transcript.lines().find((line) => line.includes("read"));
  assert.match(toolLine ?? "", /结束 错误 用户拒绝/);
  session.close();
});

test("accepting the confirmation lets the original tool execute", async () => {
  let runs = 0;
  const { session } = liveSession((context, _options, state) => {
    if (state.callCount === 1) return fauxAssistant([fauxToolCall("read", { path: "a.txt" })]);
    const tool = context.messages.find((message) => message.role === "toolResult");
    return fauxAssistant(tool ? messageText(tool) : "missing");
  }, [readTool(() => { runs += 1; })]);
  const ui = new FullscreenController(session);
  const done = ui.submit("go");
  await until(() => ui.confirmation !== null);
  ui.handleInput({ type: "char", value: "y" });
  await done;
  assert.equal(runs, 1);
  assert.match(ui.transcript.lines().join("\n"), /file-body/);
  session.close();
});

test("empty ctrl-c does not cancel when prompt cannot take AbortSignal", async () => {
  assert.equal(AgentSession.prototype.prompt.length < 2, true);
  const calls: string[] = [];
  let settled = false;
  const session = fakeSession((input) => {
    calls.push(input);
    return new Promise(() => undefined);
  });
  const ui = new FullscreenController(session);
  void ui.submit("one").then(() => { settled = true; });
  session.emit({ type: "turn_start" });
  ui.handleInput({ type: "ctrl-c" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(ui.notice, "这一轮还在跑");
  assert.equal(ui.wantsExit, false);
  assert.deepEqual(calls, ["one"]);
  assert.equal(ui.busy, true);
  const frame = renderFrame(ui.snapshot(), 40, 8);
  assert.match(frame.status, /忙/);
  assert.match(frame.status, /这一轮还在跑/);
});

test("empty ctrl-c aborts the open turn when prompt already accepts AbortSignal", async () => {
  let seen: AbortSignal | undefined;
  let resolvePrompt: () => void = () => {};
  const prompt = (input: string, signal?: AbortSignal) => {
    assert.equal(input, "one");
    seen = signal;
    return new Promise<void>((resolve) => {
      resolvePrompt = resolve;
      signal?.addEventListener("abort", () => resolve());
    });
  };
  assert.equal(prompt.length >= 2, true);
  const session = fakeSession(prompt);
  const ui = new FullscreenController(session);
  const pending = ui.submit("one");
  session.emit({ type: "turn_start" });
  ui.handleInput({ type: "ctrl-c" });
  assert.equal(seen?.aborted, true);
  assert.equal(ui.notice, null);
  await pending;
  resolvePrompt();
  assert.equal(ui.wantsExit, false);
});

test("fullscreen opens only with no prompt on a terminal, and keeps the current session file", async () => {
  assert.equal(shouldOpenFullscreen("", true), true);
  assert.equal(shouldOpenFullscreen("一句话", true), false);
  assert.equal(shouldOpenFullscreen("", false), false);
  const dir = mkdtempSync(join(tmpdir(), "amazme-screen-"));
  const session = createFullscreenSession({
    provider: "faux",
    model: "faux-1",
    cwd: dir,
    credentialsFile: join(dir, "credentials.json"),
  });
  const ui = new FullscreenController(session);
  await ui.submit("hello");
  const folder = join(dir, ".amazme", "sessions");
  const files = readdirSync(folder);
  assert.equal(files.length, 1);
  const raw = readFileSync(join(folder, files[0] ?? ""), "utf8");
  assert.match(raw, /"version":3/);
  assert.match(raw, /"content":"hello"/);
  assert.match(raw, /faux:hello/);
  assert.equal(ui.busy, false);
  session.close();
});

test("keys decode enter, backspace, and ctrl-c without treating a partial escape as text", () => {
  assert.deepEqual(decodeKeys("ab\r").keys, [
    { type: "char", value: "a" },
    { type: "char", value: "b" },
    { type: "enter" },
  ]);
  assert.deepEqual(decodeKeys("\u0003").keys, [{ type: "ctrl-c" }]);
  assert.deepEqual(decodeKeys("中").keys, [{ type: "char", value: "中" }]);
  const partial = decodeKeys("\u001b");
  assert.deepEqual(partial.keys, []);
  assert.equal(partial.rest, "\u001b");
  assert.deepEqual(decodeKeys("\u001b[A").keys, [{ type: "up" }]);
  assert.deepEqual(decodeKeys("\u001b[6~").keys, [{ type: "page-down" }]);
});

test("the fullscreen view does not call the model itself", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const source = walk(root).filter((file) => file.endsWith(".ts")).map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(source.includes("@amazme/durable"), false);
  const view = ["transcript.ts", "keys.ts", "frame.ts", "controller.ts", "screen.ts"]
    .map((file) => readFileSync(new URL(`../src/tui/${file}`, import.meta.url), "utf8"))
    .join("\n");
  assert.equal(view.includes("streamFn"), false);
  assert.equal(view.includes("createModels"), false);
  assert.equal(view.includes("fauxProvider"), false);
  const controller = readFileSync(new URL("../src/tui/controller.ts", import.meta.url), "utf8");
  assert.match(controller, /prompt\.length >= 2/);
  assert.match(controller, /这一轮还在跑/);
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
