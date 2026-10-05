import assert from "node:assert/strict";
import test from "node:test";
import { world } from "./support.ts";

test("an image prompt is stored as image content and does not call the model", async () => {
  const env = world();
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const lane = remote.lane("main");
    const content = [
      { type: "text" as const, text: "look " },
      { type: "image" as const, mimeType: "image/png", data: "aaaa" },
    ];
    const admitted = await lane.accept({ kind: "prompt", text: "look @shot.png", content });
    assert.equal(admitted.kind, "run");
    const snap = await lane.snapshot();
    const message = snap.entries[0]?.payload.type === "message" ? snap.entries[0].payload.message : undefined;
    assert.equal(message?.role, "user");
    assert.deepEqual((message as { content?: unknown } | undefined)?.content, content);
    assert.equal(env.runtime().streams.length, 0);
  } finally {
    await env.close();
  }
});
