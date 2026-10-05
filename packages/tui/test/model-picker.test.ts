import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chatModelSpecs, decodeKeys, emptyTui, reduceTui, renderTui, visibleModelSpec } from "@amazme/tui";
import { modelPicker } from "../src/present.ts";
import { plainScreen, SCREEN_COLUMNS, SCREEN_ROWS } from "./screen.ts";

const SPECS = [
  "faux/faux-1",
  "deepseek/deepseek-flash",
  "deepseek/deepseek-v4-pro",
  "typesafe/jev-latest",
  "cloudflare-workers-ai/typesafe/jev",
  "notes",
];

test("chat specs drop jev and entries that are not provider/id", () => {
  assert.deepEqual(chatModelSpecs(SPECS), [
    "faux/faux-1",
    "deepseek/deepseek-flash",
    "deepseek/deepseek-v4-pro",
  ]);
  assert.equal(visibleModelSpec("typesafe/jev-latest"), false);
  assert.equal(visibleModelSpec("OpenRouter/TypeSafe/JEV"), false);
  assert.equal(visibleModelSpec("deepseek/deepseek-v4-pro"), true);
});

test("typing filters the model list and enter selects that row", () => {
  const picker = modelPicker(SPECS, { provider: "faux", modelId: "faux-1" });
  assert.equal(picker.rows.some((row) => row.label.toLowerCase().includes("jev")), false);
  let state = {
    ...emptyTui(),
    provider: "faux",
    modelId: "faux-1",
    thinking: "off",
    directory: "work",
    picker,
  };
  for (const value of ["v", "4"]) {
    state = reduceTui(state, { type: "key", key: { type: "char", value } }).state;
  }
  const screen = plainScreen(renderTui(state, SCREEN_COLUMNS, SCREEN_ROWS));
  assert.equal(screen.includes("deepseek/deepseek-v4-pro"), true);
  assert.equal(screen.includes("deepseek-flash"), false);
  assert.equal(screen.includes("jev"), false);
  const picked = reduceTui(state, { type: "key", key: { type: "enter" } });
  assert.deepEqual(picked.effect, { type: "pick", kind: "model", id: "deepseek\tdeepseek-v4-pro" });
});

test("ctrl-p asks to cycle from the prompt and does not while the picker is open", () => {
  assert.deepEqual(decodeKeys("\u0010").keys, [{ type: "ctrl-p" }]);
  const cycled = reduceTui(emptyTui(), { type: "key", key: { type: "ctrl-p" } });
  assert.deepEqual(cycled.effect, { type: "cycle-model" });
  const picker = modelPicker(SPECS, { provider: "faux", modelId: "faux-1" });
  const open = reduceTui({ ...emptyTui(), picker }, { type: "key", key: { type: "ctrl-p" } });
  assert.equal(open.effect, null);
  assert.notEqual(open.state.picker, null);
});

test("the model picker snapshot is 60 by 16", () => {
  const picker = modelPicker(SPECS, { provider: "faux", modelId: "faux-1" });
  const state = {
    ...emptyTui(),
    provider: "faux",
    modelId: "faux-1",
    thinking: "off",
    directory: "work",
    picker,
  };
  const screen = plainScreen(renderTui(state, SCREEN_COLUMNS, SCREEN_ROWS));
  assert.equal(screen.split("\n").length, SCREEN_ROWS);
  assert.equal(screen.includes("\u001b"), false);
  assert.equal(screen.includes("Select model:"), true);
  assert.equal(screen.includes("faux/faux-1"), true);
  assert.equal(screen.includes("deepseek/deepseek-v4-pro"), true);
  assert.equal(screen.includes("jev"), false);
  const expected = readFileSync(new URL("./screens/model-picker.txt", import.meta.url), "utf8");
  assert.equal(`${screen}\n`, expected);
});
