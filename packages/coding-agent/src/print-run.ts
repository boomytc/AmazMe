import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import type { AssistantEventStream, Context, Model, StreamOptions } from "@amazme/ai";
import { activateProject } from "@amazme/tui";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { HOST_RUNTIME_ID, HOST_SERVER_ID, startCodingHost } from "./host.ts";

interface PrintModels {
  getModel(providerId: string, modelId: string): Model | undefined;
  streamSimple(model: Model, context: Context, options?: StreamOptions): AssistantEventStream;
  listModels?(): readonly { provider: string; id: string }[];
}

export interface PrintRunOptions {
  cwd: string;
  provider: string;
  model: string;
  models: PrintModels;
  prompt: string;
  /** Print the existing transcript. A prompt is still appended when present. */
  continueSession: boolean;
  json: boolean;
  lane?: string;
}

/** One prompt, or a continue, against the workspace host. Print and the fullscreen host share that log. */
export async function runPrint(options: PrintRunOptions): Promise<void> {
  await activateProject(options.cwd);
  const socket = join(mkdtempSync(join(tmpdir(), "amazme-print-")), `s-${randomBytes(3).toString("hex")}.sock`);
  const host = await startCodingHost({
    cwd: options.cwd,
    socket,
    provider: options.provider,
    model: options.model,
    models: options.models,
  });
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  try {
    await client.connect();
    const remote = new RuntimeClient(client);
    await remote.attach(HOST_RUNTIME_ID);
    const lane = remote.lane(options.lane ?? "main");
    if (options.prompt) {
      const admitted = await lane.accept({ kind: "prompt", text: options.prompt });
      const outcome = await lane.drive(admitted.operationId, { waitForRetry: true });
      if (outcome.kind === "waiting") await lane.drive(outcome.operationId, { waitForRetry: true });
    }
    const snap = await lane.snapshot();
    const lines = snap.entries.flatMap((entry) => {
      if (entry.payload.type !== "message") return [];
      const message = entry.payload.message as { role?: string; content?: unknown };
      const role = message.role;
      const text = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((block) => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "").join("")
          : "";
      return text.length > 0 ? [{ role, text }] : [];
    });
    if (options.json) {
      for (const line of lines) process.stdout.write(`${JSON.stringify({ type: "message", role: line.role, text: line.text })}\n`);
      return;
    }
    if (options.continueSession) {
      for (const line of lines) process.stdout.write(`${line.text}\n`);
      return;
    }
    const last = [...lines].reverse().find((line) => line.role === "assistant");
    if (last) process.stdout.write(`${last.text}\n`);
  } finally {
    await client.dispose();
    await host.close();
  }
}
