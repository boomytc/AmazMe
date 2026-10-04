import assert from "node:assert/strict";
import test from "node:test";
import { createModels, MemoryCredentialStore, resolveModelAuth, type Provider } from "@amazme/ai";
import { fauxProvider } from "@amazme/ai/providers/faux";

function gate() {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { entered, ready, release, wait };
}

test("cancellation while reading a stored API key rejects auth resolution", async () => {
  const waiting = gate();
  class WaitingStore extends MemoryCredentialStore {
    override async get(providerId: string) {
      waiting.entered();
      await waiting.wait;
      return super.get(providerId);
    }
  }
  const store = new WaitingStore();
  await store.set("example", { type: "api_key", key: "fixture-key" });
  const controller = new AbortController();
  const pending = resolveModelAuth({ providerId: "example", auth: { apiKey: { env: "KEY" } }, store, env: {}, signal: controller.signal });
  await waiting.ready;
  controller.abort();
  waiting.release();
  await assert.rejects(pending, /aborted/);
});

test("cancellation during a custom async auth resolver does not call the provider", async () => {
  const waiting = gate();
  const base = fauxProvider();
  let providerCalls = 0;
  const provider: Provider = {
    ...base,
    auth: { apiKey: { env: "KEY", async resolve() {
      waiting.entered();
      await waiting.wait;
      return { apiKey: "fixture-key", source: "env" };
    } } },
    streamSimple(model, context, request) {
      providerCalls += 1;
      return base.streamSimple(model, context, request);
    },
  };
  const models = createModels({ env: {} });
  models.setProvider(provider);
  const model = provider.getModels()[0];
  assert.ok(model);
  const controller = new AbortController();
  const pending = models.completeSimple(model, { messages: [] }, { signal: controller.signal });
  await waiting.ready;
  controller.abort();
  waiting.release();
  assert.equal((await pending).stopReason, "aborted");
  assert.equal(providerCalls, 0);
  assert.equal(base.state.callCount, 0);
});

test("direct custom auth resolution checks cancellation after the resolver returns", async () => {
  const waiting = gate();
  const controller = new AbortController();
  const pending = resolveModelAuth({
    providerId: "example", store: new MemoryCredentialStore(), env: {}, signal: controller.signal,
    auth: { apiKey: { env: "KEY", async resolve() {
      waiting.entered();
      await waiting.wait;
      return { apiKey: "fixture-key", source: "env" };
    } } },
  });
  await waiting.ready;
  controller.abort();
  waiting.release();
  await assert.rejects(pending, /aborted/);
});
