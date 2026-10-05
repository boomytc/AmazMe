import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import { createAssistantEventStream, createModels, createProvider, supportedThinkingLevels, type Model, type ThinkingLevel } from "@amazme/ai";
import { deepseekProvider } from "@amazme/ai/providers/deepseek";
import { AgentHarness } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import type { RemoteLane } from "@amazme/runtime-service/client";
import { createManagementService, openOwnedRuntimes } from "@amazme/runtime-service/server";
import { Server } from "@amazme/server";
import { listenUnix } from "@amazme/server/unix";
import { executeSlash, parseSlash, presentHost, type SlashActions, type SlashThinking } from "@amazme/tui";

const LANE = "main";
const FLASH_LEVELS = ["off", "low", "high"] as const;
const PRO_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

test("a known thinking level the model omits is not an unknown name and is not configured", async () => {
  assert.deepEqual(parseSlash("/thinking medium"), { type: "thinking", level: "medium" });
  assert.deepEqual(parseSlash("/thinking medim"), { type: "thinking", invalid: true });
  assert.deepEqual(parseSlash("/thinking foo"), { type: "thinking", invalid: true });
  assert.deepEqual(parseSlash("/effort medium"), { type: "thinking", level: "medium" });

  const flash = scriptedLane({ thinkingLevel: "low", thinkingLevels: FLASH_LEVELS });
  const unsupported = await executeSlash({ type: "thinking", level: "medium" }, flash.actions);
  assert.equal(unsupported.type, "notice");
  if (unsupported.type === "notice") assert.equal(unsupported.text, "当前模型不支持 medium。可用 off low high");
  assert.deepEqual(flash.calls, [{}]);

  const misspelled = parseSlash("/thinking medim");
  assert.equal(misspelled.type, "thinking");
  if (misspelled.type !== "thinking") return;
  const unknown = await executeSlash(misspelled, flash.actions);
  assert.equal(unknown.type, "notice");
  if (unknown.type === "notice") {
    assert.equal(unknown.text, "未知思考级别。可用 off low high");
    assert.equal(unknown.text.includes("当前模型不支持"), false);
  }
  const foo = parseSlash("/thinking foo");
  assert.equal(foo.type, "thinking");
  if (foo.type !== "thinking") return;
  const alsoUnknown = await executeSlash(foo, flash.actions);
  assert.equal(alsoUnknown.type, "notice");
  if (alsoUnknown.type === "notice") assert.match(alsoUnknown.text, /^未知思考级别/);
  assert.deepEqual(flash.calls, [{}, {}, {}]);

  const applied = await executeSlash({ type: "thinking", level: "high" }, flash.actions);
  assert.equal(applied.type, "notice");
  if (applied.type === "notice") assert.equal(applied.text, "思考 high");
  assert.deepEqual(flash.calls.at(-1), { thinkingLevel: "high" });
});

test("a rejected model switch names /thinking and does not write another level", async () => {
  const lane = scriptedLane({
    modelId: "deepseek-v4-pro",
    thinkingLevel: "medium",
    thinkingLevels: PRO_LEVELS,
    rejectModelId: "deepseek-flash",
  });
  const refused = await executeSlash({ type: "model", provider: "deepseek", modelId: "deepseek-flash" }, lane.actions);
  assert.equal(refused.type, "notice");
  if (refused.type === "notice") {
    assert.equal(refused.text, "无法切换到 deepseek/deepseek-flash。先用 /thinking 切到 off/low/high");
  }
  assert.deepEqual(lane.calls, [{ provider: "deepseek", modelId: "deepseek-flash" }]);
  assert.equal(lane.modelId, "deepseek-v4-pro");
  assert.equal(lane.thinkingLevel, "medium");

  const other = scriptedLane({
    modelId: "deepseek-v4-pro",
    thinkingLevel: "medium",
    thinkingLevels: PRO_LEVELS,
    rejectMessage: "unknown model deepseek/missing",
  });
  const raw = await executeSlash({ type: "model", provider: "deepseek", modelId: "missing" }, other.actions);
  assert.equal(raw.type, "notice");
  if (raw.type === "notice") assert.equal(raw.text, "unknown model deepseek/missing");
});

