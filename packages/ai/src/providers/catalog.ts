import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KnownApi, Model, ThinkingLevel } from "../types.ts";

interface CatalogModel {
  id: string;
  name: string;
  api: KnownApi;
  provider: string;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  /** Omitted when the provider did not publish a price. A negative rate is an unknown price, not a charge. */
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  reasoning?: boolean;
  baseUrl?: string;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  /**
   * See `Model.thinkingSwitch`. Per-model limit citations that JSON cannot store
   * live in `data/LIMIT_SOURCES.md`, next to the catalog values they describe.
   */
  thinkingSwitch?: string;
}

// module Node16 cannot emit a JSON import attribute, and Node rejects a bare JSON import.
// The composite project still emits catalog.json beside this compiled module.
function loadCatalog(): Record<string, CatalogModel[]> {
  const path = join(dirname(fileURLToPath(import.meta.url)), "data", "catalog.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Chat catalog must be a JSON object");
  }
  return parsed as Record<string, CatalogModel[]>;
}

const data = loadCatalog();

/** Chat models for one preset. Image models and classifiers are not in this catalog. */
export function catalogModels(providerId: string): Model<KnownApi>[] {
  const rows = data[providerId];
  if (!rows) throw new Error(`No chat catalog for ${providerId}`);
  return rows.map((row) => {
    const cost = knownCost(row.cost);
    const thinkingSwitch = row.thinkingSwitch;
    if (thinkingSwitch !== undefined && thinkingSwitch !== "thinking") {
      throw new Error(`Model "${row.provider}/${row.id}" thinkingSwitch must be "thinking"`);
    }
    return {
      id: row.id,
      name: row.name,
      api: row.api,
      provider: row.provider,
      input: row.input,
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
      ...(cost ? { cost } : {}),
      ...(row.reasoning !== undefined ? { reasoning: row.reasoning } : {}),
      ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
      ...(row.thinkingLevelMap ? { thinkingLevelMap: row.thinkingLevelMap } : {}),
      ...(thinkingSwitch ? { thinkingSwitch } : {}),
    };
  });
}

/**
 * OpenRouter stores an unknown price as -1_000_000 USD per million tokens
 * (`openrouter/auto`, `openrouter/auto-beta`, `typesafe/jev-router`).
 * Drop that sentinel, and a missing list, so `usageCost` returns null instead of a negative total.
 */
function knownCost(cost: CatalogModel["cost"]): NonNullable<Model["cost"]> | undefined {
  if (!cost) return undefined;
  const rates = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
  if (rates.some((rate) => typeof rate === "number" && (!Number.isFinite(rate) || rate < 0))) return undefined;
  if (typeof cost.input !== "number" || typeof cost.output !== "number") return undefined;
  return {
    input: cost.input,
    output: cost.output,
    ...(typeof cost.cacheRead === "number" ? { cacheRead: cost.cacheRead } : {}),
    ...(typeof cost.cacheWrite === "number" ? { cacheWrite: cost.cacheWrite } : {}),
  };
}

export function catalogProviderIds(): string[] {
  return Object.keys(data);
}
