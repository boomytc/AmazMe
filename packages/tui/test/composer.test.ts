import assert from "node:assert/strict";
import test from "node:test";
import { decodeKeys, emptyTui, parseSlash, reduceTui, renderTui, type TuiEffect, type TuiState, type TuiWindow } from "@amazme/tui";
import { KeyDecoder } from "../src/keys.ts";
import { BINDINGS } from "../src/bindings.ts";
import { plainScreen, playScreen, SCREEN_COLUMNS, SCREEN_ROWS } from "./screen.ts";

function frame(state: TuiState, columns = SCREEN_COLUMNS, rows = SCREEN_ROWS): string {
  return plainScreen(renderTui(state, columns, rows));
}

function play(input: string, state: TuiState = emptyTui(), columns = SCREEN_COLUMNS, rows = SCREEN_ROWS): {
  state: TuiState;
  effects: TuiEffect[];
  screen: string;
} {
  const decoded = decodeKeys(input);
  if (decoded.rest.length > 0) throw new Error("按键序列被截断");
  let current = state;
  const effects: TuiEffect[] = [];
  for (const key of decoded.keys) {
    const step = reduceTui(current, { type: "key", key });
    current = step.state;
    if (step.effect) effects.push(step.effect);
  }
  return { state: current, effects, screen: frame(current, columns, rows) };
}

test("enter sends, and shift-enter or alt-enter only inserts a newline", () => {
  assert.deepEqual(decodeKeys("\x1b[27;2;13~").keys, [{ type: "newline" }]);
  assert.deepEqual(decodeKeys("\x1b[13;2u").keys, [{ type: "newline" }]);
  assert.deepEqual(decodeKeys("\x1b\r").keys, [{ type: "newline" }]);
  const shifted = play("a\x1b[13;2ub");
  assert.equal(shifted.state.input, "a\nb");
  assert.deepEqual(shifted.effects, []);
  const sent = play("\r", shifted.state);
  assert.deepEqual(sent.effects, [{ type: "submit", text: "a\nb" }]);
  const alt = play("a\x1b\rb\r");
  assert.deepEqual(alt.effects, [{ type: "submit", text: "a\nb" }]);
});

test("up and down recall history only from the first or last line", () => {
  let state = play("one\r").state;
  state = play("two\r", state).state;
  state = play("\x1b[A", state).state;
  assert.equal(state.input, "two");
  state = play("\x1b[A", state).state;
  assert.equal(state.input, "one");
  state = play("\x1b[B", state).state;
  assert.equal(state.input, "two");
  state = play("\x1b[B", state).state;
  assert.equal(state.input, "");

  const multiline = play("ab\x1b[13;2ucd");
  assert.equal(multiline.state.input, "ab\ncd");
  const moved = play("\x1b[A", multiline.state);
  assert.equal(moved.state.input, "ab\ncd");
  assert.equal(moved.state.cursor < multiline.state.cursor, true);
  const stayed = play("\x1b[A", moved.state);
  assert.equal(stayed.state.input, "ab\ncd");
  assert.equal(stayed.state.historyAt, null);
});

test("a bracketed paste keeps its newlines and does not send", () => {
  const pasted = play("\x1b[200~a\r\nb\x1b[201~");
  assert.equal(pasted.state.input, "a\nb");
  assert.deepEqual(pasted.effects, []);
  const sent = play("\r", pasted.state);
  assert.deepEqual(sent.effects, [{ type: "submit", text: "a\nb" }]);
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.push("\x1b[200~hi\n"), []);
  assert.deepEqual(decoder.push("there\x1b[201~x"), [
    { type: "paste", text: "hi\nthere" },
    { type: "char", value: "x" },
  ]);
});

