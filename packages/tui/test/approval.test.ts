import assert from "node:assert/strict";
import test from "node:test";
import { emptyTui, reduceTui, renderTui, summarizeArgs, type TuiWindow } from "@amazme/tui";

const SGR = /\u001b\[[0-9;]*m/g;

function window(partial: Partial<TuiWindow> = {}): TuiWindow {
  return {
    entries: [],
    pendingText: "",
    tools: [],
    busy: true,
    sessions: ["main"],
    active: "main",
    ...partial,
  };
}

function plain(state: ReturnType<typeof emptyTui>): string {
  return renderTui(state, 80, 24).replace(SGR, "");
}

test("summarizeArgs keeps a short key=value line", () => {
  assert.equal(summarizeArgs({ command: "ls tmp" }), "command=ls tmp");
  assert.equal(summarizeArgs({ path: "a.ts", line: 3 }), "path=a.ts line=3");
  assert.equal(summarizeArgs("plain"), "plain");
  const long = summarizeArgs({ command: "x".repeat(200) });
  assert.equal(Array.from(long).length, 80);
  assert.equal(long.endsWith("…"), true);
});

test("a pending approval shows one card and y n a decide it", () => {
  const card = { toolCallId: "call-1", name: "bash", summary: "command=ls" };
  let state = reduceTui(emptyTui(), { type: "window", window: window({ approvals: [card] }) }).state;
  const painted = plain(state);
  assert.match(painted, /审批/);
  assert.match(painted, /bash {2}command=ls/);
  assert.match(painted, /y 允许 {2}n 拒绝 {2}a 本次会话允许/);

  const allow = reduceTui(state, { type: "key", key: { type: "char", value: "y" } });
  assert.deepEqual(allow.effect, { type: "approve", toolCallId: "call-1", decision: "allow" });
  assert.equal(allow.state.input, "");
  assert.equal(allow.state.deciding, true);
  assert.equal(reduceTui(allow.state, { type: "key", key: { type: "char", value: "n" } }).effect, null);
  assert.equal(reduceTui(allow.state, { type: "key", key: { type: "char", value: "n" } }).state.input, "");

  state = reduceTui(emptyTui(), { type: "window", window: window({ approvals: [card] }) }).state;
  const deny = reduceTui(state, { type: "key", key: { type: "char", value: "n" } });
  assert.deepEqual(deny.effect, { type: "approve", toolCallId: "call-1", decision: "deny" });

  state = reduceTui(emptyTui(), { type: "window", window: window({ approvals: [card] }) }).state;
  const session = reduceTui(state, { type: "key", key: { type: "char", value: "a" } });
  assert.deepEqual(session.effect, { type: "approve", toolCallId: "call-1", decision: "allow", session: true });

  const other = reduceTui(state, { type: "key", key: { type: "char", value: "z" } });
  assert.equal(other.effect, null);
  assert.equal(other.state.input, "z");
});

test("y n a type into a composer that already has text", () => {
  const card = { toolCallId: "call-1", name: "bash", summary: "command=ls" };
  const state = reduceTui(emptyTui(), { type: "window", window: window({ approvals: [card] }) }).state;
  const typed = reduceTui({ ...state, input: "x", cursor: 1 }, { type: "key", key: { type: "char", value: "a" } });
  assert.equal(typed.effect, null);
  assert.equal(typed.state.input, "xa");
  assert.equal(typed.state.deciding, false);
});

test("without a pending approval y is typed, and clearing the card releases the key", () => {
  const typed = reduceTui(emptyTui(), { type: "key", key: { type: "char", value: "y" } });
  assert.equal(typed.effect, null);
  assert.equal(typed.state.input, "y");
  assert.equal(plain(typed.state).includes("审批"), false);

  const waiting = reduceTui(emptyTui(), {
    type: "window",
    window: window({ approvals: [{ toolCallId: "call-1", name: "read", summary: "path=a.ts" }] }),
  }).state;
  const decided = reduceTui(waiting, { type: "key", key: { type: "char", value: "y" } }).state;
  const cleared = reduceTui(decided, { type: "window", window: window({ approvals: [] }) }).state;
  assert.equal(cleared.deciding, false);
  assert.equal(cleared.approvals.length, 0);
  const again = reduceTui(cleared, { type: "key", key: { type: "char", value: "y" } });
  assert.equal(again.state.input, "y");
  assert.equal(again.effect, null);
});
