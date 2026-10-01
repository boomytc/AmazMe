import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHarness, MemoryStorage, type Apply, type Storage, type StorageView, type Write } from "@amazme/agent";
import { JsonlStorage } from "@amazme/agent/storage/jsonl/node";
import { createStorageConformance } from "@amazme/agent/testing";
import { createModels, fauxProvider } from "@amazme/ai";

for (const backend of ["memory", "jsonl"] as const) {
  const cases = createStorageConformance(() => {
    if (backend === "memory") return { storage: new MemoryStorage() };
    const dir = mkdtempSync(join(tmpdir(), "amazme-storage-"));
    return { storage: new JsonlStorage(join(dir, "storage.jsonl")), dispose: () => rmSync(dir, { recursive: true, force: true }) };
  });
  for (const case_ of cases) test(`${backend}: ${case_.name}`, case_.run);
}

test("Harness accepts a structural storage and view without inheriting reference classes", async () => {
  class Adapter implements Storage {
    private readonly backing = new MemoryStorage();
    run<T>(fn: (view: StorageView, apply: Apply) => T | Promise<T>): Promise<T> {
      return this.backing.run((view, apply) => fn({
        entry: (id) => view.entry(id), entries: () => view.entries(), get: (address) => view.get(address),
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
  const harness = new AgentHarness(storage, { models, model: { provider: "faux", modelId: "faux-1" } });
  assert.equal((await harness.lane().prompt("go")).status, "completed");
  harness.close();
});

test("core entry runs without Node imports or a global process", () => {
  const entry = new URL("../src/index.ts", import.meta.url).href;
  const script = `
    const { registerHooks, builtinModules } = await import("node:module");
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith("node:") || builtinModules.includes(specifier)) throw new Error("Node import in core: " + specifier);
      return next(specifier, context);
    } });
    globalThis.process = undefined;
    const { AgentHarness, MemoryStorage, uuidv7 } = await import(${JSON.stringify(entry)});
    const { createModels, fauxProvider } = await import("@amazme/ai");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuidv7())) throw new Error("invalid UUID");
    const models = createModels();
    models.setProvider(fauxProvider());
    const runtime = new AgentHarness(new MemoryStorage(), { models, model: { provider: "faux", modelId: "faux-1" } });
    const result = await runtime.lane().prompt("portable");
    if (result.status !== "completed") throw new Error("core failed");
    runtime.close();
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