test("the footer shows model, thinking, directory, and status, and hides meters without data", () => {
  const bare = frame({ ...emptyTui(), directory: "/work", provider: "faux", modelId: "faux-1", thinking: "high" });
  assert.match(bare, /faux\/faux-1\s+high\s+\/work\s+main\s+空闲/);
  assert.equal(bare.includes("tok"), false);
  assert.equal(bare.includes("上下文"), false);
  assert.equal(bare.includes("命中"), false);
  assert.equal(bare.includes("$"), false);
  assert.equal(bare.includes("排队"), false);
  assert.match(bare, /输入消息/);
  assert.match(bare, /┌/);
  assert.match(bare, /┘/);
  assert.match(bare, /Shift\+Enter\/Alt\+Enter 换行/);
  assert.match(bare, /\? 快捷键/);
  assert.match(bare, /Ctrl-C 退出/);

  const filled = frame({
    ...emptyTui(),
    directory: "/work",
    provider: "faux",
    modelId: "faux-1",
    thinking: "high",
    busy: true,
    queued: 2,
    meters: { tokens: 12, contextPercent: 3, hitPercent: 50, costUsd: 0.02 },
  }, 100, 24);
  assert.match(filled, /12 tok/);
  assert.match(filled, /上下文 3%/);
  assert.match(filled, /命中 50%/);
  assert.match(filled, /\$0\.02/);
  assert.match(filled, /排队 2/);
  assert.match(filled, /忙/);
});

test("an idle window clears the queued count", () => {
  const busy = reduceTui(emptyTui(), { type: "window", window: window({ busy: true }) }).state;
  const queued = { ...busy, queued: 2 };
  assert.match(frame(queued), /排队 2/);
  const idle = reduceTui(queued, { type: "window", window: window({ busy: false }) }).state;
  assert.equal(idle.queued, 0);
  assert.equal(frame(idle).includes("排队"), false);
});

test("question opens the shortcut sheet from the same table as /hotkeys, and escape closes it", () => {
  const ids = BINDINGS.map((binding) => binding.id);
  assert.equal(new Set(ids).size, ids.length);
  const opened = reduceTui(emptyTui(), { type: "key", key: { type: "char", value: "?" } });
  assert.equal(opened.state.overlay, true);
  assert.equal(opened.state.input, "");
  const help = parseSlash("/hotkeys");
  assert.equal(help.type, "notice");
  const screen = frame(opened.state, 80, 40);
  for (const line of help.text.split("\n")) assert.ok(screen.includes(line), line);
  assert.match(help.text, /空闲且输入为空时离开全屏/);
  const closed = reduceTui(opened.state, { type: "key", key: { type: "escape" } });
  assert.equal(closed.state.overlay, false);
  assert.equal(closed.state.focus, "prompt");
  const typed = play("a?");
  assert.equal(typed.state.input, "a?");
  assert.equal(typed.state.overlay, false);
});

test("ctrl-d leaves only when idle and the composer is empty", () => {
  assert.deepEqual(reduceTui(emptyTui(), { type: "key", key: { type: "ctrl-d" } }).effect, { type: "quit" });
  const busy = reduceTui(emptyTui(), { type: "window", window: window({ busy: true }) }).state;
  assert.equal(reduceTui(busy, { type: "key", key: { type: "ctrl-d" } }).effect, null);
  const typed = reduceTui(emptyTui(), { type: "key", key: { type: "char", value: "a" } }).state;
  assert.equal(reduceTui(typed, { type: "key", key: { type: "ctrl-d" } }).effect, null);
  assert.equal(reduceTui(typed, { type: "key", key: { type: "ctrl-d" } }).state.input, "a");
});

test("the shortcut sheet and a pasted newline render through the screen harness", () => {
  const sheet = playScreen({ steps: [{ type: "keys", input: "?" }] });
  assert.equal(sheet.screen.split("\n").length, SCREEN_ROWS);
  assert.equal(sheet.screen.split("\n").includes("快捷键"), true);
  assert.equal(sheet.effects.length, 0);
  const tight = frame(reduceTui(emptyTui(), { type: "key", key: { type: "char", value: "?" } }).state, 60, 8);
  assert.equal(tight.split("\n")[0], "快捷键");
  const pasted = playScreen({ steps: [{ type: "keys", input: "\u001b[200~a\r\nb\u001b[201~" }] });
  assert.match(pasted.screen, /a/);
  assert.match(pasted.screen, /b/);
  assert.deepEqual(pasted.effects, []);
});

function window(partial: Partial<TuiWindow>): TuiWindow {
  return {
    entries: [],
    pendingText: "",
    tools: [],
    busy: false,
    sessions: ["main"],
    active: "main",
    ...partial,
  };
}
