import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, type Models } from "@amazme/ai";
import { fauxProvider } from "@amazme/ai/testing";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { startCodingBridge } from "../../coding-agent/src/bridge.ts";
import { startCodingHost } from "../../coding-agent/src/host.ts";
import { startWeb } from "@amazme/web";

function hostModels(): Models {
  const models = createModels();
  models.setProvider(fauxProvider({ id: "faux", modelId: "faux-1" }));
  models.setProvider(fauxProvider({ id: "other", modelId: "other-1" }));
  models.setProvider(fauxProvider({ id: "typesafe", modelId: "jev-latest" }));
  models.setProvider(fauxProvider({ id: "catalog-only", modelId: "not-scoped" }));
  return models;
}

function writeScope(cwd: string, scoped: string[]): void {
  mkdirSync(join(cwd, ".amazme"), { recursive: true });
  writeFileSync(join(cwd, ".amazme", "project.json"), `${JSON.stringify({
    trusted: false,
    settings: {},
    names: {},
    scopedModels: scoped,
  }, null, 2)}\n`);
}

interface ModelRow {
  provider: string;
  modelId: string;
}

interface ViewBody {
  provider: string;
  modelId: string;
  models: ModelRow[];
  notice: string | null;
}

test("web /model lists scoped models, drops Jev, and selecting configures the lane", { timeout: 20_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-web-model-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeScope(cwd, ["faux/faux-1", "other/other-1", "typesafe/jev-latest", "notes"]);
  const socket = join(cwd, "host.sock");
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models: hostModels() });
  t.after(() => host.close());
  const page = await startCodingBridge({ socket, port: 0, cwd });
  t.after(() => page.close());
  const listed = await fetch(`${page.url}view`);
  assert.equal(listed.status, 200);
  const view = await listed.json() as ViewBody;
  assert.deepEqual(view.models, [
    { provider: "faux", modelId: "faux-1" },
    { provider: "other", modelId: "other-1" },
  ]);
  assert.equal(JSON.stringify(view.models).includes("jev"), false);
  assert.equal(JSON.stringify(view.models).includes("notes"), false);
  assert.equal(JSON.stringify(view.models).includes("catalog-only"), false);
  const row = view.models.find((model) => model.provider === "other" && model.modelId === "other-1");
  assert.ok(row);
  const switchedResponse = await fetch(`${page.url}act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "submit", text: `/model ${row.provider}/${row.modelId}` }),
  });
  assert.equal(switchedResponse.status, 200);
  const switched = await switchedResponse.json() as ViewBody;
  assert.equal(switched.provider, "other");
  assert.equal(switched.modelId, "other-1");
  assert.match(switched.notice ?? "", /other\/other-1/);
});

test("an empty scoped list does not dump the catalog", { timeout: 20_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-web-empty-model-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeScope(cwd, []);
  const socket = join(cwd, "host.sock");
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models: hostModels() });
  t.after(() => host.close());
  const page = await startWeb({
    socket,
    cwd,
    port: 0,
    serverId: "amazme",
    runtimeId: "workspace",
    lane: "main",
  });
  t.after(() => page.close());
  const client = new Client({ serverId: "amazme", transport: createUnixTransport({ path: socket }) });
  await client.connect();
  t.after(() => client.dispose());
  const remote = new RuntimeClient(client);
  await remote.attach("workspace");
  const catalog = await remote.lane("main").catalog();
  assert.equal(catalog.models.some((model) => model.provider === "catalog-only" && model.modelId === "not-scoped"), true);
  assert.equal(catalog.models.some((model) => `${model.provider}/${model.modelId}`.includes("jev")), false);
  const listed = await fetch(`${page.url}view`);
  assert.equal(listed.status, 200);
  const view = await listed.json() as ViewBody;
  assert.deepEqual(view.models, []);
});
