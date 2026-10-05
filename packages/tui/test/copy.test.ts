import assert from "node:assert/strict";
import test from "node:test";
import { emptyTui, reduceTui, type TuiEntry, type TuiState, type TuiWindow } from "@amazme/tui";

function shown(entries: TuiEntry[], pendingText = ""): TuiState {
  const window: TuiWindow = {
    entries,
    pendingText,
    tools: [],
    busy: false,
    sessions: ["main"],
    active: "main",
  };
  return reduceTui(emptyTui(), { type: "window", window }).state;
}

test("ctrl-y copies the last assistant reply and leaves the composer alone", () => {
  const idle = reduceTui(emptyTui(), { type: "key", key: { type: "ctrl-y" } });
  assert.equal(idle.effect, null);
  assert.equal(idle.state.notice, "没有助手回复");

  const typed = reduceTui(emptyTui(), { type: "key", key: { type: "char", value: "a" } }).state;
  const draft = shown(
    [
      { id: "u", role: "user", text: "问" },
      { id: "a1", role: "assistant", text: "先说" },
      { id: "tool", role: "tool", text: "file body", title: "read" },
      { id: "a2", role: "assistant", text: "后说" },
      { id: "u2", role: "user", text: "再问" },
    ],
  );
  const kept = { ...draft, input: typed.input, cursor: typed.cursor };
  const copied = reduceTui(kept, { type: "key", key: { type: "ctrl-y" } });
  assert.deepEqual(copied.effect, { type: "copy", text: "后说" });
  assert.equal(copied.state.input, "a");

  const scrolling = reduceTui({ ...draft, focus: "scroll" }, { type: "key", key: { type: "ctrl-y" } });
  assert.deepEqual(scrolling.effect, { type: "copy", text: "后说" });

  const streaming = reduceTui(shown([{ id: "a1", role: "assistant", text: "先说" }], "还在写"), {
    type: "key",
    key: { type: "ctrl-y" },
  });
  assert.deepEqual(streaming.effect, { type: "copy", text: "还在写" });

  const emptyReply = reduceTui(shown([{ id: "a1", role: "assistant", text: "" }]), {
    type: "key",
    key: { type: "ctrl-y" },
  });
  assert.equal(emptyReply.effect, null);
  assert.equal(emptyReply.state.notice, "没有助手回复");

  const picking = reduceTui({
    ...draft,
    picker: { title: "模型", hint: "", query: "", index: 0, rows: [], kind: "model" },
  }, { type: "key", key: { type: "ctrl-y" } });
  assert.equal(picking.effect, null);
  assert.equal(picking.state.picker?.kind, "model");
});
