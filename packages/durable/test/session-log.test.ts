import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/testing";
import { AgentHarness, clipToolText, type Entry, type HarnessTool } from "@amazme/durable";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
import { MemoryStorage } from "@amazme/durable/storage/memory";

test("one log holds an independent fork, and aborting the child leaves the parent wait", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let parentReady: () => void = () => undefined;
  const parentEntered = new Promise<void>((resolve) => {
    parentReady = resolve;
  });
  let childReady: () => void = () => undefined;
  const childEntered = new Promise<void>((resolve) => {
    childReady = resolve;
  });
  let calls = 0;
  const provider = fauxProvider({
    respond: async (context, options) => {
      calls += 1;
      const child = context.messages.some((message) => message.role === "user" && message.content === "child-prompt");
      if (child) childReady();
      else parentReady();
      await gate;
      if (options.signal?.aborted) return fauxAssistant("stopped", { stopReason: "aborted", errorMessage: "cancelled" });
      return fauxAssistant(child ? "child-answer" : "parent-answer");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  try {
    const parent = runtime.lane("parent");
    const admitted = await parent.accept({ kind: "prompt", text: "parent-prompt" });
    assert.ok(admitted.ok);
    const driving = parent.drive(admitted.value.operationId);
    await parentEntered;
    const tip = (await parent.inspect()).tipId;
    const forked = await parent.fork("child", tip);
    assert.ok(forked.ok);
    assert.deepEqual(await runtime.conversations(), ["child", "parent"]);
    const child = runtime.lane("child");
    const childAdmitted = await child.accept({ kind: "prompt", text: "child-prompt" });
    assert.ok(childAdmitted.ok);
    const childDrive = child.drive(childAdmitted.value.operationId);
    await childEntered;
    const aborted = await child.requestAbort(childAdmitted.value.operationId);
    assert.equal(aborted.ok, true);
    release();
    const parentResult = await driving;
    const childResult = await childDrive;
    assert.ok(parentResult.ok && parentResult.value.kind === "settled");
    assert.equal(parentResult.value.result.status, "completed");
    assert.ok(childResult.ok && childResult.value.kind === "settled");
    assert.equal(childResult.value.result.status, "aborted");
    assert.equal(calls, 2);
    const parentText = (await parent.entries()).map(textOf);
    const childText = (await child.entries()).map(textOf);
    assert.ok(parentText.includes("parent-answer"));
    assert.equal(parentText.includes("child-prompt"), false);
    assert.ok(childText.includes("parent-prompt"));
    assert.ok(childText.includes("child-prompt"));
    assert.equal(childText.includes("parent-answer"), false);
    const missing = await parent.fork("other", "missing-entry");
    assert.equal(missing.ok, false);
  } finally {
    release();
    runtime.close();
  }
});

test("tool-result trimming and compaction change only the next request", async () => {
  const full = "A".repeat(80);
  const requests: string[][] = [];
  const tool: HarnessTool = {
    name: "work",
    description: "work",
    parameters: { type: "object" },
    replay: "never",
    async execute() {
      return { content: [{ type: "text", text: full }] };
    },
  };
  const script = [
    { ...fauxAssistant("call"), content: [{ type: "text" as const, text: "call" }, fauxToolCall("work", {})], stopReason: "toolUse" as const },
    fauxAssistant("after"),
  ];
  let index = 0;
  const provider = fauxProvider({
    respond: (context) => {
      requests.push(context.messages.map((message) => {
        if (message.role === "toolResult") {
          return `tool:${message.content.filter((block) => block.type === "text").map((block) => block.text).join("")}`;
        }
        if (message.role === "user" && typeof message.content === "string") return `user:${message.content}`;
        return message.role;
      }));
      const message = script[index] ?? fauxAssistant("summary");
      index += 1;
      return message;
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const runtime = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [tool],
    toolResultLimit: 24,
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  try {
    const result = await runtime.lane().prompt("go");
    assert.equal(result.status, "completed");
    assert.equal(requests[1]?.find((line) => line.startsWith("tool:")), `tool:${clipToolText(full, 24)}`);
    assert.deepEqual(storedToolText(await runtime.lane().entries()), [full]);
    const compacted = await runtime.lane().accept({ kind: "compaction" });
    assert.ok(compacted.ok);
    const outcome = await runtime.lane().drive(compacted.value.operationId);
    assert.ok(outcome.ok && outcome.value.kind === "settled");
    assert.equal(outcome.value.result.status, "completed");
    assert.deepEqual(storedToolText(await runtime.lane().entries()), [full]);
    const continued = await runtime.lane().prompt("next");
    assert.equal(continued.status, "completed");
    const last = requests.at(-1) ?? [];
    assert.equal(last.some((line) => line.startsWith("user:summary")), true);
    assert.equal(last.some((line) => line.includes(full)), false);
  } finally {
    runtime.close();
  }
});

test("a pre-v1 session file is refused and left unchanged", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-prev1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "runtime.jsonl");
  const storage = new JsonlStorage(file);
  await storage.commit([{
    type: "entry",
    id: "old",
    parentId: null,
    timestamp: 1,
    payload: { type: "message", message: { role: "user", content: "legacy", timestamp: 1 } },
  }]);
  const models = createModels();
  models.setProvider(fauxProvider());
  const runtime = new AgentHarness(storage, { models, model: { provider: "faux", modelId: "faux-1" } });
  await assert.rejects(runtime.lane().accept({ kind: "prompt", text: "go" }), /pre-v1 session file/);
  const kept = await storage.read((view) => view.entry("old")?.payload);
  assert.equal(kept?.type === "message" && kept.message.role === "user" ? kept.message.content : "", "legacy");
  assert.equal(await storage.read((view) => view.get(sessionFormat()) ), undefined);
  runtime.close();
});

function storedToolText(entries: readonly Entry[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.payload.type !== "message" || entry.payload.message.role !== "toolResult") return [];
    return entry.payload.message.content.filter((block) => block.type === "text").map((block) => block.text);
  });
}

function textOf(entry: { payload: { type: string; summary?: string; message?: { role: string; content: unknown } } }): string {
  if (entry.payload.type === "compaction") return entry.payload.summary ?? "";
  const message = entry.payload.message;
  if (!message) return "";
  return message.role === "assistant" || message.role === "user" ? messageText(message as never) : "";
}

function sessionFormat() {
  return { kind: "value" as const, namespace: "amazme.session", key: "format" };
}
