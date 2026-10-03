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
  cost: { input: number; output: number };
  reasoning?: boolean;
  baseUrl?: string;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
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
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    api: row.api,
    provider: row.provider,
    input: row.input,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    cost: { input: row.cost.input, output: row.cost.output },
    ...(row.reasoning !== undefined ? { reasoning: row.reasoning } : {}),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.thinkingLevelMap ? { thinkingLevelMap: row.thinkingLevelMap } : {}),
  }));
}

export function catalogProviderIds(): string[] {
  return Object.keys(data);
}
