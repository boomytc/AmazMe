import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseLaneSnapshot } from "@amazme/runtime-service";
import { decodeKeys, emptyTui, reduceTui, renderTui, windowFrom, type TuiEntry, type TuiWindow } from "@amazme/tui";
import { parseScreenScript, playScreen, SCREEN_COLUMNS, SCREEN_ROWS } from "./screen.ts";

const SGR = /\u001b\[[0-9;]*m/g;

function window(partial: Partial<TuiWindow> = {}): TuiWindow {
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

function plain(state: ReturnType<typeof emptyTui>, columns = SCREEN_COLUMNS, rows = SCREEN_ROWS, now?: number): string {
  return renderTui(state, columns, rows, now).replace(SGR, "");
}

function readScript(name: string): ReturnType<typeof parseScreenScript> {
  return parseScreenScript(JSON.parse(readFileSync(new URL(`./screens/${name}.json`, import.meta.url), "utf8")));
}

test("ctrl-o expands only the latest card and the next press folds it", () => {
  assert.deepEqual(decodeKeys("\u000f").keys, [{ type: "ctrl-o" }]);
  const folded = playScreen(readScript("tool-ok"));
  const opened = playScreen(readScript("tool-expand"));
  assert.equal(folded.screen.split("\n").length, SCREEN_ROWS);
  assert.match(folded.screen, /read {2}成功 {2}1\.5s/);
  assert.match(folded.screen, /path=README.md/);
  assert.equal(folded.screen.includes("alpha"), false);
  assert.match(opened.screen, /alpha/);
  assert.match(opened.screen, /delta/);
  assert.match(opened.screen, /read {2}成功 {2}1\.5s/);
  assert.notEqual(opened.screen, folded.screen);

  const again = readScript("tool-ok");
  again.steps.push({ type: "keys", input: "\u000f" }, { type: "keys", input: "\u000f" });
  assert.equal(playScreen(again).screen, folded.screen);
  assert.equal(playScreen(readScript("tool-ok")).screen, folded.screen);
});

test("a fresh window still draws the settled card folded", () => {
  const script = readScript("tool-ok");
  const first = playScreen(script);
  const snapshotStep = script.steps[0];
  if (!snapshotStep || snapshotStep.type !== "snapshot") throw new Error("missing snapshot");
  const snapshot = parseLaneSnapshot(snapshotStep.snapshot);
  let state = reduceTui(emptyTui(), { type: "window", window: windowFrom(snapshot, ["main"], "main") }).state;
  state = reduceTui(state, { type: "key", key: { type: "ctrl-o" } }).state;
  assert.match(plain(state), /alpha/);
  const reopened = reduceTui(emptyTui(), { type: "window", window: windowFrom(snapshot, ["main"], "main") }).state;
  assert.equal(reopened.expandedToolId, null);
  assert.equal(plain(reopened), first.screen);
  assert.equal(plain(reopened).includes("alpha"), false);
  assert.match(plain(reopened), /成功/);
});

test("expanded detail stops at 20 lines and an older card stays folded", () => {
  const body = Array.from({ length: 25 }, (_, index) => `line-${index + 1}`).join("\n");
  const older = "older-body";
  const entries: TuiEntry[] = [
    {
      id: "a",
      role: "assistant",
      text: "",
      timestamp: 1_000,
      calls: [
        { id: "call-1", name: "read", arguments: { path: "old.txt" } },
        { id: "call-2", name: "read", arguments: { path: "new.txt" } },
      ],
    },
    { id: "t1", role: "tool", text: older, title: "read", toolCallId: "call-1", isError: false, timestamp: 1_500 },
    { id: "t2", role: "tool", text: body, title: "read", toolCallId: "call-2", isError: false, timestamp: 2_500 },
  ];
  let state = reduceTui(emptyTui(), { type: "window", window: window({ entries }) }).state;
  state = reduceTui(state, { type: "key", key: { type: "ctrl-o" } }).state;
  const opened = plain(state, 60, 48);
  const detail = opened.split("\n").filter((line) => line.startsWith("│ line-"));
  assert.equal(detail.length, 20);
  assert.equal(detail[0], "│ line-1");
  assert.equal(detail[19], "│ line-20");
  assert.equal(opened.includes("line-21"), false);
  assert.equal(opened.includes(older), false);
  assert.match(opened, /path=new.txt/);
  assert.match(opened, /1\.5s/);
  const closed = reduceTui(state, { type: "key", key: { type: "ctrl-o" } }).state;
  const folded = plain(closed);
  assert.equal(folded.includes("line-1"), false);
  assert.match(folded, /path=old.txt/);
  assert.match(folded, /path=new.txt/);
  assert.equal(closed.input, "");
});

test("a running card keeps the three-line tail and can show elapsed time", () => {
  const tail = ["dropped-1", "dropped-2", "line-28", "line-29", "line-30"].join("\n");
  const state = reduceTui(emptyTui(), {
    type: "window",
    window: window({
      busy: true,
      entries: [{
        id: "a",
        role: "assistant",
        text: "",
        timestamp: 1_000,
        calls: [{ id: "call-1", name: "bash", arguments: { command: "ls" } }],
      }],
      tools: [{ toolCallId: "call-1", name: "bash", status: "running", outputTail: `${tail}\n` }],
    }),
  }).state;
  const frame = plain(state, 60, 16, 5_000);
  assert.match(frame, /bash {2}运行中 {2}4s/);
  assert.match(frame, /command=ls/);
  assert.match(frame, /line-28/);
  assert.match(frame, /line-30/);
  assert.equal(frame.includes("dropped-1"), false);
  const opened = plain(reduceTui(state, { type: "key", key: { type: "ctrl-o" } }).state, 60, 24, 5_000);
  assert.match(opened, /dropped-1/);
  assert.match(opened, /line-30/);
});

test("waiting for approval is a card status and does not steal y", () => {
  const card = { toolCallId: "call-1", name: "bash", summary: "command=ls" };
  const state = reduceTui(emptyTui(), {
    type: "window",
    window: window({
      busy: true,
      approvals: [card],
      entries: [{
        id: "a",
        role: "assistant",
        text: "",
        timestamp: 1_000,
        calls: [{ id: "call-1", name: "bash", arguments: { command: "ls" } }],
      }],
      tools: [{ toolCallId: "call-1", name: "bash", status: "planned" }],
    }),
  }).state;
  const frame = plain(state, 80, 24);
  assert.match(frame, /bash {2}等审批/);
  assert.match(frame, /command=ls/);
  assert.match(frame, /审批/);
  assert.match(frame, /y 允许/);
  const allow = reduceTui(state, { type: "key", key: { type: "char", value: "y" } });
  assert.equal(allow.effect?.type, "approve");
  assert.equal(allow.state.input, "");
});

test("failure and denial cards keep their status words", () => {
  const failed = playScreen(readScript("tool-fail")).screen;
  const denied = playScreen(readScript("tool-deny")).screen;
  assert.match(failed, /read {2}失败 {2}2s/);
  assert.match(failed, /path=missing.txt/);
  assert.equal(failed.includes("找不到文件"), false);
  assert.match(denied, /bash {2}被拒 {2}200ms/);
  assert.match(denied, /command=rm secret/);
  assert.equal(denied.includes("Tool call denied"), false);
  const opened = readScript("tool-deny");
  opened.steps.push({ type: "keys", input: "\u000f" });
  assert.match(playScreen(opened).screen, /Tool call denied/);
});
