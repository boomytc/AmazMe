import assert from "node:assert/strict";
import test from "node:test";
import type { UsageCost } from "@amazme/ai";
import type { LaneUsage } from "@amazme/durable";
import { emptyActivity, type CumulativeCostDto, type UsageCostDto } from "@amazme/runtime-service";
import { projectLaneUsage } from "../src/activity.ts";
import { finish, until, world } from "./support.ts";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const costMatches: Exact<UsageCost, UsageCostDto> = true;
const cumulativeWidens: UsageCost extends CumulativeCostDto ? true : never = true;
void [costMatches, cumulativeWidens];

const turnCost: UsageCostDto = { input: 0.1, cacheRead: null, cacheWrite: 0.2, output: 0.3, total: null };
const totalCost: CumulativeCostDto = { input: null, cacheRead: 1, cacheWrite: null, output: 2, total: null };

function usage(lastTurn: LaneUsage["lastTurn"], total: LaneUsage["total"]): Pick<LaneUsage, "lastTurn" | "total"> {
  return { lastTurn, total };
}

test("projectLaneUsage copies hitRate, cost, and reasoning and drops the other usage fields", () => {
  const projected = projectLaneUsage(usage(
    { input: 3, output: 10, cacheRead: 1, cacheWrite: 0, reasoning: 4, hitRate: 0.25, cost: turnCost },
    { input: 8, output: 10, cacheRead: null, cacheWrite: null, reasoning: null, hitRate: null, cost: totalCost },
  ));
  assert.equal(projected.lastTurn?.output, 10);
  assert.equal(projected.lastTurn?.reasoning, 4);
  assert.equal(projected.lastTurn?.hitRate, 0.25);
  assert.deepEqual(projected.lastTurn?.cost, turnCost);
  assert.equal(projected.total.reasoning, null);
  assert.equal(projected.total.hitRate, null);
  assert.deepEqual(projected.total.cost, totalCost);
  assert.equal("contextTokens" in projected, false);
  assert.equal("compactionThreshold" in projected, false);
});

test("a null last turn and a null cumulative cost stay null", () => {
  const projected = projectLaneUsage(usage(
    null,
    { input: 0, output: 0, cacheRead: null, cacheWrite: null, reasoning: null, hitRate: null, cost: null },
  ));
  assert.equal(projected.lastTurn, null);
  assert.equal(projected.total.hitRate, null);
  assert.equal(projected.total.cost, null);
});

test("the snapshot copies usage() and laneStatus() with the host clock", async () => {
  const env = world({ clock: { branch: "feature", sessionStartedAt: 1_700_000_000_000 } });
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    const admitted = await lane.accept({ kind: "prompt", text: "hi", operationId: "op-1" });
    const local = env.runtime().harness.lane("main");
    const snap = await lane.snapshot();
    const usageView = await local.usage();
    const status = await local.laneStatus();
    assert.equal(snap.activity.branch, "feature");
    assert.equal(snap.activity.sessionStartedAt, 1_700_000_000_000);
    assert.equal(snap.activity.turnStartedAt, status.turnStartedAt);
    assert.equal(snap.activity.turnStartedAt, admitted.startedAt);
    assert.equal(snap.activity.notBefore, status.notBefore);
    assert.equal(snap.activity.retryReason, status.retryReason);
    assert.equal(snap.activity.compacting, status.compacting);
    assert.equal(snap.activity.notBefore, null);
    assert.equal(snap.activity.retryReason, null);
    assert.equal(snap.activity.compacting, false);
    assert.deepEqual(snap.activity.usage.lastTurn, usageView.lastTurn);
    assert.equal(snap.activity.usage.total.input, usageView.total.input);
    assert.equal(snap.activity.usage.total.output, usageView.total.output);
    assert.equal(snap.activity.usage.total.cacheRead, usageView.total.cacheRead);
    assert.equal(snap.activity.usage.total.cacheWrite, usageView.total.cacheWrite);
    assert.equal(snap.activity.usage.total.hitRate, usageView.total.hitRate);
    assert.deepEqual(snap.activity.usage.total.cost, usageView.total.cost);
    assert.equal("pendingApprovals" in snap, false);
    assert.equal("contextTokens" in snap.activity.usage, false);
    const subscription = await lane.subscribe(() => undefined);
    assert.equal(subscription.initial.activity.turnStartedAt, status.turnStartedAt);
    assert.deepEqual(subscription.initial.activity.usage.total.cost, usageView.total.cost);
    await subscription.close();
  } finally {
    await env.close();
  }
});

test("a settled turn copies priced usage() and clears the open turn", async () => {
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
    const local = env.runtime().harness.lane("main");
    const usageView = await local.usage();
    const status = await local.laneStatus();
    const snap = await lane.snapshot();
    assert.ok(usageView.lastTurn);
    assert.ok(usageView.lastTurn.cost);
    // Zero-token faux reply: Durable's cacheHitRate is null. The snapshot must keep that null.
    assert.equal(usageView.lastTurn.hitRate, null);
    assert.deepEqual(snap.activity.usage.lastTurn, usageView.lastTurn);
    assert.equal(snap.activity.usage.total.hitRate, usageView.total.hitRate);
    assert.deepEqual(snap.activity.usage.total.cost, usageView.total.cost);
    assert.equal(snap.activity.turnStartedAt, status.turnStartedAt);
    assert.equal(snap.activity.turnStartedAt, null);
    assert.equal(snap.activity.notBefore, null);
    assert.equal(snap.activity.retryReason, null);
    assert.equal(snap.activity.compacting, false);
    assert.equal(snap.activity.usage.lastTurn.reasoning, usageView.lastTurn.reasoning);
    assert.equal(snap.activity.usage.total.reasoning, usageView.total.reasoning);
    assert.deepEqual(emptyActivity().usage.total.cost, null);
  } finally {
    await env.close();
  }
});
