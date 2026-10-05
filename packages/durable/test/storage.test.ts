import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHarness, list, value, type Apply, type HarnessModels, type Storage, type StorageView, type Write } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
import { createStorageConformance } from "@amazme/durable/testing";
import { createModels } from "@amazme/ai";
import { fauxProvider } from "@amazme/ai/testing";

for (const backend of ["memory", "jsonl"] as const) {
  const cases = createStorageConformance(() => {
    if (backend === "memory") return { storage: new MemoryStorage() };
    const dir = mkdtempSync(join(tmpdir(), "amazme-storage-"));
    return { storage: new JsonlStorage(join(dir, "storage.jsonl")), dispose: () => rmSync(dir, { recursive: true, force: true }) };
  });
  for (const case_ of cases) test(`${backend}: ${case_.name}`, case_.run);
}

test("JSONL reopen replays the storage version, including writes from other lanes and a torn tail", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "storage.jsonl");
  const first = new JsonlStorage(file);
  await first.commit([{ type: "set", address: value("lane.a"), value: 1 }, { type: "append", address: list("lane.b"), item: 1 }]);
  await assert.rejects(first.commit([{ type: "set", address: value("lane.a"), value: 2 }, { type: "set", address: value(""), value: 0 }]));
  const committed = await first.commit([{ type: "deleteList", address: list("lane.b") }, { type: "delete", address: value("lane.a") }]);
  assert.equal(committed.seq, 4);
  appendFileSync(file, "{\"writes\":[{\"type\":\"set\"");
  assert.equal(await new JsonlStorage(file).read((view) => view.version()), 4);
});

test("Harness accepts structural storage, view and model capabilities without reference classes", async () => {
  class Adapter implements Storage {
    private readonly backing = new MemoryStorage();
    run<T>(fn: (view: StorageView, apply: Apply) => T | Promise<T>): Promise<T> {
      return this.backing.run((view, apply) => fn({
        version: () => view.version(), entry: (id) => view.entry(id), entries: () => view.entries(), get: (address) => view.get(address),
        items: (address) => view.items(address), usageRows: () => view.usageRows(),
        values: () => view.values(), lists: () => view.lists(),
      }, apply));
    }
    commit(writes: readonly Write[]) { return this.backing.commit(writes); }
    read<T>(fn: (view: StorageView) => T) { return this.run((view) => fn(view)); }
    subscribe(listener: () => void) { return this.backing.subscribe(listener); }
    whenIdle() { return this.backing.whenIdle(); }
  }
  const storage = new Adapter();
  assert.equal(storage instanceof MemoryStorage, false);
  const models = createModels();
  models.setProvider(fauxProvider());
  const capabilities: HarnessModels = {
    getModel: (provider, id) => models.getModel(provider, id),
    streamSimple: (model, context, options) => models.streamSimple(model, context, options),
  };
  const harness = new AgentHarness(storage, { models: capabilities, model: { provider: "faux", modelId: "faux-1" } });
  assert.equal((await harness.lane().prompt("go")).status, "completed");
  harness.close();
});

test("public core and memory entries run without Node, coding-agent, or a global process", () => {
  const script = `
    const { registerHooks, builtinModules } = await import("node:module");
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith("node:") || builtinModules.includes(specifier)) throw new Error("Node import in core: " + specifier);
      const resolved = next(specifier, context);
      if (resolved.url.includes("/packages/coding-agent/")) throw new Error("coding-agent dependency in Durable: " + specifier);
      return resolved;
    } });
    globalThis.process = undefined;
    const { AgentHarness } = await import("@amazme/durable");
    const { MemoryStorage } = await import("@amazme/durable/storage/memory");
    const { createModels, uuidv7 } = await import("@amazme/ai");
    const { fauxProvider } = await import("@amazme/ai/testing");
    const { InMemoryTelemetryContext } = await import("@amazme/telemetry");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuidv7())) throw new Error("invalid UUID");
    const telemetryContext = new InMemoryTelemetryContext();
    const models = createModels({ telemetryContext });
    models.setProvider(fauxProvider());
    const runtime = new AgentHarness(new MemoryStorage(), { models, model: { provider: "faux", modelId: "faux-1" } });
    const result = await runtime.lane().prompt("portable");
    if (result.status !== "completed") throw new Error("core failed");
    if (telemetryContext.getSpans().length !== 2 || !telemetryContext.getSpans().every(span => span.settled)) throw new Error("portable telemetry failed");
    runtime.close();
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
