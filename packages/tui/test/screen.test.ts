import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TuiEffect } from "@amazme/tui";
import { SCREEN_ROWS, parseScreenScript, playScreen } from "./screen.ts";

const scenarios: ReadonlyArray<{ name: string; effects: TuiEffect[] }> = [
  { name: "empty", effects: [] },
  { name: "turn", effects: [{ type: "submit", text: "今天天气怎么样" }] },
  { name: "tool", effects: [{ type: "submit", text: "读一下 README" }] },
  { name: "overlay", effects: [] },
];

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./screens/${name}.json`, import.meta.url), "utf8"));
}

for (const scenario of scenarios) {
  test(`${scenario.name} screen matches the snapshot`, () => {
    const played = playScreen(parseScreenScript(readJson(scenario.name)));
    const again = playScreen(parseScreenScript(readJson(scenario.name)));
    assert.equal(again.screen, played.screen);
    assert.equal(played.screen.split("\n").length, SCREEN_ROWS);
    assert.equal(played.screen.includes("\u001b"), false);
    const expected = readFileSync(new URL(`./screens/${scenario.name}.txt`, import.meta.url), "utf8");
    assert.equal(`${played.screen}\n`, expected);
    assert.deepEqual(played.effects, scenario.effects);
  });
}

test("the screens are not the same frame", () => {
  const frames = scenarios.map((scenario) => playScreen(parseScreenScript(readJson(scenario.name))).screen);
  assert.equal(new Set(frames).size, frames.length);
});

test("a truncated key sequence is refused before a screen is produced", () => {
  assert.throws(() => playScreen({ steps: [{ type: "keys", input: "\u001b" }] }), /截断/);
});

test("a value that is not a lane snapshot is refused", () => {
  assert.throws(() => playScreen({ steps: [{ type: "snapshot", snapshot: { version: 0 } }] }));
});
