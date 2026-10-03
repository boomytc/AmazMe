import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { AuthRefreshError, MemoryCredentialStore, createModels, resolveModelAuth } from "@amazme/ai";
import { anthropicOAuth, xaiOAuth } from "@amazme/ai/auth/oauth/flows";
import { xaiProvider } from "@amazme/ai/providers/xai";

test("oauth modules do not open a browser", () => {
  const dir = new URL("../src/auth/oauth/", import.meta.url);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const source = readFileSync(new URL(name, dir), "utf8");
    assert.equal(source.includes("child_process"), false, name);
    assert.equal(source.includes("xdg-open"), false, name);
  }
});

test("anthropic PKCE login returns a recorded token through the callback and does not browse", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(String(input));
    const body = String(init?.body ?? "");
    assert.match(body, /code=recorded-code/);
    assert.equal(body.includes("recorded-access"), false);
    return Response.json({
      access_token: "recorded-access",
      refresh_token: "recorded-refresh",
      expires_in: 3600,
    });
  };
  const pending = anthropicOAuth(fetchImpl).login({
    callbackPort: 0,
    fetch: fetchImpl,
    onHandback(handback) {
      assert.ok(handback.auth_url);
      const url = new URL(handback.auth_url);
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      const state = url.searchParams.get("state") ?? "";
      void fetch(`${redirect.origin}${redirect.pathname}?code=recorded-code&state=${state}`);
    },
  });
  const result = await pending;
  assert.equal(result.credential.access, "recorded-access");
  assert.equal(result.credential.refresh, "recorded-refresh");
  assert.equal(result.credential.type, "oauth");
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /platform\.claude\.com\/v1\/oauth\/token$/);
  assert.equal(JSON.stringify(result).includes("browser"), false);
});

test("xAI device login hands back a user code and stores the recorded token", async () => {
  const handbacks: Array<{ user_code?: string; verification_uri?: string }> = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/device/code")) {
      return Response.json({
        device_code: "secret-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.x.ai/device",
        interval: 0,
        expires_in: 30,
      });
    }
    return Response.json({ access_token: "recorded-access", refresh_token: "recorded-refresh", expires_in: 3600 });
  };
  const result = await xaiOAuth(fetchImpl).login({
    onHandback(handback) {
      handbacks.push({ user_code: handback.device_code?.user_code, verification_uri: handback.device_code?.verification_uri });
    },
  });
  assert.deepEqual(handbacks, [{ user_code: "ABCD-EFGH", verification_uri: "https://auth.x.ai/device" }]);
  assert.equal(JSON.stringify(handbacks).includes("secret-device-code"), false);
  assert.equal(result.credential.access, "recorded-access");
});

test("a failed refresh does not call stream and does not write a half credential", async () => {
  const store = new MemoryCredentialStore();
  const original = { type: "oauth" as const, refresh: "recorded-refresh", access: "recorded-access", expires: 1 };
  await store.set("xai", original);
  let modelCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.x.ai/v1")) {
      modelCalls += 1;
      return new Response("model", { status: 200 });
    }
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  };
  const models = createModels({ store });
  models.setProvider(xaiProvider({ fetch: fetchImpl }));
  const model = models.getModel("xai", models.getProvider("xai")?.getModels()[0]?.id ?? "");
  assert.ok(model);
  const message = await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /OAuth token request failed/);
  assert.equal(modelCalls, 0);
  assert.deepEqual(await store.get("xai"), original);
  await assert.rejects(
    resolveModelAuth({
      providerId: "xai",
      auth: xaiProvider({ fetch: fetchImpl }).auth,
      store,
      env: {},
      refresh: true,
    }),
    (error: unknown) => error instanceof AuthRefreshError,
  );
  assert.deepEqual(await store.get("xai"), original);
});

test("overlapping requests refresh one expired credential once", async () => {
  const store = new MemoryCredentialStore();
  const original = { type: "oauth" as const, refresh: "recorded-refresh", access: "recorded-access", expires: 1 };
  await store.set("xai", original);
  let tokenCalls = 0;
  let modelCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://auth.x.ai/oauth2/token")) {
      tokenCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.match(String(init?.body ?? ""), /refresh_token=recorded-refresh/);
      return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 });
    }
    modelCalls += 1;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fresh-access");
    assert.equal(String(init?.body ?? "").includes("recorded-refresh"), false);
    return responsesSse();
  };
  const models = createModels({ store });
  models.setProvider(xaiProvider({ fetch: fetchImpl }));
  const model = models.getModel("xai", models.getProvider("xai")?.getModels()[0]?.id ?? "");
  assert.ok(model);
  const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
  const [first, second] = await Promise.all([
    models.completeSimple(model, context),
    models.completeSimple(model, context),
  ]);
  assert.equal(first.stopReason, "stop");
  assert.equal(second.stopReason, "stop");
  assert.equal(tokenCalls, 1);
  assert.equal(modelCalls, 2);
  const saved = await store.get("xai");
  if (!saved || saved.type !== "oauth") assert.fail("expected the refreshed oauth credential");
  assert.equal(saved.access, "fresh-access");
  assert.equal(saved.refresh, "fresh-refresh");
  assert.equal(saved.expires > Date.now(), true);
});

test("aborting a refresh does not call the model or replace the credential", async () => {
  const store = new MemoryCredentialStore();
  const original = { type: "oauth" as const, refresh: "recorded-refresh", access: "recorded-access", expires: 1 };
  await store.set("xai", original);
  const controller = new AbortController();
  let modelCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://auth.x.ai/oauth2/token")) {
      controller.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    }
    modelCalls += 1;
    return responsesSse();
  };
  const models = createModels({ store });
  models.setProvider(xaiProvider({ fetch: fetchImpl }));
  const model = models.getModel("xai", models.getProvider("xai")?.getModels()[0]?.id ?? "");
  assert.ok(model);
  const message = await models.completeSimple(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    { signal: controller.signal },
  );
  assert.equal(message.stopReason, "aborted");
  assert.equal(modelCalls, 0);
  assert.equal(message.errorMessage?.includes("recorded-refresh"), false);
  assert.deepEqual(await store.get("xai"), original);
});

test("cancelling an xAI device login does not return a credential", async () => {
  const controller = new AbortController();
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/device/code")) {
      return Response.json({
        device_code: "secret-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.x.ai/device",
        interval: 0,
        expires_in: 30,
      });
    }
    controller.abort();
    return Response.json({ error: "authorization_pending" });
  };
  await assert.rejects(
    xaiOAuth(fetchImpl).login({ signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.message === "Login cancelled",
  );
});

function responsesSse(): Response {
  const event = { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}
