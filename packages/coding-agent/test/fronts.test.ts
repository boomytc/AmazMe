import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider } from "@amazme/ai/providers/faux";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { executeSlash, type SlashActions } from "@amazme/tui";
import { startCodingHost } from "../src/host.ts";
import { codingModels, createCodingFronts } from "../src/fronts.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));

function frontEnv(cwd: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  env.AMAZME_CREDENTIALS = join(cwd, "credentials.json");
  env.AMAZME_DEVICE_ID_FILE = join(cwd, "device-id");
  return env;
}

test("amazme --web serves the host page and a signal stops it", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-web-front-"));
  const child = spawn(process.execPath, ["--import", "tsx", cli, "--web", "--cwd", cwd, "from-owned-web"], {
    cwd: root,
    env: frontEnv(cwd),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    await until(() => stdout.includes("http://127.0.0.1:"), () => `${stdout}\n${stderr}`);
    const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout)?.[0];
    if (!url) throw new Error(stdout);
    const view = await (await fetch(`${url}view`)).json() as { entries: Array<{ text: string }>; provider: string; modelId: string };
    assert.equal(view.provider, "deepseek");
    assert.equal(view.modelId, "deepseek-flash");
    assert.ok(view.entries.some((entry) => entry.text === "from-owned-web"));
    assert.equal(view.entries.some((entry) => entry.text.startsWith("faux:")), false);
    const again = await fetch(`${url}act`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "submit", text: "/web" }),
    });
    const notice = await again.json() as { notice: string | null };
    assert.match(notice.notice ?? "", /网页已在当前宿主/);
    child.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 50));
    child.kill("SIGINT");
    await until(() => child.exitCode !== null || child.signalCode !== null, () => stderr);
    await assert.rejects(() => fetch(`${url}view`));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("amazme --gui starts the host and shows the prompt reply", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-gui-front-"));
  const child = spawn(process.execPath, ["--import", "tsx", cli, "--gui", "--cwd", cwd, "from-owned-gui"], {
    cwd: root,
    env: frontEnv(cwd),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    await until(() => stdout.includes("from-owned-gui") && stdout.includes("deepseek/deepseek-flash") && stdout.includes("空闲"), () => `${stdout}\n${stderr}`);
    const shown = stdout.trim().split("\n").map((line) => JSON.parse(line) as { document: string; status: string });
    assert.ok(shown.some((row) => row.document.includes('id="status"') && row.status.includes("deepseek/deepseek-flash") && row.status.includes("空闲")));
    assert.equal(stdout.includes("faux:"), false);
    child.stdin.end();
    await until(() => child.exitCode !== null, () => `${stdout}\n${stderr}`);
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("product fronts reject faux and load deepseek-flash", () => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-models-"));
  try {
    assert.throws(() => codingModels({ cwd, provider: "faux", model: "faux-1" }), /unknown provider faux/);
    const models = codingModels({ cwd, provider: "deepseek", model: "deepseek-flash" });
    assert.ok(models.getModel("deepseek", "deepseek-flash"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("/web and /gui publish clients on the current host and stop releases it", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "amz-slash-front-"));
  const models = createModels();
  models.setProvider(fauxProvider({
    respond: (context) => {
      const text = [...context.messages].reverse().find((message) => message.role === "user");
      return fauxAssistant(`faux:${text ? messageText(text) : ""}`);
    },
  }));
  const host = await startCodingHost({ cwd, socket: join(cwd, "host.sock"), provider: "faux", model: "faux-1", models });
  const fronts = createCodingFronts(host);
  try {
    const blocked = await executeSlash({ type: "gui" }, slashActions());
    assert.equal(blocked.type, "notice");
    if (blocked.type === "notice") assert.match(blocked.text, /不能打开图形窗口/);
    const opened = await executeSlash({ type: "web" }, slashActions({
      openWeb: async () => `网页 ${await fronts.openWeb()}`,
    }));
    assert.equal(opened.type, "notice");
    const url = opened.type === "notice" ? /http:\/\/127\.0\.0\.1:\d+\//.exec(opened.text)?.[0] : undefined;
    if (!url) throw new Error(opened.type === "notice" ? opened.text : opened.type);
    const saved = await fetch(`${url}act`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "submit", text: "from-slash-web" }),
    });
    assert.equal(saved.status, 200);
    const view = await saved.json() as { entries: Array<{ text: string }> };
    assert.ok(view.entries.some((entry) => entry.text === "faux:from-slash-web"));
    const gui = await executeSlash({ type: "gui" }, slashActions({ openGui: () => fronts.openGui() }));
    assert.equal(gui.type, "notice");
    if (gui.type === "notice") assert.match(gui.text, /图形窗口已附着/);
    const client = new Client({ serverId: "amazme", transport: createUnixTransport({ path: host.socket }) });
    await client.connect();
    const remote = new RuntimeClient(client);
    await remote.attach("workspace");
    assert.equal((await remote.lane("main").snapshot()).lane, "main");
    await client.dispose();
    await fronts.stop();
    const closed = new Client({ serverId: "amazme", transport: createUnixTransport({ path: host.socket }) });
    await assert.rejects(() => closed.connect());
  } finally {
    await fronts.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

function slashActions(extra: Partial<SlashActions> = {}): SlashActions {
  return {
    lane: () => { throw new Error("unused lane"); },
    list: async () => [],
    active: () => "main",
    open: async () => undefined,
    earlier: async () => "",
    continueRetry: async () => "",
    ...extra,
  };
}

function until(ready: () => boolean, detail: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(detail()));
    }, 15_000);
    const poll = setInterval(() => {
      if (!ready()) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    }, 30);
  });
}
