import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider } from "@amazme/ai/providers/faux";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { startWeb } from "@amazme/web";
import { startCodingHost } from "../src/host.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("the gui and the web page share one host lane", { timeout: 20_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-gui-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const socket = join(cwd, "host.sock");
  const models = createModels();
  models.setProvider(fauxProvider({ respond: (_context, _options, _state, model) => fauxAssistant(`faux:${model.id}`) }));
  const host = await startCodingHost({ cwd, socket, provider: "faux", model: "faux-1", models });
  t.after(() => host.close());
  const page = await startWeb({ socket, port: 0, serverId: "amazme", runtimeId: "workspace", lane: "main" });
  t.after(() => page.close());
  const child = spawn(process.execPath, ["--import", "tsx", cli, "gui", "--socket", socket, "--prompt", "from-gui"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  t.after(() => {
    child.stdin.end();
    child.kill();
  });
  await until(() => stdout.includes("faux:faux-1") && stdout.includes("from-gui") && stdout.includes('"status":'));
  assert.match(stdout, /from-gui/);
  assert.match(stdout, /faux:faux-1/);
  const shown = stdout.trim().split("\n").map((line) => JSON.parse(line) as { document: string; status: string });
  assert.ok(shown.some((row) => row.document.includes('id="status"') && row.status.includes("faux/faux-1") && row.status.includes("空闲")));
  assert.equal(stdout.includes("<main></main>") && !stdout.includes("from-gui"), false);
  const web = await fetch(`${page.url}act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "submit", text: "from-web" }),
  });
  assert.equal(web.status, 200);
  await until(() => stdout.includes("from-web"));
  const pageView = await (await fetch(`${page.url}view`)).json() as { entries: Array<{ text: string }> };
  assert.ok(pageView.entries.some((entry) => entry.text === "from-gui"));
  assert.ok(pageView.entries.some((entry) => entry.text === "from-web"));
  child.stdin.end();
  await until(() => child.exitCode !== null);
  const client = new Client({ serverId: "amazme", transport: createUnixTransport({ path: socket }) });
  await client.connect();
  t.after(() => client.dispose());
  const remote = new RuntimeClient(client);
  await remote.attach("workspace");
  const snapshot = await remote.lane("main").snapshot();
  assert.equal(snapshot.lane, "main");
  void stderr;
});

function until(ready: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("the gui did not show the reply"));
    }, 15_000);
    const poll = setInterval(() => {
      if (!ready()) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    }, 20);
  });
}
