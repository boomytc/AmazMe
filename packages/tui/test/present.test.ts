import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import type { JsonValue } from "@amazme/protocol";
import { Server, ServiceError, type RuntimeCallContext, type RuntimeHandle, type RuntimeService, type SubscriptionSink } from "@amazme/server";
import { listenUnix } from "@amazme/server/unix";
import { emptyTui, presentHost, reduceTui, type TuiWindow } from "@amazme/tui";

const LANE = "main";

test("present parks the cursor on one line, many lines, and CJK", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-cursor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await fakeHost(join(dir, "host.sock"));
  t.after(() => host.close());
  const tty = fakeTTY();
  tty.columns = 80;
  tty.rows = 24;
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE },
    tty.stdin,
    tty.stdout,
  );
  try {
    await until(() => tty.since(0).includes("空闲"), "the first paint");
    tty.push("hi");
    assert.equal(tty.chunks.at(-1), "\x1b[23;6H");
    tty.push("\u0003");
    tty.push("ab\x1b\rcd");
    tty.push("\x1b[A");
    assert.equal(tty.chunks.at(-1), "\x1b[22;6H");
    tty.push("\u0003");
    tty.push("中文");
    assert.equal(tty.chunks.at(-1), "\x1b[23;8H");
    tty.push("\u0003");
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u0004");
    await Promise.race([
      screen.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\npaint=${tty.chunks.at(-1)}`);
  }
});

test("typing fills the composer and enter submits", () => {
  let state = emptyTui();
  state = reduceTui(state, { type: "key", key: { type: "char", value: "h" } }).state;
  state = reduceTui(state, { type: "key", key: { type: "char", value: "i" } }).state;
  assert.equal(state.input, "hi");
  assert.equal(state.cursor, 2);
  const submitted = reduceTui(state, { type: "key", key: { type: "enter" } });
  assert.deepEqual(submitted.effect, { type: "submit", text: "hi" });
  assert.equal(submitted.state.input, "");
});

test("a busy composer still submits, and ctrl-c asks to abort", () => {
  const busy = reduceTui(emptyTui(), { type: "window", window: window({ busy: true }) }).state;
  assert.equal(reduceTui(busy, { type: "key", key: { type: "enter" } }).effect, null);
  let typing = busy;
  for (const value of ["n", "e", "x", "t"]) {
    typing = reduceTui(typing, { type: "key", key: { type: "char", value } }).state;
  }
  const follow = reduceTui(typing, { type: "key", key: { type: "enter" } });
  assert.deepEqual(follow.effect, { type: "submit", text: "next" });
  const aborted = reduceTui(busy, { type: "key", key: { type: "ctrl-c" } });
  assert.deepEqual(aborted.effect, { type: "abort" });
  assert.equal(aborted.state.exitArmed, false);
});

test("the attached screen submits, follows up while busy, aborts, and redraws on resize", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amz-tui-present-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await fakeHost(join(dir, "host.sock"));
  t.after(() => host.close());
  const tty = fakeTTY();
  const screen = presentHost(
    { socket: host.path, serverId: "tui-test", runtimeId: "main", lane: LANE },
    tty.stdin,
    tty.stdout,
  );
  try {
    await until(() => tty.since(0).includes("空闲"), "the first paint");
    tty.push("hi");
    await until(() => tty.since(0).includes("hi"), "the typed composer");
    tty.push("\r");
    await until(() => host.calls.some((call) => call.method === "accept" && call.text === "hi"), "the idle submit");
    await until(() => host.calls.some((call) => call.method === "drive"), "the drive after submit");
    const beforeBusy = tty.chunks.length;
    await host.hold("op-live");
    await until(() => tty.since(beforeBusy).includes("忙"), "the busy status");
    tty.push("later");
    await until(() => tty.since(beforeBusy).includes("later"), "the follow-up draft");
    tty.push("\r");
    await until(() => host.calls.some((call) => call.method === "followUp" && call.text === "later"), "followUp while an operation is open");
    await until(() => tty.since(beforeBusy).includes("排队 1"), "queued follow-up count");
    assert.equal(host.calls.filter((call) => call.method === "accept").length, 1);
    tty.push("\u0003");
    await until(() => host.calls.some((call) => call.method === "requestAbort" && call.operationId === "op-live"), "requestAbort");
    const beforeIdle = tty.chunks.length;
    await host.release();
    await until(() => tty.since(beforeIdle).includes("空闲"), "idle after the operation leaves");
    const beforeResize = tty.chunks.length;
    tty.columns = 20;
    tty.rows = 10;
    tty.emitResize();
    await until(() => tty.chunks.length > beforeResize, "a redraw after resize");
    const redraw = tty.since(beforeResize);
    assert.match(redraw, /─{20}/);
    assert.equal(redraw.includes("─".repeat(80)), false);
    tty.push("\u0004");
    await screen;
  } catch (error) {
    tty.push("\u0004");
    await Promise.race([
      screen.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\ncalls=${JSON.stringify(host.calls)}\npaint=${tty.chunks.join("")}`);
  }
});

