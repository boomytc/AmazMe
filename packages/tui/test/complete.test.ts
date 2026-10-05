import assert from "node:assert/strict";
import test from "node:test";
import { emptyTui, reduceTui, renderTui, type TuiState } from "@amazme/tui";

function typed(input: string): TuiState {
  let state = emptyTui();
  for (const value of Array.from(input)) {
    state = reduceTui(state, { type: "key", key: { type: "char", value } }).state;
  }
  return state;
}

test("tab and enter insert the selected path and escape leaves the composer", () => {
  const base = {
    ...typed("看 @sr"),
    filePaths: ["src/a.ts", "src/b.ts"],
    fileHidden: false,
  };
  assert.equal(base.fileQuery, "sr");
  assert.match(renderTui(base, 60, 16), /src\/a\.ts/);
  const tab = reduceTui(base, { type: "key", key: { type: "tab" } });
  assert.equal(tab.effect, null);
  assert.equal(tab.state.input, "看 @src/a.ts");
  const down = reduceTui(base, { type: "key", key: { type: "down" } }).state;
  const entered = reduceTui(down, { type: "key", key: { type: "enter" } });
  assert.equal(entered.effect, null);
  assert.equal(entered.state.input, "看 @src/b.ts");
  const quoted = reduceTui({ ...base, filePaths: ["my file.ts"] }, { type: "key", key: { type: "tab" } });
  assert.equal(quoted.state.input, "看 @\"my file.ts\"");
  const closed = reduceTui(base, { type: "key", key: { type: "escape" } });
  assert.equal(closed.state.input, "看 @sr");
  assert.equal(reduceTui(closed.state, { type: "key", key: { type: "tab" } }).state.input, "看 @sr");
});
