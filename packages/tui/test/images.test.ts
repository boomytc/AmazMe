import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeKeys, emptyTui, reduceTui, type TuiEffect, type TuiState } from "@amazme/tui";
import { imagePrompt, parseAtMentions, pastedImageMention, userContentFromParts } from "../src/images.ts";

function play(input: string, state: TuiState = emptyTui()): { state: TuiState; effects: TuiEffect[] } {
  const decoded = decodeKeys(input);
  if (decoded.rest.length > 0) throw new Error("按键序列被截断");
  let current = state;
  const effects: TuiEffect[] = [];
  for (const key of decoded.keys) {
    const step = reduceTui(current, { type: "key", key });
    current = step.state;
    if (step.effect) effects.push(step.effect);
  }
  return { state: current, effects };
}

test("the @ scanner attaches only image extensions and leaves every other mention as text", () => {
  assert.deepEqual(parseAtMentions("see @readme.md and @shot.PNG."), [
    { kind: "text", text: "see @readme.md and " },
    { kind: "image", path: "shot.PNG", raw: "@shot.PNG" },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(parseAtMentions("user@x.png @notes.txt @a.jpeg @b.gif @c.webp @d.bmp"), [
    { kind: "text", text: "user@x.png @notes.txt " },
    { kind: "image", path: "a.jpeg", raw: "@a.jpeg" },
    { kind: "text", text: " " },
    { kind: "image", path: "b.gif", raw: "@b.gif" },
    { kind: "text", text: " " },
    { kind: "image", path: "c.webp", raw: "@c.webp" },
    { kind: "text", text: " @d.bmp" },
  ]);
  assert.deepEqual(parseAtMentions("plain"), [{ kind: "text", text: "plain" }]);
  assert.equal(pastedImageMention("  ./pic.jpg  "), "@./pic.jpg");
  assert.equal(pastedImageMention("@shot.png"), "@shot.png");
  assert.equal(pastedImageMention("notes.md"), undefined);
  assert.equal(pastedImageMention("see @shot.png"), undefined);
  assert.equal(pastedImageMention("\"my photo.png\""), "@\"my photo.png\"");
  assert.deepEqual(
    userContentFromParts(parseAtMentions("look @shot.png"), new Map([["shot.png", { mimeType: "image/png", data: "aaaa" }]])),
    [
      { type: "text", text: "look " },
      { type: "image", mimeType: "image/png", data: "aaaa" },
    ],
  );
});

test("@image paths and a pasted image path become image content; other @ paths stay text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amz-image-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(join(dir, "x.png"), png);
  writeFileSync(join(dir, "shot.JPG"), png);
  try {
    const typed = play("see @readme.md and @x.png\r");
    assert.deepEqual(typed.effects, [{ type: "submit", text: "see @readme.md and @x.png" }]);
    const loaded = await imagePrompt(typed.effects[0]?.type === "submit" ? typed.effects[0].text : "", dir);
    assert.equal(loaded.ok, true);
    if (!loaded.ok || !loaded.content) return;
    assert.deepEqual(loaded.content, [
      { type: "text", text: "see @readme.md and " },
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
    ]);

    const pasted = play("\x1b[200~shot.JPG\x1b[201~");
    assert.equal(pasted.state.input, "@shot.JPG");
    assert.deepEqual(pasted.effects, []);
    const sent = play("\r", pasted.state);
    assert.equal(sent.effects[0]?.type, "submit");
    const fromPaste = await imagePrompt(sent.effects[0]?.type === "submit" ? sent.effects[0].text : "", dir);
    assert.equal(fromPaste.ok, true);
    if (!fromPaste.ok || !fromPaste.content) return;
    assert.deepEqual(fromPaste.content, [
      { type: "image", mimeType: "image/jpeg", data: png.toString("base64") },
    ]);

    const notes = play("\x1b[200~notes.md\x1b[201~");
    assert.equal(notes.state.input, "notes.md");
    const kept = await imagePrompt("keep @notes.md", dir);
    assert.deepEqual(kept, { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
