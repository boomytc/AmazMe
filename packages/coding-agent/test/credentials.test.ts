import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Credential } from "@amazme/ai";
import { FileCredentialStore } from "../src/credentials.ts";

function storeInTemp(): { store: FileCredentialStore; file: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "amazme-credentials-"));
  const file = join(directory, "credentials.json");
  return { store: new FileCredentialStore(file), file, directory };
}

function read(file: string): Record<string, Credential> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, Credential>;
}

test("a refresh that awaits does not drop another provider written during the wait", async () => {
  const { store, file, directory } = storeInTemp();
  const original: Credential = { type: "api_key", key: "alpha-old" };
  await store.set("alpha", original);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const modifying = store.modify("alpha", async (current) => {
    assert.deepEqual(current, original);
    entered();
    await gate;
    return { type: "api_key", key: "alpha-new" };
  });
  await ready;
  assert.deepEqual(read(file), { alpha: original });
  const setting = store.set("beta", { type: "api_key", key: "beta-key" });
  release();
  assert.deepEqual(await modifying, { type: "api_key", key: "alpha-new" });
  await setting;
  assert.deepEqual(read(file), {
    alpha: { type: "api_key", key: "alpha-new" },
    beta: { type: "api_key", key: "beta-key" },
  });
  assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
});

test("a failed refresh leaves the credential file unchanged and the store usable", async () => {
  const { store, file, directory } = storeInTemp();
  const original: Credential = { type: "oauth", access: "recorded-access", refresh: "recorded-refresh", expires: 1 };
  await store.set("alpha", original);
  await assert.rejects(
    store.modify("alpha", async () => {
      throw new Error("OAuth token request failed (400)");
    }),
    /OAuth token request failed \(400\)/,
  );
  assert.deepEqual(read(file), { alpha: original });
  assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
  await store.set("beta", { type: "api_key", key: "beta-key" });
  assert.deepEqual(read(file), {
    alpha: original,
    beta: { type: "api_key", key: "beta-key" },
  });
});
