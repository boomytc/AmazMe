import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { startCallbackServer, type CallbackServer } from "../src/auth/oauth/callback-server.ts";

test("cancelling while the callback server binds rejects opening and removes its listener", async () => {
  const controller = new AbortController();
  let server: CallbackServer | undefined;
  const opening = startCallbackServer({ port: 0, path: "/callback", signal: controller.signal, timeoutMs: 200 })
    .then((opened) => { server = opened; return opened; });
  controller.abort();
  try {
    await assert.rejects(opening, /Login cancelled/);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    server?.close();
  }
});

test("callback success, cancellation, timeout and close remove the abort listener", async () => {
  for (const outcome of ["success", "cancel", "timeout", "close"] as const) {
    const controller = new AbortController();
    const server = await startCallbackServer({
      port: 0, path: "/callback", state: "state", signal: controller.signal, timeoutMs: outcome === "timeout" ? 20 : 1000,
    });
    try {
      assert.equal(getEventListeners(controller.signal, "abort").length, 1);
      if (outcome === "success") {
        const response = await fetch(`${server.redirectUri}?code=recorded-code&state=state`);
        assert.equal(response.status, 200);
        assert.equal((await server.wait()).searchParams.get("code"), "recorded-code");
      } else {
        const waiting = assert.rejects(server.wait(), outcome === "cancel" ? /Login cancelled/ : outcome === "timeout" ? /timed out/ : /closed/);
        if (outcome === "cancel") controller.abort();
        if (outcome === "close") server.close();
        await waiting;
      }
      assert.equal(getEventListeners(controller.signal, "abort").length, 0, outcome);
    } finally {
      server.close();
    }
  }
});
