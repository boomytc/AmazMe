import type { ReadStream, WriteStream } from "node:tty";
import { StringDecoder } from "node:string_decoder";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import type { EntryDto, LaneSnapshotDto } from "@amazme/runtime-service";
import { RuntimeClient, type RemoteLane } from "@amazme/runtime-service/client";
import { KeyDecoder } from "./keys.ts";
import { emptyTui, reduceTui, renderTui, type TuiEffect, type TuiEntry, type TuiWindow } from "./reduce.ts";

export interface HostAttach {
  socket: string;
  serverId: string;
  runtimeId: string;
  lane: string;
}

/** Read one rendered frame. The host keeps the runtime. */
export async function readHostFrame(attach: HostAttach, lane = attach.lane): Promise<string> {
  const client = new Client({ serverId: attach.serverId, transport: createUnixTransport({ path: attach.socket }) });
  await client.connect();
  try {
    const remote = new RuntimeClient(client);
    await remote.attach(attach.runtimeId);
    const snapshot = await remote.lane(lane).snapshot();
    return renderTui({ ...emptyTui(lane), ...windowFrom(snapshot, [lane], lane) });
  } finally {
    await client.dispose();
  }
}

/** Raw-mode screen. Ctrl+D on an empty idle prompt leaves. */
export async function presentHost(
  attach: HostAttach,
  stdin: ReadStream = process.stdin,
  stdout: WriteStream = process.stdout,
): Promise<void> {
  if (typeof stdin.setRawMode !== "function" || stdin.isTTY !== true || stdout.isTTY !== true) {
    throw new Error("fullscreen requires a terminal");
  }
  const client = new Client({ serverId: attach.serverId, transport: createUnixTransport({ path: attach.socket }) });
  await client.connect();
  const remote = new RuntimeClient(client);
  await remote.attach(attach.runtimeId);
  const sessions = [attach.lane];
  let active = attach.lane;
  let state = emptyTui(active);
  let paint = (): void => undefined;
  let lane = new AttachedLane(remote.lane(active), () => {
    state = reduceTui(state, { type: "window", window: windowFrom(lane.snapshot(), sessions, active) }).state;
    paint();
  });
  await lane.open();
  state = reduceTui(state, { type: "window", window: windowFrom(lane.snapshot(), sessions, active) }).state;
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?1049h\x1b[?25h");
  const keys = new KeyDecoder();
  const utf8 = new StringDecoder("utf8");
  let restored = false;
  let finish = (): void => undefined;
  paint = () => {
    stdout.write(`\x1b[H\x1b[J${renderTui(state)}\n`);
  };
  const restore = (): void => {
    if (restored) return;
    restored = true;
    stdin.off("data", onData);
    if (stdin.isRaw) stdin.setRawMode(false);
    stdout.write("\x1b[?1049l");
    stdin.pause();
    finish();
  };
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : utf8.write(chunk);
    for (const key of keys.push(text)) {
      if (key.type === "ctrl-d" && state.input.length === 0 && !state.busy) {
        restore();
        return;
      }
      const reduced = reduceTui(state, { type: "key", key });
      state = reduced.state;
      paint();
      if (reduced.effect) {
        void apply(reduced.effect).catch((error: unknown) => {
          state = { ...state, notice: error instanceof Error ? error.message : String(error) };
          paint();
        });
      }
    }
  };
  const apply = async (effect: TuiEffect): Promise<void> => {
    if (effect.type === "submit") await lane.submit(effect.text);
    else if (effect.type === "abort") await lane.abort();
    else if (effect.type === "compact") {
      const admitted = await remote.lane(active).accept({ kind: "compaction" });
      await remote.lane(active).drive(admitted.operationId, { waitForRetry: true });
    } else if (effect.type === "new-session" || effect.type === "resume") {
      const name = effect.type === "new-session" ? `s${sessions.length + 1}` : effect.name;
      if (!sessions.includes(name)) sessions.push(name);
      await lane.close();
      active = name;
      lane = new AttachedLane(remote.lane(active), () => {
        state = reduceTui(state, { type: "window", window: windowFrom(lane.snapshot(), sessions, active) }).state;
        paint();
      });
      await lane.open();
      state = reduceTui(state, { type: "window", window: windowFrom(lane.snapshot(), sessions, active) }).state;
      paint();
    }
  };
  stdin.on("data", onData);
  paint();
  await new Promise<void>((resolve) => {
    finish = resolve;
    stdin.on("end", restore);
  });
  await lane.close();
  await client.dispose();
}

