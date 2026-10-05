import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { emptyActivity, type ActivityDto } from "@amazme/runtime-service";
import { emptyTui, reduceTui, renderTui, type TuiWindow } from "@amazme/tui";

const SGR = /\u001b\[[0-9;]*m/g;

function window(activity: ActivityDto, busy = false): TuiWindow {
  return {
    entries: [],
    pendingText: "",
    tools: [],
    busy,
    sessions: ["main"],
    active: "main",
    activity,
  };
}

function paint(activity: ActivityDto, now?: number): string {
  const state = reduceTui(emptyTui(), { type: "window", window: window(activity) }).state;
  return renderTui(state, 120, 24, now).replace(SGR, "");
}

function activity(patch: Partial<ActivityDto> = {}): ActivityDto {
  return { ...emptyActivity(), ...patch, usage: patch.usage ?? emptyActivity().usage };
}

test("an empty activity adds nothing to the footer", () => {
  const frame = paint(emptyActivity(), 10_000);
  assert.match(frame, /main {2}空闲/);
  assert.equal(frame.includes("命中"), false);
  assert.equal(frame.includes("$"), false);
  assert.equal(frame.includes("重试"), false);
  assert.equal(frame.includes("压缩"), false);
  assert.equal(frame.includes("会话"), false);
  assert.equal(frame.includes("本轮"), false);
});

test("the footer shows branch, elapsed time, retry, hit rate, and priced totals from the snapshot", () => {
  const frame = paint(activity({
    branch: "feature",
    sessionStartedAt: 0,
    turnStartedAt: 60_000,
    notBefore: 130_000,
    retryReason: "overloaded",
    usage: {
      lastTurn: {
        input: 3,
        output: 10,
        cacheRead: 1,
        cacheWrite: 0,
        hitRate: 0.25,
        cost: { input: 0.1, cacheRead: null, cacheWrite: 0.2, output: 0.3, total: 1.5 },
      },
      total: {
        input: 8,
        output: 10,
        cacheRead: null,
        cacheWrite: null,
        hitRate: 0.5,
        cost: { input: 0.2, cacheRead: 0, cacheWrite: 0.2, output: 0.4, total: 0 },
      },
    },
  }), 125_000);
  assert.match(frame, /feature/);
  assert.match(frame, /会话 2:05/);
  assert.match(frame, /本轮 1:05/);
  assert.match(frame, /重试 overloaded 5s/);
  assert.match(frame, /本轮命中 0\.25/);
  assert.match(frame, /累计命中 0\.5/);
  assert.equal(frame.includes("%"), false);
  assert.match(frame, /本轮 \$1\.5/);
  assert.match(frame, /累计 \$0/);
});

test("a null price hides the amount and a null retry reason hides the countdown", () => {
  const frame = paint(activity({
    notBefore: 130_000,
    retryReason: null,
    usage: {
      lastTurn: {
        input: 3,
        output: 10,
        cacheRead: 1,
        cacheWrite: 0,
        hitRate: 0,
        cost: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, total: null },
      },
      total: {
        input: 3,
        output: 10,
        cacheRead: null,
        cacheWrite: null,
        hitRate: null,
        cost: null,
      },
    },
  }), 125_000);
  assert.match(frame, /本轮命中 0/);
  assert.equal(frame.includes("累计命中"), false);
  assert.equal(frame.includes("$"), false);
  assert.equal(frame.includes("重试"), false);
});

test("compacting becomes done and clears on the next turn", () => {
  let state = reduceTui(emptyTui(), {
    type: "window",
    window: window(activity({ compacting: true, turnStartedAt: 1 })),
  }).state;
  assert.match(renderTui(state).replace(SGR, ""), /压缩中/);
  assert.equal(renderTui(state).includes("压缩完成"), false);
  state = reduceTui(state, {
    type: "window",
    window: window(activity({ compacting: false, turnStartedAt: 1 })),
  }).state;
  const done = renderTui(state).replace(SGR, "");
  assert.match(done, /压缩完成/);
  assert.equal(done.includes("压缩中"), false);
  state = reduceTui(state, {
    type: "window",
    window: window(activity({ compacting: false, turnStartedAt: 2 })),
  }).state;
  const next = renderTui(state).replace(SGR, "");
  assert.equal(next.includes("压缩"), false);
});

test("the footer does not price tokens, run git, or read the clock itself", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const files = readdirSync(root).filter((name) => name.endsWith(".ts"));
  const sources = new Map(files.map((name) => [name, readFileSync(join(root, name), "utf8")]));
  const status = sources.get("status.ts") ?? "";
  const reduce = sources.get("reduce.ts") ?? "";
  for (const source of [status, reduce]) {
    assert.equal(source.includes("Date.now"), false);
    assert.equal(source.includes("setInterval"), false);
    assert.equal(source.includes("usageCost"), false);
    assert.equal(source.includes("cacheRead"), false);
    assert.equal(source.includes("* 100"), false);
    assert.equal(source.includes("rev-parse"), false);
  }
  const joined = [...sources.values()].join("\n");
  assert.equal(joined.includes("child_process"), false);
  assert.equal(joined.includes("rev-parse"), false);
  assert.equal(sources.get("present.ts")?.includes("setInterval"), false);
});
