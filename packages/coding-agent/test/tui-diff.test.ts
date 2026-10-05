import assert from "node:assert/strict";
import test from "node:test";
import { decodeKeys, emptyTui, reduceTui, renderTui, slashMatches, treePickerRows, writeScreen, type Picker, type TuiState } from "@amazme/tui";

test("a growing reply is not a full-screen clear, and the composer, pickers, and colors stay distinct", () => {
  const writes: string[] = [];
  let previous: string | null = null;
  const paint = (state: TuiState): string => {
    const next = renderTui(state, 80, 24);
    previous = writeScreen((chunk) => writes.push(chunk), previous, next);
    return next;
  };
  let state: TuiState = {
    ...emptyTui(),
    directory: "~/workspace/AmazMe",
    provider: "faux",
    modelId: "faux-1",
    thinking: "off",
    entries: [{ id: "user-1", role: "user", text: "keep-me" }],
  };
  const first = paint(state);
  assert.match(first, /keep-me/);
  state = reduceTui(state, {
    type: "window",
    window: { ...state, pendingText: "hel" },
  }).state;
  const second = paint(state);
  const update = writes[1] ?? "";
  assert.match(second, /hel/);
  assert.match(second, /keep-me/);
  assert.equal(update.includes("\x1b[2J"), false);
  assert.equal(update.includes("\x1b[J"), false);
  assert.match(update, /hel/);

  let composer = press(emptyTui(), "one\x1b\rtwo");
  const end = composer.cursor;
  composer = press(composer, "\x1b[D\x1b[D");
  assert.equal(composer.input, "one\ntwo");
  assert.equal(composer.cursor < end, true);
  const moved = composer.cursor;
  const frame = renderTui(composer, 80, 24);
  assert.match(frame, /one/);
  assert.match(frame, /wo/);
  composer = press(composer, "\x1b[C");
  assert.equal(composer.input, "one\ntwo");
  assert.equal(composer.cursor, moved + 1);
  const submitted = reduceTui(composer, { type: "key", key: { type: "enter" } });
  assert.deepEqual(submitted.effect, { type: "submit", text: "one\ntwo" });

  assert.ok(slashMatches("/").length > 8);
  const slash = commandLines(renderTui(press(emptyTui(), "/"), 100, 40));
  assert.ok(slash.length > 0);
  assert.ok(slash.length <= 8);
  for (const name of ["login", "model", "thinking", "resume", "tree"]) {
    const matches = slashMatches(`/${name}`).map((item) => item.name);
    assert.ok(matches.includes(name));
    const lines = commandLines(renderTui(press(emptyTui(), `/${name}`), 100, 40));
    assert.ok(lines.length > 0);
    assert.ok(lines.length <= 8);
    assert.ok(lines.some((line) => line.includes(`/${name}`)));
  }
  assert.deepEqual(bare("/login").effect, { type: "slash", command: { type: "login" } });
  assert.deepEqual(bare("/model").effect, { type: "slash", command: { type: "model" } });
  assert.deepEqual(bare("/thinking").effect, { type: "slash", command: { type: "thinking" } });
  assert.deepEqual(bare("/resume").effect, { type: "slash", command: { type: "resume" } });
  assert.deepEqual(bare("/tree").effect, { type: "slash", command: { type: "tree" } });

  const login = filterPicker({
    title: "Select provider to configure:",
    hint: "filter",
    query: "",
    index: 0,
    kind: "login-provider",
    rows: [
      { id: "anthropic", label: "Anthropic", detail: "✓ stored", tone: "ok" },
      { id: "openai", label: "OpenAI", detail: "• not configured", tone: "muted" },
    ],
  }, "open");
  assert.match(login, /OpenAI/);
  assert.match(login, /not configured/);
  assert.equal(login.includes("Anthropic"), false);

  const model = filterPicker({
    title: "Select model:",
    hint: "filter",
    query: "",
    index: 0,
    kind: "model",
    rows: [
      { id: "faux\tfaux-1", label: "faux/faux-1", detail: "current", tone: "ok" },
      { id: "other\tother-1", label: "other/other-1", detail: "", tone: "muted" },
    ],
  }, "faux");
  assert.match(model, /faux\/faux-1/);
  assert.equal(model.includes("other/other-1"), false);

  const thinking = filterPicker({
    title: "Select thinking level:",
    hint: "filter",
    query: "",
    index: 0,
    kind: "thinking",
    rows: [
      { id: "off", label: "off", detail: "current", tone: "ok" },
      { id: "high", label: "high", detail: "", tone: "muted" },
    ],
  }, "off");
  assert.match(thinking, /> off/);
  assert.equal(thinking.includes("high"), false);

  const resume = filterPicker({
    title: "Select session:",
    hint: "filter",
    query: "",
    index: 0,
    kind: "resume",
    rows: [
      { id: "main", label: "main", detail: "current", tone: "ok" },
      { id: "notes", label: "notes", detail: "", tone: "muted" },
    ],
  }, "main");
  assert.match(resume, /main/);
  assert.equal(resume.includes("notes"), false);

  const treeRows = treePickerRows([
    { id: "user-1", parentId: null, seq: 0, timestamp: 1, payload: { type: "message", message: { role: "user", content: "left-branch", timestamp: 1 } } },
    { id: "assistant-1", parentId: "user-1", seq: 1, timestamp: 2, payload: { type: "message", message: { role: "assistant", content: [{ type: "text", text: "faux-reply" }], timestamp: 2 } } },
  ]);
  assert.ok(treeRows.every((row) => row.label.length > 0));
  assert.match(treeRows.map((row) => row.label).join("\n"), /faux-reply/);
  const tree = filterPicker({
    title: "Select entry:",
    hint: "filter",
    query: "",
    index: 0,
    kind: "tree",
    rows: treeRows,
  }, "faux");
  assert.match(tree, /faux-reply/);
  assert.equal(tree.includes("left-branch"), false);

  const secretState = press({
    ...emptyTui(),
    picker: { title: "API key", hint: "mask", query: "", index: 0, kind: "api-key", rows: [], subject: "anthropic", secret: true },
  }, "sk-secret");
  const secret = paint(secretState);
  assert.equal(secret.includes("sk-secret"), false);
  assert.match(secret, /•••••••••/);
  assert.equal((writes.at(-1) ?? "").includes("sk-secret"), false);
  const saved = reduceTui(secretState, { type: "key", key: { type: "enter" } });
  assert.deepEqual(saved.effect, { type: "pick", kind: "api-key", id: "anthropic", secret: "sk-secret" });

  const roles = renderTui({
    ...emptyTui(),
    directory: "~/workspace/AmazMe",
    provider: "faux",
    modelId: "faux-1",
    thinking: "off",
    entries: [
      { id: "u", role: "user", text: "you" },
      { id: "a", role: "assistant", text: "use `code`" },
    ],
  }, 80, 24);
  const lines = roles.split("\n");
  assert.match(lines.find((line) => line.includes("you")) ?? "", /\x1b\[38;5;180m/);
  assert.match(lines.find((line) => line.includes("AmazMe")) ?? "", /\x1b\[38;5;147m/);
  assert.match(lines.find((line) => line.includes("faux/faux-1")) ?? "", /\x1b\[38;5;245m/);
  assert.match(lines.find((line) => line.includes("code")) ?? "", /\x1b\[38;5;109m/);
});

function press(state: TuiState, input: string): TuiState {
  let next = state;
  for (const key of decodeKeys(input).keys) next = reduceTui(next, { type: "key", key }).state;
  return next;
}

function bare(command: string): { effect: ReturnType<typeof reduceTui>["effect"] } {
  return reduceTui(press(emptyTui(), command), { type: "key", key: { type: "enter" } });
}

function filterPicker(picker: Picker, query: string): string {
  return renderTui(press({ ...emptyTui(), picker }, query), 80, 30);
}

function commandLines(frame: string): string[] {
  return frame.split("\n").filter((line) => /\/[a-z]/.test(line) && line.includes("  "));
}
