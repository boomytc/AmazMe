import assert from "node:assert/strict";
import test from "node:test";
import type { UsageCost } from "@amazme/ai";
import { emptyActivity, type CumulativeCostDto, type UsageCostDto } from "@amazme/runtime-service";
import { projectLaneUsage, readLaneStatus } from "../src/activity.ts";
import { finish, until, world } from "./support.ts";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const costMatches: Exact<UsageCost, UsageCostDto> = true;
const cumulativeWidens: UsageCost extends CumulativeCostDto ? true : never = true;
void [costMatches, cumulativeWidens];

const turnCost: UsageCostDto = { input: 0.1, cacheRead: null, cacheWrite: 0.2, output: 0.3, total: null };
const totalCost: CumulativeCostDto = { input: null, cacheRead: 1, cacheWrite: null, output: 2, total: null };

test("projectLaneUsage copies hit rate, cost, and reasoning without adding reasoning to output", () => {
  const projected = projectLaneUsage({
    lastTurn: {
      input: 3,
      output: 10,
      cacheRead: 1,
      cacheWrite: 0,
      reasoning: 4,
      hitRate: 0.25,
      cost: turnCost,
    },
    total: {
      input: 8,
      output: 10,
      cacheRead: null,
      cacheWrite: null,
      reasoning: 4,
      hitRate: 0.5,
      cost: totalCost,
    },
  });
  assert.equal(projected.lastTurn?.output, 10);
  assert.equal(projected.lastTurn?.reasoning, 4);
  assert.equal(projected.lastTurn?.hitRate, 0.25);
  assert.deepEqual(projected.lastTurn?.cost, turnCost);
  assert.equal(projected.total.output, 10);
  assert.equal(projected.total.hitRate, 0.5);
  assert.deepEqual(projected.total.cost, totalCost);
  assert.equal("contextTokens" in projected, false);
});

test("missing hit rate and cost stay null", () => {
  const projected = projectLaneUsage({
    lastTurn: { input: 1, output: 2, cacheRead: null, cacheWrite: null },
    total: { input: 1, output: 2, cacheRead: null, cacheWrite: null },
  });
  assert.equal(projected.lastTurn?.hitRate, null);
  assert.equal(projected.lastTurn?.cost, null);
  assert.equal(projected.lastTurn?.reasoning, undefined);
  assert.equal(projected.total.hitRate, null);
  assert.equal(projected.total.cost, null);
  assert.deepEqual(projectLaneUsage({ lastTurn: null, total: { input: 0, output: 0, cacheRead: null, cacheWrite: null } }).lastTurn, null);
});

test("readLaneStatus copies laneStatus() and stays empty when the method is absent", async () => {
  assert.deepEqual(await readLaneStatus({}), { notBefore: null, retryReason: null, compacting: false });
  const status = { notBefore: 5_000, retryReason: "overloaded", compacting: true };
  assert.deepEqual(await readLaneStatus({ laneStatus: async () => status }), status);
});

test("the snapshot copies the host clock and leaves U2 usage and lane status empty", async () => {
  const env = world({ clock: { branch: "feature", sessionStartedAt: 1_700_000_000_000 } });
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    const admitted = await lane.accept({ kind: "prompt", text: "hi", operationId: "op-1" });
    const snap = await lane.snapshot();
    const usage = await env.runtime().harness.lane("main").usage();
    assert.equal(snap.activity.branch, "feature");
    assert.equal(snap.activity.sessionStartedAt, 1_700_000_000_000);
    assert.equal(snap.activity.turnStartedAt, admitted.startedAt);
    assert.equal(snap.activity.notBefore, null);
    assert.equal(snap.activity.retryReason, null);
    assert.equal(snap.activity.compacting, false);
    assert.equal(snap.activity.usage.lastTurn, null);
    assert.equal(snap.activity.usage.total.input, usage.total.input);
    assert.equal(snap.activity.usage.total.output, usage.total.output);
    assert.equal(snap.activity.usage.total.hitRate, null);
    assert.equal(snap.activity.usage.total.cost, null);
    assert.equal("pendingApprovals" in snap, false);
    const subscription = await lane.subscribe(() => undefined);
    assert.equal(subscription.initial.activity.branch, "feature");
    assert.equal(subscription.initial.activity.compacting, false);
    assert.equal(subscription.initial.activity.usage.total.hitRate, null);
    await subscription.close();
  } finally {
    await env.close();
  }
});

test("a settled turn keeps usage() charges null when Durable has not priced them", async () => {
  const env = world({ clock: { branch: "feature", sessionStartedAt: 10 } });
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    await lane.accept({ kind: "prompt", text: "hi", operationId: "op" });
    const driving = lane.drive("op");
    await until(() => env.runtime().streams.length === 1);
    finish(env.runtime().streams[0]!, "ok");
    await driving;
    const usage = await env.runtime().harness.lane("main").usage();
    const snap = await lane.snapshot();
    const priced = usage.lastTurn as { hitRate?: number | null; cost?: unknown; reasoning?: number } | null;
    assert.equal(snap.activity.usage.lastTurn?.input, usage.lastTurn?.input);
    assert.equal(snap.activity.usage.lastTurn?.output, usage.lastTurn?.output);
    assert.equal(snap.activity.usage.lastTurn?.hitRate ?? null, priced?.hitRate ?? null);
    assert.deepEqual(snap.activity.usage.lastTurn?.cost ?? null, priced?.cost ?? null);
    assert.equal(snap.activity.usage.total.input, usage.total.input);
    assert.equal(snap.activity.usage.total.output, usage.total.output);
    assert.equal(snap.activity.usage.total.cost, (usage.total as { cost?: unknown }).cost ?? null);
    assert.equal(snap.activity.turnStartedAt, null);
    assert.equal(snap.activity.compacting, false);
    assert.deepEqual(emptyActivity().usage.total.cost, null);
  } finally {
    await env.close();
  }
});
