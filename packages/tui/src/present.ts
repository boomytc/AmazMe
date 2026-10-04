import type { ReadStream, WriteStream } from "node:tty";
import { StringDecoder } from "node:string_decoder";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import type { EntryDto, LaneSnapshotDto } from "@amazme/runtime-service";
import { RuntimeClient, type RemoteLane } from "@amazme/runtime-service/client";
import { executeSlash, finishDrive, type SlashActions } from "./commands.ts";
import { KeyDecoder } from "./keys.ts";
import { emptyTui, reduceTui, renderTui, type TuiEffect, type TuiEntry, type TuiWindow } from "./reduce.ts";

export { finishDrive } from "./commands.ts";

export interface HostAccount {
  login(provider: string, handback: (text: string) => void): Promise<string>;
  logout(provider: string): Promise<string>;
}

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
  account?: HostAccount,
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
    state = reduceTui(state, { type: "window", window: windowFrom(lane.snapshot(), sessions, active, lane.earlier()) }).state;
    paint();
  });
  await lane.open();
  state = reduceTui(state, { type: "window", window: windowFrom(lane.snapshot(), sessions, active, lane.earlier()) }).state;
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
  const showLane = (): void => {
    state = reduceTui(state, { type: "window", window: windowFrom(lane.snapshot(), sessions, active, lane.earlier()) }).state;
    paint();
  };
  const actions: SlashActions = {
    lane: () => remote.lane(active),
    active: () => active,
    list: async () => {
      for (const name of await remote.conversations()) {
        if (!sessions.includes(name)) sessions.push(name);
      }
      return sessions;
    },
    open: async (name) => {
      if (!sessions.includes(name)) sessions.push(name);
      await lane.close();
      active = name;
      lane = new AttachedLane(remote.lane(active), showLane);
      await lane.open();
      showLane();
    },
    earlier: () => lane.loadEarlier(),
    continueRetry: async () => {
      const snap = await remote.lane(active).snapshot();
      if (snap.phase !== "retry_wait" || !snap.operationId) return "没有等待中的重试";
      await finishDrive(remote.lane(active), snap.operationId);
      return "已继续";
    },
    ...(account
      ? {
          login: async (provider: string) => {
            stdin.setRawMode(false);
            try {
              return await account.login(provider, (text) => {
                state = { ...state, notice: text };
                paint();
              });
            } finally {
              if (!restored && stdin.isRaw !== true) stdin.setRawMode(true);
            }
          },
          logout: (provider: string) => account.logout(provider),
        }
      : {}),
  };
  const apply = async (effect: TuiEffect): Promise<void> => {
    if (effect.type === "submit") await lane.submit(effect.text);
    else if (effect.type === "abort") await lane.abort();
    else {
      const outcome = await executeSlash(effect.command, actions);
      if (outcome.type === "notice") {
        state = { ...state, notice: outcome.text };
        paint();
      } else if (outcome.type === "quit") restore();
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

class AttachedLane {
  private subscription: { current(): LaneSnapshotDto; coverage(): { omitted: number; skipped: number }; close(): Promise<void> } | undefined;
  private generation = 0;
  private earlierEntries: TuiEntry[] = [];
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly lane: RemoteLane, private readonly onView: () => void) {}

  snapshot(): LaneSnapshotDto {
    return this.subscription?.current() ?? emptySnapshot(this.lane.name);
  }

  earlier(): TuiEntry[] {
    return this.earlierEntries;
  }

  async open(): Promise<void> {
    this.subscription = await this.lane.subscribe(() => {
      const coverage = this.subscription?.coverage();
      const snap = this.subscription?.current();
      const parent = snap?.entries[0]?.parentId ?? null;
      const tail = this.earlierEntries.at(-1)?.id;
      if ((coverage && coverage.omitted === 0 && coverage.skipped === 0) || (tail !== undefined && tail !== parent)) {
        this.earlierEntries = [];
      }
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

  async loadEarlier(): Promise<string> {
    const snap = this.snapshot();
    const oldest = this.earlierEntries[0]?.id ?? snap.entries[0]?.id;
    if (!oldest) return "没有更早的条目";
    const page = await this.lane.history(oldest, 20);
    const known = new Set([...this.earlierEntries.map((entry) => entry.id), ...snap.entries.map((entry) => entry.id)]);
    const added = page.entries.filter((entry) => !known.has(entry.id)).map(entryView);
    this.earlierEntries = [...added, ...this.earlierEntries];
    this.onView();
    return added.length === 0 ? "没有更早的条目" : `更早 ${added.length} 条`;
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

function windowFrom(snapshot: LaneSnapshotDto, sessions: string[], active: string, earlier: TuiEntry[] = []): TuiWindow {
  const seen = new Set(snapshot.entries.map((entry) => entry.id));
  return {
    entries: [...earlier.filter((entry) => !seen.has(entry.id)), ...snapshot.entries.map(entryView)],
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
