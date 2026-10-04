import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ReadStream, WriteStream } from "node:tty";
import { StringDecoder } from "node:string_decoder";
import { createModels, type Context } from "@amazme/ai";
import { fauxProvider } from "@amazme/ai/providers/faux";
import { builtinProviders } from "@amazme/ai/providers/builtin";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import type { EntryDto, LaneSnapshotDto } from "@amazme/runtime-service";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { FileCredentialStore } from "../credentials.ts";
import { LaneControl, type ControlView } from "../control.ts";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID, startCodingHost } from "../host.ts";
import { KeyDecoder } from "./keys.ts";
import { emptyTui, reduceTui, renderTui, type TuiEffect, type TuiEntry, type TuiState, type TuiWindow } from "./reduce.ts";
import type { FullscreenOptions } from "./run.ts";

/**
 * Foreground fullscreen. The view only attaches to the host socket.
 * The host process owns the session log, tools, and model calls.
 */
export async function runHostFullscreen(options: FullscreenOptions): Promise<void> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("fullscreen requires a terminal");
  }
  const models = openModels(options);
  const socket = join(options.cwd, ".amazme", "runtime", "host.sock");
  mkdirSync(join(options.cwd, ".amazme", "runtime"), { recursive: true });
  const host = await startCodingHost({
    cwd: options.cwd,
    socket,
    provider: options.provider,
    model: options.model,
    models,
  });
  try {
    await presentHost(socket);
  } finally {
    await host.close();
  }
}

/** One rendered frame from the host. The caller owns the socket and the runtime. */
export async function readHostFrame(socket: string, lane = HOST_LANE): Promise<string> {
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  await client.connect();
  try {
    const remote = new RuntimeClient(client);
    await remote.attach(HOST_RUNTIME_ID);
    const snapshot = await remote.lane(lane).snapshot();
    return renderTui({ ...emptyTui(lane), ...windowFrom(snapshot, [lane], lane) });
  } finally {
    await client.dispose();
  }
}

export async function presentHost(
  socket: string,
  stdin: ReadStream = process.stdin,
  stdout: WriteStream = process.stdout,
): Promise<void> {
  if (typeof stdin.setRawMode !== "function" || stdin.isTTY !== true || stdout.isTTY !== true) {
    throw new Error("fullscreen requires a terminal");
  }
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  await client.connect();
  const remote = new RuntimeClient(client);
  await remote.attach(HOST_RUNTIME_ID);
  const sessions = [HOST_LANE];
  let active = HOST_LANE;
  let state = emptyTui(active);
  let paint = (): void => undefined;
  let control = new LaneControl(remote.lane(active), (view) => {
    state = reduceTui(state, { type: "window", window: windowFromView(view, sessions, active) }).state;
    paint();
  });
  await control.open();
  state = reduceTui(state, { type: "window", window: windowFromView(control.view(), sessions, active) }).state;
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
        void applyEffect(reduced.effect).catch((error: unknown) => {
          state = { ...state, notice: error instanceof Error ? error.message : String(error) };
          paint();
        });
      }
    }
  };
  const applyEffect = async (effect: TuiEffect): Promise<void> => {
    if (effect.type === "submit") await control.submit(effect.text);
    else if (effect.type === "abort") await control.abort();
    else if (effect.type === "compact") {
      const admitted = await remote.lane(active).accept({ kind: "compaction" });
      await remote.lane(active).drive(admitted.operationId, { waitForRetry: true });
    } else if (effect.type === "new-session" || effect.type === "resume") {
      const name = effect.type === "new-session" ? `s${sessions.length + 1}` : effect.name;
      if (!sessions.includes(name)) sessions.push(name);
      await control.close();
      active = name;
      control = new LaneControl(remote.lane(active), (view) => {
        state = reduceTui(state, { type: "window", window: windowFromView(view, sessions, active) }).state;
        paint();
      });
      await control.open();
      state = reduceTui(state, { type: "window", window: windowFromView(control.view(), sessions, active) }).state;
      paint();
    }
  };
  stdin.on("data", onData);
  paint();
  await new Promise<void>((resolve) => {
    finish = resolve;
    stdin.on("end", restore);
  });
  await control.close();
  await client.dispose();
}

function windowFromView(view: ControlView, sessions: string[], active: string): TuiWindow {
  return windowFrom(view.snapshot, sessions, active);
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

function openModels(options: FullscreenOptions) {
  const models = createModels({ store: new FileCredentialStore(options.credentialsFile) });
  if (options.provider === "faux") {
    models.setProvider(fauxProvider({
      respond: (context, _streamOptions, _state, model) => ({
        role: "assistant",
        content: [{ type: "text", text: `faux:${lastUserText(context)}` }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    }));
  } else {
    const provider = builtinProviders().find((item) => item.id === options.provider);
    if (!provider) throw new Error(`unknown provider ${options.provider}`);
    models.setProvider(provider);
  }
  if (!models.getModel(options.provider, options.model)) {
    throw new Error(`unknown model ${options.provider}/${options.model}`);
  }
  return models;
}

function lastUserText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message && message.role === "user" && typeof message.content === "string") return message.content;
  }
  return "";
}

export type { TuiState };
