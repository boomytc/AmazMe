import type { KnownApi, Model, ThinkingLevel } from "../types.ts";
import catalog from "./data/catalog.json";

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

const data = catalog as Record<string, CatalogModel[]>;

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
