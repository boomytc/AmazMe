import type { Usage } from "./types.ts";

/**
 * USD for one turn. Rates on `Model.cost` are USD per 1,000,000 tokens.
 * These amounts are that rate times the token count, divided by 1,000,000, same as `Usage.cost`.
 */
export interface UsageCost {
  /** Cache-miss tokens times the input rate. */
  input: number;
  /**
   * Cache-read tokens times the cache-hit rate.
   * Null when those tokens are above 0 and the catalog has no hit price. A listed 0 stays 0.
   */
  cacheRead: number | null;
  /** Cache-write tokens times the cache-write rate, or the input rate when that rate is unset. */
  cacheWrite: number;
  /** Output tokens times the output rate. */
  output: number;
  /**
   * Sum of the four charges.
   * Null when `cacheRead` is null, so a missing hit price is not reported as a dollar total.
   */
  total: number | null;
}

/** Catalog rates and `Usage.cost` both use this scale: USD per 1,000,000 tokens. */
const TOKENS_PER_PRICE = 1_000_000;

function finite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tokens(value: number | undefined): number {
  return finite(value) ?? 0;
}

/**
 * Cache reads divided by the full prompt, `input + cacheRead + cacheWrite`.
 * A missing cache count is 0. A prompt of length 0 has no rate, so this returns null.
 */
export function cacheHitRate(
  usage: Pick<Usage, "input"> & Partial<Pick<Usage, "cacheRead" | "cacheWrite">>,
): number | null {
  const input = tokens(usage.input);
  const cacheRead = tokens(usage.cacheRead);
  const cacheWrite = tokens(usage.cacheWrite);
  const prompt = input + cacheRead + cacheWrite;
  if (prompt === 0) return null;
  return cacheRead / prompt;
}

/**
 * USD charged for one turn, or null when the model has no price list.
 *
 * Both `input` and `output` must be finite rates. A listed 0 is a real price.
 * A missing list, or a list missing either rate, returns null instead of a zero breakdown.
 *
 * Cache-read tokens use `cost.cacheRead` only and do not fall back to the input rate.
 * If that count is above 0 and the hit rate is unset, `cacheRead` and `total` are null.
 * A hit count of 0, or a listed hit rate of 0, charges 0. Cache-write tokens use
 * `cost.cacheWrite`, or the input rate when that rate is unset. Missing cache counts are 0 tokens.
 */
export function usageCost(
  model: {
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  },
  usage: Pick<Usage, "input" | "output"> & Partial<Pick<Usage, "cacheRead" | "cacheWrite">>,
): UsageCost | null {
  const rates = model.cost;
  const inputRate = finite(rates?.input);
  const outputRate = finite(rates?.output);
  if (inputRate === undefined || outputRate === undefined) return null;
  const cacheReadRate = finite(rates?.cacheRead);
  const cacheWriteRate = finite(rates?.cacheWrite) ?? inputRate;
  const cacheReadTokens = tokens(usage.cacheRead);
  const input = (tokens(usage.input) * inputRate) / TOKENS_PER_PRICE;
  const cacheRead = cacheReadTokens > 0 && cacheReadRate === undefined
    ? null
    : (cacheReadTokens * (cacheReadRate ?? 0)) / TOKENS_PER_PRICE;
  const cacheWrite = (tokens(usage.cacheWrite) * cacheWriteRate) / TOKENS_PER_PRICE;
  const output = (tokens(usage.output) * outputRate) / TOKENS_PER_PRICE;
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    total: cacheRead === null ? null : input + cacheRead + cacheWrite + output,
  };
}
