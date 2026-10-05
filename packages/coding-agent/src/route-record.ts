import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SessionRouteEntry } from "./session.ts";

/** Sidecar beside the Durable workspace log. Lines use the same `route` shape as a session file. */
export function routeRecordFile(cwd: string): string {
  return join(resolve(cwd), ".amazme", "runtime", "route.jsonl");
}

export function readLatestRoute(cwd: string): SessionRouteEntry | undefined {
  let raw: string;
  try {
    raw = readFileSync(routeRecordFile(cwd), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let latest: SessionRouteEntry | undefined;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRoute(parsed)) continue;
    latest = parsed;
  }
  return latest;
}

export function writeRouteRecord(
  cwd: string,
  route: Omit<SessionRouteEntry, "type" | "timestamp"> & { timestamp?: string },
): SessionRouteEntry {
  const entry: SessionRouteEntry = {
    type: "route",
    timestamp: route.timestamp ?? new Date().toISOString(),
    provider: route.provider,
    modelId: route.modelId,
    ...(route.choice ? { choice: route.choice } : {}),
    ...(route.score !== undefined ? { score: route.score } : {}),
    ...(route.reason !== undefined ? { reason: route.reason } : {}),
    ...(route.usage ? { usage: route.usage } : {}),
  };
  const file = routeRecordFile(cwd);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

function isRoute(value: unknown): value is SessionRouteEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { type?: unknown; provider?: unknown; modelId?: unknown };
  return entry.type === "route" && typeof entry.provider === "string" && typeof entry.modelId === "string";
}
