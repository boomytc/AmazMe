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
    let failure: string | undefined;
    if (options.prompt) {
      const admitted = await lane.accept({ kind: "prompt", text: options.prompt });
      let outcome = await lane.drive(admitted.operationId, { waitForRetry: true });
      if (outcome.kind === "waiting") outcome = await lane.drive(outcome.operationId, { waitForRetry: true });
      if (outcome.kind !== "settled" || outcome.result.status !== "completed") {
        failure = outcome.kind === "settled" ? (outcome.result.error ?? `model request ${outcome.result.status}`) : "model request did not finish";
      }
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
      process.stdout.write(`${JSON.stringify(jsonResult(snap.activity.usage))}\n`);
      if (failure) process.stdout.write(`${JSON.stringify({ type: "error", message: failure })}\n`);
    } else if (options.continueSession) {
      for (const line of lines) process.stdout.write(`${line.text}\n`);
    } else {
      const last = [...lines].reverse().find((line) => line.role === "assistant");
      if (last) process.stdout.write(`${last.text}\n`);
    }
    if (failure) throw new Error(failure);
  } finally {
    await client.dispose();
    await host.close();
  }
}

/**
 * `--json` 原先只有消息文本，底栏上的命中率和金额出不去。
 * 一次带缓存的回复，活动里本轮 hitRate 是 0.4、cost.total 是算好的美元；没报缓存或没价目时这两项是 null，不能印成 0，也不能省掉字段。
 * 本轮和累计直接抄快照 `activity.usage`，和画面用的是同一份数。这里不调用 `cacheHitRate` 或 `usageCost`。
 */
function jsonResult(usage: {
  lastTurn: { hitRate: number | null; cost: { total: number | null } | null } | null;
  total: { hitRate: number | null; cost: { total: number | null } | null };
}): {
  type: "result";
  lastTurn: { usage: { hitRate: number | null }; cost: { total: number | null } };
  total: { usage: { hitRate: number | null }; cost: { total: number | null } };
} {
  const turn = usage.lastTurn;
  const total = usage.total;
  return {
    type: "result",
    lastTurn: {
      usage: { hitRate: turn?.hitRate ?? null },
      cost: { total: turn?.cost?.total ?? null },
    },
    total: {
      usage: { hitRate: total.hitRate ?? null },
      cost: { total: total.cost?.total ?? null },
    },
  };
}