test("switching to flash while thinking is medium is rejected and the lane stays put", { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-flash-switch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await openHarness(join(dir, "host.sock"));
  t.after(() => host.close());
  const tty = fakeTTY();
  tty.columns = 120;
  tty.rows = 32;
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE },
    tty.stdin,
    tty.stdout,
  );
  try {
    await until(() => tty.since(0).includes("fixture/all-levels") && tty.since(0).includes("medium"), "the fixture footer");
    const rejected = tty.chunks.length;
    tty.push("/model deepseek/deepseek-flash\r");
    await until(() => tty.since(rejected).includes("先用 /thinking 切到 off/low/high"), "the refusal");
    assert.equal(tty.since(rejected).includes("模型 deepseek/deepseek-flash"), false);
    const kept = await host.harness.lane(LANE).configure();
    assert.equal(kept.ok, true);
    if (!kept.ok) return;
    assert.equal(kept.value.provider, "fixture");
    assert.equal(kept.value.modelId, "all-levels");
    assert.equal(kept.value.thinkingLevel, "medium");
    const session = tty.chunks.length;
    tty.push("/session\r");
    await until(() => tty.since(session).includes("模型 fixture/all-levels 思考 medium"), "the session still on the fixture");

    const lowered = tty.chunks.length;
    tty.push("/thinking low\r");
    await until(() => tty.since(lowered).includes("思考 low"), "the user lowered thinking");
    const switched = tty.chunks.length;
    tty.push("/model deepseek/deepseek-flash\r");
    await until(() => tty.since(switched).includes("模型 deepseek/deepseek-flash 思考 low"), "flash after a supported level");
    const blocked = tty.chunks.length;
    tty.push("/thinking medium\r");
    await until(() => tty.since(blocked).includes("当前模型不支持 medium。可用 off low high"), "flash rejects medium");
    const typo = tty.chunks.length;
    tty.push("/thinking medim\r");
    await until(() => tty.since(typo).includes("未知思考级别。可用 off low high"), "a typo stays unknown");
    assert.equal(tty.since(typo).includes("当前模型不支持"), false);
    const after = await host.harness.lane(LANE).configure();
    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.equal(after.value.modelId, "deepseek-flash");
    assert.equal(after.value.thinkingLevel, "low");
    assert.deepEqual(after.value.thinkingLevels, ["off", "low", "high"]);
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

function scriptedLane(options: {
  modelId?: string;
  thinkingLevel: SlashThinking;
  thinkingLevels: readonly SlashThinking[];
  rejectModelId?: string;
  rejectMessage?: string;
}) {
  const calls: Array<Record<string, string>> = [];
  let modelId = options.modelId ?? "deepseek-flash";
  let thinkingLevel = options.thinkingLevel;
  const remote = {
    async configure(patch: { provider?: string; modelId?: string; thinkingLevel?: SlashThinking } = {}) {
      const recorded: Record<string, string> = {};
      if (patch.provider !== undefined) recorded.provider = patch.provider;
      if (patch.modelId !== undefined) recorded.modelId = patch.modelId;
      if (patch.thinkingLevel !== undefined) recorded.thinkingLevel = patch.thinkingLevel;
      calls.push(recorded);
      if (patch.modelId !== undefined && (options.rejectModelId === patch.modelId || options.rejectMessage)) {
        throw new Error(options.rejectMessage ?? `thinking level ${thinkingLevel} is not supported; available: off, low, high`);
      }
      if (patch.provider !== undefined && patch.modelId !== undefined) modelId = patch.modelId;
      if (patch.thinkingLevel !== undefined) {
        if (!options.thinkingLevels.includes(patch.thinkingLevel)) throw new Error("configured an unsupported level");
        thinkingLevel = patch.thinkingLevel;
      }
      return { provider: "deepseek", modelId, thinkingLevel, thinkingLevels: [...options.thinkingLevels] };
    },
  } as unknown as RemoteLane;
  const actions: SlashActions = {
    lane: () => remote,
    active: () => LANE,
    list: async () => [LANE],
    open: async () => undefined,
    earlier: async () => "",
    continueRetry: async () => "",
  };
  return {
    actions,
    calls,
    get modelId() { return modelId; },
    get thinkingLevel() { return thinkingLevel; },
  };
}

/** 协议里的每一档。缺一档这里就编不过，不跟目录里的 v4-pro 走。 */
const PROTOCOL_LEVELS = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
} as const satisfies Record<ThinkingLevel, string>;

function allLevelsModel(): Model {
  return {
    id: "all-levels",
    name: "All levels",
    provider: "fixture",
    api: "faux",
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    reasoning: true,
    thinkingLevelMap: PROTOCOL_LEVELS,
  };
}

async function openHarness(socket: string) {
  const wide = allLevelsModel();
  assert.deepEqual(supportedThinkingLevels(wide), Object.keys(PROTOCOL_LEVELS));
  const models = createModels();
  models.setProvider(createProvider({
    id: "fixture",
    auth: { env: "FIXTURE_KEY", ambient: "test" },
    models: [wide],
    api: {
      stream() { return createAssistantEventStream(); },
      streamSimple() { return createAssistantEventStream(); },
    },
  }));
  models.setProvider(deepseekProvider());
  const storage = new MemoryStorage();
  const harness = new AgentHarness(storage, {
    models,
    model: { provider: "fixture", modelId: "all-levels" },
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
