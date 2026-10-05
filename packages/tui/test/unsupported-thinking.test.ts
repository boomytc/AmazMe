import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import {
  baseAssistant,
  createAssistantEventStream,
  createModels,
  createProvider,
  resolveThinkingLevel,
  supportedThinkingLevels,
  type Model,
  type ProviderStreams,
} from "@amazme/ai";
import { AgentHarness } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { createManagementService, openOwnedRuntimes } from "@amazme/runtime-service/server";
import { Server } from "@amazme/server";
import { listenUnix } from "@amazme/server/unix";
import { presentHost } from "@amazme/tui";

const LANE = "main";
const HINT = "当前模型不支持 medium，先用 /thinking 切到 off/low/high";

/**
 * flash 的档是 off/low/high。构造参数把 thinkingLevel 写成 medium。
 * ensureLane 先把这个档存下来，configure 再拒绝读取，已存的 medium 不会被改掉。
 * 这就是旧会话重开时的形状。模型流只在本进程里收口，不访问供应商。
 */
test("a flash lane stored at medium hints on open, again when a turn is refused, then completes after /thinking low", { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-stored-thinking-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await openFlash(join(dir, "host.sock"));
  t.after(() => host.close());
  const stored = await host.harness.lane(LANE).configure();
  assert.equal(stored.ok, false);
  if (stored.ok) return;
  assert.match(stored.error.message, /thinking level medium is not supported; available: off, low, high/);

  const tty = fakeTTY();
  tty.columns = 120;
  tty.rows = 32;
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE },
    tty.stdin,
    tty.stdout,
  );
  try {
    await until(() => tty.since(0).includes(HINT), "the open hint");
    const opened = await host.harness.lane(LANE).configure();
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.match(opened.error.message, /thinking level medium is not supported/);

    const sent = tty.chunks.length;
    tty.push("ping\r");
    await until(() => tty.since(sent).includes(HINT), "the same hint after the refused turn");
    assert.match(tty.since(sent), /Thinking level "medium" is not supported by deepseek-flash/);
    const still = await host.harness.lane(LANE).configure();
    assert.equal(still.ok, false);

    const lowered = tty.chunks.length;
    tty.push("/thinking low\r");
    await until(() => tty.since(lowered).includes("思考 low"), "the supported level");
    const switched = await host.harness.lane(LANE).configure();
    assert.equal(switched.ok, true);
    if (!switched.ok) return;
    assert.equal(switched.value.thinkingLevel, "low");
    assert.equal(switched.value.modelId, "deepseek-flash");
    assert.deepEqual(switched.value.thinkingLevels, ["off", "low", "high"]);

    const turned = tty.chunks.length;
    tty.push("hello\r");
    await until(() => tty.since(turned).includes("flash-ok"), "the completed turn");
    assert.equal(tty.since(turned).includes(HINT), false);
    const entries = await host.harness.lane(LANE).entries();
    const last = entries.at(-1);
    assert.equal(last?.payload.type, "message");
    if (last?.payload.type !== "message") return;
    assert.equal(last.payload.message.role, "assistant");
    if (last.payload.message.role !== "assistant") return;
    assert.equal(last.payload.message.stopReason, "stop");
    const text = last.payload.message.content.map((block) => block.type === "text" ? block.text : "").join("");
    assert.equal(text, "flash-ok");
    assert.deepEqual(host.errors, []);
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u0004");
    await Promise.race([screen.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\nerrors=${host.errors.map((item) => item.message).join(" | ")}\npaint=${tty.since(0)}`);
  }
});

function flashModel(): Model {
  return {
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    provider: "deepseek",
    api: "faux",
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high" },
  };
}

function flashStreams(): ProviderStreams {
  const streams: ProviderStreams = {
    stream(model, context, options) {
      return streams.streamSimple(model, context, options);
    },
    streamSimple(model, _context, options) {
      const stream = createAssistantEventStream();
      const resolution = resolveThinkingLevel(model, options?.thinkingLevel);
      void (async () => {
        if (!resolution.ok) {
          const failed = baseAssistant(model, [], "error");
          failed.errorMessage = `Thinking level "${resolution.level}" is not supported by ${model.id}`;
          stream.push({ type: "error", error: failed });
          return;
        }
        const message = baseAssistant(model, [{ type: "text", text: "flash-ok" }], "stop");
        stream.push({ type: "done", reason: "stop", message });
      })();
      return stream;
    },
  };
  return streams;
}

async function openFlash(socket: string) {
  const flash = flashModel();
  assert.deepEqual(supportedThinkingLevels(flash), ["off", "low", "high"]);
  const models = createModels();
  models.setProvider(createProvider({
    id: "deepseek",
    auth: { env: "FIXTURE_KEY", ambient: "test" },
    models: [flash],
    api: flashStreams(),
  }));
  const storage = new MemoryStorage();
  const harness = new AgentHarness(storage, {
    models,
    model: { provider: "deepseek", modelId: "deepseek-flash" },
    thinkingLevel: "medium",
    workspace: "work",
  });
  const errors: Error[] = [];
  let server!: Server;
  server = new Server({
    serverId: "tui-test",
    onError: (error) => errors.push(error),
    service: createManagementService({ removeRuntime: (runtimeId) => server.removeRuntime(runtimeId) }),
    openRuntime: openOwnedRuntimes({
      onError: (error) => errors.push(error),
      async open(runtimeId) {
        if (runtimeId !== "main") return null;
        return {
          harness,
          closeStorage: () => storage.whenIdle(),
          release: () => storage.whenIdle(),
          remove: () => storage.whenIdle(),
        };
      },
    }),
  });
  const listener = await listenUnix(server, { path: socket, onError: (error) => errors.push(error) });
  return {
    path: listener.path,
    harness,
    errors,
    close: async () => {
      await server.close();
      await listener.close();
    },
  };
}

function fakeTTY() {
  const input = new EventEmitter();
  const output = new EventEmitter();
  const chunks: string[] = [];
  const stdin = Object.assign(input, {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      this.isRaw = mode;
      return this;
    },
    resume() { return this; },
    pause() { return this; },
  });
  const stdout = Object.assign(output, {
    isTTY: true,
    columns: 80,
    rows: 24,
    write(chunk: string | Uint8Array) {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
  });
  return {
    stdin: stdin as unknown as ReadStream,
    stdout: stdout as unknown as WriteStream,
    chunks,
    get columns() { return stdout.columns; },
    set columns(value: number) { stdout.columns = value; },
    get rows() { return stdout.rows; },
    set rows(value: number) { stdout.rows = value; },
    push(text: string) { input.emit("data", text); },
    since(mark: number) { return chunks.slice(mark).join(""); },
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 5_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