function window(partial: Partial<TuiWindow>): TuiWindow {
  return {
    entries: [],
    pendingText: "",
    tools: [],
    busy: false,
    sessions: [LANE],
    active: LANE,
    ...partial,
  };
}

type Recorded =
  | { method: "accept"; text: string }
  | { method: "drive"; operationId: string }
  | { method: "followUp"; text: string }
  | { method: "requestAbort"; operationId: string };

async function fakeHost(socket: string) {
  const calls: Recorded[] = [];
  let version = 1;
  let operationId: string | null = null;
  let sink: SubscriptionSink | undefined;
  const view = () => ({
    version,
    lane: LANE,
    tipId: null,
    phase: operationId ? "assistant_ready" as const : null,
    operationId,
    lastOperationId: null,
    status: operationId ? "open" as const : null,
    entries: [],
    pendingResponse: null,
    tools: [],
    omitted: 0,
    skipped: 0,
    pendingOmitted: false,
  });
  const publish = async (): Promise<void> => {
    if (!sink || sink.closed) return;
    await sink.send({ kind: "advance", advance: view() });
  };
  const commit = async (next: string | null): Promise<void> => {
    version += 1;
    operationId = next;
    await publish();
  };
  const service: RuntimeService = {
    async call(raw: JsonValue, context: RuntimeCallContext): Promise<JsonValue | undefined> {
      if (!isObject(raw) || typeof raw.method !== "string") throw new ServiceError("invalid_call", "invalid runtime call");
      switch (raw.method) {
        case "subscribe": {
          if (typeof raw.subscriptionId !== "string") throw new ServiceError("invalid_call", "missing subscription");
          sink = context.openSubscription(raw.subscriptionId);
          return view();
        }
        case "unsubscribe":
          sink?.close();
          sink = undefined;
          return null;
        case "configure":
          return { provider: "faux", modelId: "faux-1", thinkingLevel: "off", thinkingLevels: ["off"] };
        case "catalog":
          return { directory: "work", models: [], thinkingLevels: ["off"] };
        case "snapshot":
          return {
            version,
            lane: LANE,
            tipId: null,
            phase: operationId ? "assistant_ready" : null,
            operationId,
            lastOperationId: null,
            status: operationId ? "open" : null,
            entries: [],
            pendingResponse: null,
            tools: [],
          };
        case "accept": {
          const request = raw.request;
          const text = isObject(request) && typeof request.text === "string" ? request.text : "";
          calls.push({ method: "accept", text });
          await commit("op-1");
          return { operationId: "op-1", kind: "run", startedAt: 1 };
        }
        case "drive": {
          const id = typeof raw.operationId === "string" ? raw.operationId : "";
          calls.push({ method: "drive", operationId: id });
          await commit(null);
          return {
            kind: "settled",
            result: {
              operationId: id,
              lane: LANE,
              kind: "run",
              status: "completed",
              fromTipId: null,
              tipId: null,
              startedAt: 1,
              endedAt: 2,
            },
          };
        }
        case "followUp": {
          const text = typeof raw.text === "string" ? raw.text : "";
          calls.push({ method: "followUp", text });
          return { entryId: "follow-1" };
        }
        case "requestAbort": {
          const id = typeof raw.operationId === "string" ? raw.operationId : "";
          calls.push({ method: "requestAbort", operationId: id });
          return { operationId: id, newlyRequested: true };
        }
        default:
          throw new ServiceError("invalid_call", `unexpected ${raw.method}`);
      }
    },
  };
  const handle: RuntimeHandle = {
    acquire: () => ({ service, release() {} }),
    close: () => Promise.resolve(),
    idle: () => true,
  };
  const errors: Error[] = [];
  const server = new Server({
    serverId: "tui-test",
    onError: (error) => errors.push(error),
    service: {
      async call(raw, context) {
        if (!isObject(raw) || raw.method !== "attach" || raw.runtimeId !== "main") {
          throw new ServiceError("invalid_call", "attach main only");
        }
        await context.attach("main");
        return { attached: true };
      },
    },
    openRuntime(runtimeId) {
      return Promise.resolve(runtimeId === "main" ? handle : null);
    },
  });
  const listener = await listenUnix(server, { path: socket, onError: (error) => errors.push(error) });
  return {
    path: socket,
    calls,
    errors,
    hold: (id: string) => commit(id),
    release: () => commit(null),
    close: async () => {
      await server.close();
      await listener.close();
    },
  };
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    emitResize() { output.emit("resize"); },
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
