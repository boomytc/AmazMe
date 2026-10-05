import type { ActivityDto, CumulativeCostDto, TotalUsageDto, TurnUsageDto, UsageCostDto } from "./contracts.ts";

/**
 * Counts `usage()` already stores, plus the fields U2 adds on each of `lastTurn` and `total`:
 * `hitRate` and `cost`. `cost` on a turn is `usageCost`'s return value.
 * On the cumulative row every charge may be null. `reasoning` is optional and already inside `output`.
 */
interface RatedUsage {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning?: number;
  hitRate?: number | null;
  cost?: unknown;
}

/**
 * `laneStatus()` once Durable exports it.
 * An approval wait is not a retry: `retryReason` is null then. Approvals stay on `pendingApprovals()`.
 */
export interface LaneStatusRead {
  notBefore: number | null;
  retryReason: string | null;
  compacting: boolean;
}

interface LaneStatusSource {
  laneStatus?: () => Promise<LaneStatusRead>;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function copyRate(value: unknown): number | null {
  if (value == null) return null;
  return finite(value) ? value : null;
}

function copyReasoning(value: unknown): number | undefined {
  return finite(value) ? value : undefined;
}

/** Copy a turn charge. A missing or partial object stays null instead of being priced here. */
function copyTurnCost(value: unknown): UsageCostDto | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!finite(row.input) || !finite(row.cacheWrite) || !finite(row.output)) return null;
  if (!(finite(row.cacheRead) || row.cacheRead === null)) return null;
  if (!(finite(row.total) || row.total === null)) return null;
  return {
    input: row.input,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    output: row.output,
    total: row.total,
  };
}

/** Copy a cumulative charge. Each field may be null. Missing fields stay null on the whole object. */
function copyTotalCost(value: unknown): CumulativeCostDto | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const read = (key: string): number | null | undefined => {
    const item = row[key];
    if (item === null) return null;
    if (finite(item)) return item;
    return undefined;
  };
  const input = read("input");
  const cacheRead = read("cacheRead");
  const cacheWrite = read("cacheWrite");
  const output = read("output");
  const total = read("total");
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined || output === undefined || total === undefined) {
    return null;
  }
  return { input, cacheRead, cacheWrite, output, total };
}

function projectTurn(row: RatedUsage): TurnUsageDto {
  const reasoning = copyReasoning(row.reasoning);
  return {
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
    hitRate: copyRate(row.hitRate),
    cost: copyTurnCost(row.cost),
  };
}

function projectTotal(row: RatedUsage): TotalUsageDto {
  const reasoning = copyReasoning(row.reasoning);
  return {
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
    hitRate: copyRate(row.hitRate),
    cost: copyTotalCost(row.cost),
  };
}

/** Copy `usage()`. `contextTokens` and `compactionThreshold` stay off this object. */
export function projectLaneUsage(usage: { lastTurn: RatedUsage | null; total: RatedUsage }): ActivityDto["usage"] {
  return {
    lastTurn: usage.lastTurn ? projectTurn(usage.lastTurn) : null,
    total: projectTotal(usage.total),
  };
}

/**
 * Copy `laneStatus()`. Until Durable exports the method, there is no retry and no compaction.
 * This does not read `retry_wait` or summary phases itself.
 */
export async function readLaneStatus(lane: object): Promise<LaneStatusRead> {
  const read = (lane as LaneStatusSource).laneStatus;
  if (typeof read !== "function") return { notBefore: null, retryReason: null, compacting: false };
  const status = await read.call(lane);
  return {
    notBefore: finite(status?.notBefore) ? status.notBefore : null,
    retryReason: typeof status?.retryReason === "string" ? status.retryReason : null,
    compacting: status?.compacting === true,
  };
}
