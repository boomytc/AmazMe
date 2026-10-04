import type { Model, ThinkingLevel } from "../types.ts";

/** Claude's token and adaptive wires are shared by Messages and Bedrock Converse. */
export function claudeThinkingFields(model: Model, outputCap: number, effort: string | undefined, requested?: ThinkingLevel): Record<string, unknown> | undefined {
  if (requested === "off") return model.reasoning ? { thinking: { type: "disabled" } } : undefined;
  if (!effort) return undefined;
  const level = effort.toLowerCase();
  const match = `${model.id} ${model.name}`.toLowerCase().replace(/[\s_.:]+/g, "-");
  const adaptive = /(?:opus-(?:4-[678]|5)|sonnet-(?:4-6|5)|fable-5)/.test(match);
  if (adaptive) {
    const mapped = level === "minimal" ? "low" : level;
    if (!["low", "medium", "high"].includes(mapped)) throw new Error(`Unsupported Claude adaptive effort ${effort}`);
    return { thinking: { type: "adaptive" }, output_config: { effort: mapped } };
  }
  if (outputCap <= 1024) throw new Error("Anthropic thinking budget does not fit the output cap");
  const budgets: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
  const budget = budgets[level];
  if (budget === undefined) throw new Error(`Unsupported Claude thinking level ${effort}`);
  return { thinking: { type: "enabled", budget_tokens: Math.min(budget, outputCap - 1) } };
}
