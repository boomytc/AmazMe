import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import type { EntryDto, LaneSnapshotDto } from "@amazme/runtime-service";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { renderGuiDocument, type GuiView } from "./document.ts";

export interface GuiSessionOptions {
  socket: string;
  serverId: string;
  runtimeId: string;
  lane: string;
  onView(view: GuiView, document: string): void;
}

export interface GuiSession {
  submit(text: string): Promise<void>;
  close(): Promise<void>;
}

/** Attach to one host lane. Closing this client does not close the host. */
export async function runGuiSession(options: GuiSessionOptions): Promise<GuiSession> {
  const client = new Client({ serverId: options.serverId, transport: createUnixTransport({ path: options.socket }) });
  await client.connect();
  const remote = new RuntimeClient(client);
  await remote.attach(options.runtimeId);
  const lane = remote.lane(options.lane);
  let chrome = { provider: "", modelId: "", thinking: "", directory: "" };
  const publish = (snapshot: LaneSnapshotDto): void => {
    const view = viewFrom(snapshot, chrome);
    options.onView(view, renderGuiDocument(view));
  };
  const subscription = await lane.subscribe(publish);
  try {
    const settings = await lane.configure();
    const listed = await lane.catalog();
    chrome = { provider: settings.provider, modelId: settings.modelId, thinking: settings.thinkingLevel, directory: listed.directory };
  } catch {
    // The status line stays empty until the lane can report settings.
  }
  publish(subscription.current());
  return {
    async submit(text: string): Promise<void> {
      const current = await lane.snapshot();
      if (current.operationId) {
        await lane.followUp(text);
        return;
      }
      const admitted = await lane.accept({ kind: "prompt", text });
      const outcome = await lane.drive(admitted.operationId, { waitForRetry: true });
      if (outcome.kind === "waiting") await lane.drive(outcome.operationId, { waitForRetry: true });
      publish(await lane.snapshot());
    },
    async close(): Promise<void> {
      await subscription.close();
      await client.dispose();
    },
  };
}

function viewFrom(snapshot: LaneSnapshotDto, chrome: { provider: string; modelId: string; thinking: string; directory: string }): GuiView {
  return {
    entries: snapshot.entries.map(entryView),
    pendingText: pendingText(snapshot),
    tools: snapshot.tools.map((tool) => ({ name: tool.name, status: tool.status })),
    directory: chrome.directory,
    active: snapshot.lane,
    provider: chrome.provider,
    modelId: chrome.modelId,
    thinking: chrome.thinking,
    busy: snapshot.operationId !== null,
  };
}

function entryView(entry: EntryDto): { role: string; text: string; title?: string } {
  if (entry.payload.type === "compaction") return { role: "summary", text: entry.payload.summary };
  const message = entry.payload.message as { role: string; content?: unknown; toolName?: string };
  const title = message.role === "toolResult" && typeof message.toolName === "string" ? message.toolName : undefined;
  return { role: message.role, text: messageText(message), ...(title ? { title } : {}) };
}

function pendingText(snapshot: LaneSnapshotDto): string {
  const pending = snapshot.pendingResponse;
  if (!pending) return "";
  return pending.content.map((block) => {
    const text = (block as { text?: unknown }).text;
    return block.type === "text" && typeof text === "string" ? text : "";
  }).join("");
}

function messageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const record = block as { type?: string; text?: string };
    return record.type === "text" && typeof record.text === "string" ? record.text : "";
  }).join("");
}
