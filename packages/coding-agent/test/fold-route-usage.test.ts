import assert from "node:assert/strict";
import test from "node:test";
import { foldRouteUsage } from "../src/host-router.ts";
import type { SessionRouteEntry } from "../src/session.ts";

const blank = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  total: null,
};

test("foldRouteUsage keeps an all-null cost when the lane total is null", () => {
  const usage = {
    total: { input: 10, output: 2, cost: { ...blank } },
  };
  const priced: SessionRouteEntry = {
    type: "route",
    timestamp: "2026-10-05T00:00:00.000Z",
    provider: "typesafe",
    modelId: "jev-latest",
    lane: "main",
    usage: { input: 100, output: 1, totalTokens: 101, cost: { input: 0.01, output: 0.02, total: 0.03 } },
  };
  const folded = foldRouteUsage(usage, priced);
  assert.deepEqual(folded.total.cost, blank);
  assert.equal(folded.total.input, 110);
  assert.equal(folded.total.output, 3);
  assert.deepEqual(usage.total.cost, blank);

  const unpriced: SessionRouteEntry = {
    ...priced,
    usage: { input: 4, output: 0, totalTokens: 4, cost: null },
  };
  const kept = foldRouteUsage(usage, unpriced);
  assert.deepEqual(kept.total.cost, blank);

  const known = foldRouteUsage(
    { total: { input: 1, output: 1, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } } },
    unpriced,
  );
  assert.equal(known.total.cost, null);
  assert.equal(known.total.input, 5);
});
