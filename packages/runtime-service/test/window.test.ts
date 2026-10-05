import assert from "node:assert/strict";
import test from "node:test";
import { resolveLimits } from "@amazme/protocol";
import { ContractError, emptyActivity, parseLaneSnapshot, type EntryDto, type LaneSnapshotDto } from "@amazme/runtime-service";
import { fitHistory, fitWindow } from "../src/window.ts";

function entry(id: string, text: string): EntryDto {
  // Message content is opaque on the wire. The static type only names `role`,
  // so the extra fields are built first and then assigned.
  const message = { role: "user", content: text, timestamp: 1 };
  return {
    id,
    parentId: null,
    seq: 1,
    timestamp: 1,
    payload: { type: "message", message },
  };
}

function snapshot(entries: EntryDto[], pending: string | null = null): LaneSnapshotDto {
  // Content blocks are opaque past `type`. Build the block before assigning it.
  const pendingContent = pending === null ? null : [{ type: "text", text: pending }];
  return {
    version: 3,
    lane: "main",
    tipId: entries.at(-1)?.id ?? null,
    phase: pending === null ? null : "assistant_effect_pending",
    operationId: pending === null ? null : "op",
    lastOperationId: null,
    status: pending === null ? null : "open",
    entries,
    pendingResponse: pendingContent === null ? null : {
      operationId: "op",
      responseEntryId: "reply",
      content: pendingContent,
      stopReason: null,
      errorMessage: null,
    },
    tools: [],
    activity: emptyActivity(),
  };
}

test("a window keeps the newest entries and skips one that cannot fit alone", () => {
  const limits = resolveLimits({ maxFrameBytes: 2_048 });
  const fitted = fitWindow(snapshot([entry("old", "o".repeat(1_200)), entry("new", "n".repeat(1_200))]), limits, { kind: "response" });
  assert.ok(fitted);
  assert.deepEqual(fitted.entries.map((item) => item.id), ["new"]);
  assert.equal(fitted.omitted, 1);
  assert.equal(fitted.skipped, 0);

  const skipped = fitWindow(snapshot([entry("huge", "h".repeat(8_000))]), limits, { kind: "response" });
  assert.ok(skipped);
  assert.equal(skipped.entries.length, 0);
  assert.equal(skipped.skipped, 1);
  assert.equal(skipped.omitted, 0);
});

test("a pending reply that does not fit is marked omitted and the entries stay", () => {
  const limits = resolveLimits({ maxFrameBytes: 2_048 });
  const fitted = fitWindow(snapshot([entry("note", "short")], "p".repeat(8_000)), limits, { kind: "response" });
  assert.ok(fitted);
  assert.equal(fitted.pendingResponse, null);
  assert.equal(fitted.pendingOmitted, true);
  assert.deepEqual(fitted.entries.map((item) => item.id), ["note"]);
});

test("a tool activity may carry an output tail of at most 4000 code units", () => {
  const base = snapshot([]);
  const withTail = parseLaneSnapshot({
    ...base,
    phase: "tools",
    operationId: "op",
    status: "open",
    tools: [{ toolCallId: "call-1", name: "log", status: "running", outputTail: "x".repeat(4_000) }],
  });
  assert.equal(withTail.tools[0]?.outputTail?.length, 4_000);
  const fitted = fitWindow(withTail, resolveLimits(), { kind: "response" });
  assert.equal(fitted?.tools[0]?.outputTail?.length, 4_000);
  assert.throws(() => parseLaneSnapshot({
    ...base,
    tools: [{ toolCallId: "call-1", name: "log", status: "running", outputTail: "x".repeat(4_001) }],
  }), ContractError);
  assert.throws(() => parseLaneSnapshot({
    ...base,
    tools: [{ toolCallId: "call-1", name: "log", status: "running", extra: true }],
  }), ContractError);
  const omitted = parseLaneSnapshot({
    ...base,
    tools: [{ toolCallId: "call-1", name: "log", status: "planned" }],
  });
  assert.equal(omitted.tools[0]?.status, "planned");
  assert.equal("outputTail" in omitted.tools[0]!, false);
});

test("history keeps the side closest to the cursor when the page does not fit", () => {
  const limits = resolveLimits({ maxFrameBytes: 2_048 });
  const page = fitHistory([entry("a", "a".repeat(1_200)), entry("b", "b".repeat(1_200))], 4, limits);
  assert.ok(page);
  assert.deepEqual(page.entries.map((item) => item.id), ["b"]);
  assert.equal(page.older, 5);
  assert.equal(page.skipped, 0);
});
