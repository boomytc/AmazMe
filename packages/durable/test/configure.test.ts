import assert from "node:assert/strict";
import test from "node:test";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider } from "@amazme/ai/providers/faux";
import { AgentHarness, type AgentLane } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";

test("configure changes an idle lane and leaves busy, unknown, and unsupported choices unchanged", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let hold = false;
  const faux = fauxProvider({
    respond: async (_context, _options, _state, model) => {
      if (hold) {
        entered();
        await gate;
      }
      return fauxAssistant(`faux:${model.id}`);
    },
  });
  const other = fauxProvider({
    id: "other",
    modelId: "other-1",
    respond: (_context, _options, _state, model) => fauxAssistant(`other:${model.id}`),
  });
  const models = createModels();
  models.setProvider(faux);
  models.setProvider(other);
  const storage = new MemoryStorage();
  const runtime = new AgentHarness(storage, {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  try {
    const main = runtime.lane("main");
    const notes = runtime.lane("notes");
    await notes.prompt("notes");
    assert.equal(await said(notes), "faux:faux-1");
    hold = true;
    const admitted = await main.accept({ kind: "prompt", text: "wait" });
    assert.ok(admitted.ok);
    const driving = main.drive(admitted.value.operationId);
    await ready;
    const denied = await main.configure({ provider: "other", modelId: "other-1" });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "lane_busy");
    const during = await main.configure();
    assert.ok(during.ok);
    if (during.ok) assert.equal(during.value.modelId, "faux-1");
    release();
    hold = false;
    const waited = await driving;
    assert.ok(waited.ok && waited.value.kind === "settled");
    const unknown = await main.configure({ provider: "missing", modelId: "nope" });
    assert.equal(unknown.ok, false);
    const partial = await main.configure({ provider: "other" });
    assert.equal(partial.ok, false);
    const unsupported = await main.configure({ thinkingLevel: "high" });
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) assert.match(unsupported.error.message, /not supported/);
    const still = await main.configure();
    assert.ok(still.ok && still.value.provider === "faux" && still.value.thinkingLevel === "off");
    const switched = await main.configure({ provider: "other", modelId: "other-1" });
    assert.ok(switched.ok);
    if (switched.ok) assert.deepEqual(switched.value.thinkingLevels, ["off"]);
    await main.prompt("main");
    assert.equal(await said(main), "other:other-1");
    await notes.prompt("again");
    assert.equal(await said(notes), "faux:faux-1");
    const later = runtime.lane("later");
    await later.prompt("new");
    assert.equal(await said(later), "other:other-1");
    const notesTip = (await notes.inspect()).tipId;
    const notesFork = await notes.fork("notes-child", notesTip);
    assert.ok(notesFork.ok);
    const notesChild = runtime.lane("notes-child");
    await notesChild.prompt("from-notes");
    assert.equal(await said(notesChild), "faux:faux-1");
    const tip = (await main.inspect()).tipId;
    const forked = await main.fork("child", tip);
    assert.ok(forked.ok);
    const child = runtime.lane("child");
    await child.prompt("child");
    assert.equal(await said(child), "other:other-1");
    const duplicate = await main.fork("child", tip);
    assert.equal(duplicate.ok, false);
  } finally {
    release();
    await runtime.close();
  }
  const reopened = new AgentHarness(storage, {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  try {
    const kept = await reopened.lane("main").configure();
    assert.ok(kept.ok);
    if (kept.ok) assert.equal(`${kept.value.provider}/${kept.value.modelId}`, "other/other-1");
    await reopened.lane("main").prompt("reopen");
    assert.equal(await said(reopened.lane("main")), "other:other-1");
    await reopened.lane("notes").prompt("kept");
    assert.equal(await said(reopened.lane("notes")), "faux:faux-1");
  } finally {
    await reopened.close();
  }
});

async function said(lane: AgentLane): Promise<string> {
  const entries = await lane.entries();
  const assistant = entries.filter((entry) => entry.payload.type === "message" && entry.payload.message.role === "assistant").at(-1);
  if (!assistant || assistant.payload.type !== "message" || assistant.payload.message.role !== "assistant") return "";
  return messageText(assistant.payload.message);
}
