import type { LaneUsage } from "@amazme/durable";
import type { ActivityDto, CumulativeCostDto, TotalUsageDto, TurnUsageDto, UsageCostDto } from "./contracts.ts";

/**
 * Copy `usage().lastTurn` and `usage().total`.
 * `hitRate`, `cost`, and `reasoning` are the values Durable already stored. This does not call `cacheHitRate` or `usageCost`.
 * `contextTokens` and `compactionThreshold` stay off the protocol object. `reasoning` stays `number | null` and is not added into `output`.
 */
export function projectLaneUsage(usage: Pick<LaneUsage, "lastTurn" | "total">): ActivityDto["usage"] {
  return {
    lastTurn: usage.lastTurn ? projectTurn(usage.lastTurn) : null,
    total: projectTotal(usage.total),
  };
}

function projectTurn(row: NonNullable<LaneUsage["lastTurn"]>): TurnUsageDto {
  return {
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    reasoning: row.reasoning,
    hitRate: row.hitRate,
    cost: copyTurnCost(row.cost),
  };
}

function projectTotal(row: LaneUsage["total"]): TotalUsageDto {
  return {
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    reasoning: row.reasoning,
    hitRate: row.hitRate,
    cost: copyTotalCost(row.cost),
  };
}

function copyTurnCost(cost: UsageCostDto | null): UsageCostDto | null {
  if (!cost) return null;
  return {
    input: cost.input,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    output: cost.output,
    total: cost.total,
  };
}

function copyTotalCost(cost: CumulativeCostDto | null): CumulativeCostDto | null {
  if (!cost) return null;
  return {
    input: cost.input,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    output: cost.output,
    total: cost.total,
  };
}