/** One durable drive. A waiting outcome continues through the stored `notBefore`; a settled drive is not sent again. */
export async function finishDrive(lane: RemoteLane, operationId: string): Promise<void> {
  const outcome = await lane.drive(operationId, { waitForRetry: true });
  if (outcome.kind === "waiting") await lane.drive(outcome.operationId, { waitForRetry: true });
}

class AttachedLane {
  private subscription: { current(): LaneSnapshotDto; close(): Promise<void> } | undefined;
  private generation = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly lane: RemoteLane, private readonly onView: () => void) {}

  snapshot(): LaneSnapshotDto {
    return this.subscription?.current() ?? emptySnapshot(this.lane.name);
  }

  async open(): Promise<void> {
    this.subscription = await this.lane.subscribe(() => {
      this.generation += 1;
      this.onView();
      const waiting = this.waiters.splice(0);
      for (const wake of waiting) wake();
    });
    this.onView();
  }

  async close(): Promise<void> {
    await this.subscription?.close();
  }

  async submit(text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const operationId = this.snapshot().operationId;
    if (operationId) {
      await this.lane.followUp(body);
      return;
    }
    const admitted = await this.lane.accept({ kind: "prompt", text: body });
    const started = this.snapshot().version;
    await finishDrive(this.lane, admitted.operationId);
    await this.untilLeft(admitted.operationId, started);
  }

  async abort(): Promise<void> {
    const operationId = this.snapshot().operationId;
    if (operationId) await this.lane.requestAbort(operationId);
  }

  private async untilLeft(operationId: string, started: number): Promise<void> {
    while (true) {
      const snap = this.snapshot();
      if (snap.version > started && snap.operationId !== operationId) return;
      const seen = this.generation;
      await new Promise<void>((resolve) => {
        if (this.generation !== seen || (this.snapshot().version > started && this.snapshot().operationId !== operationId)) {
          resolve();
          return;
        }
        this.waiters.push(resolve);
      });
    }
  }
}

function windowFrom(snapshot: LaneSnapshotDto, sessions: string[], active: string): TuiWindow {
  return {
    entries: snapshot.entries.map(entryView),
    pendingText: pendingText(snapshot),
    tools: snapshot.tools.map((tool) => ({ name: tool.name, status: tool.status })),
    busy: snapshot.operationId !== null,
    sessions,
    active,
  };
}

function entryView(entry: EntryDto): TuiEntry {
  if (entry.payload.type === "compaction") return { id: entry.id, role: "other", text: entry.payload.summary };
  const message = entry.payload.message;
  const role = message.role === "user" || message.role === "assistant" || message.role === "toolResult"
    ? (message.role === "toolResult" ? "tool" : message.role)
    : "other";
  return { id: entry.id, role, text: messageText(message) };
}

function pendingText(snapshot: LaneSnapshotDto): string {
  const pending = snapshot.pendingResponse;
  if (!pending) return "";
  return pending.content.map((block) => {
    const text = (block as { text?: unknown }).text;
    return block.type === "text" && typeof text === "string" ? text : "";
  }).join("");
}

function messageText(message: { role: string; content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const record = block as { type?: string; text?: string; name?: string };
    if (record.type === "text" && typeof record.text === "string") return record.text;
    if (record.type === "toolCall" && typeof record.name === "string") return record.name;
    return "";
  }).join("");
}

function emptySnapshot(lane: string): LaneSnapshotDto {
  return {
    version: 0,
    lane,
    tipId: null,
    phase: null,
    operationId: null,
    lastOperationId: null,
    status: null,
    entries: [],
    pendingResponse: null,
    tools: [],
  };
}
