import { contextSafetyMargin } from "@amazme/ai";

/**
 * Output tokens held back when deciding whether the input already needs compaction.
 * Large windows reserve 4,096. Smaller windows reserve one sixteenth, and never less than 32.
 */
export function outputReserve(contextWindow: number): number {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return 0;
  return Math.min(4_096, Math.max(32, Math.floor(contextWindow / 16)));
}

/**
 * Input-token trigger after the model window, output reserve, and safety margin.
 * `configured` is `compaction.maxTokens`. It is not the generation output cap.
 * A non-positive configured value does not widen the trigger; callers reject it before use.
 */
export function effectiveInputThreshold(contextWindow: number, configuredThreshold: number): number {
  const hard = contextWindow - outputReserve(contextWindow) - contextSafetyMargin(contextWindow);
  if (!Number.isSafeInteger(configuredThreshold) || configuredThreshold <= 0) return hard;
  return Math.min(configuredThreshold, hard);
}

/**
 * Recent-tail budget for a compaction cut.
 * The window contributes `min(8192, max(64, floor(window / 8)))`.
 * The budget also stays within half of the effective input trigger, so a small trigger can still leave a prefix to summarize.
 */
export function keepRecentBudget(contextWindow: number, inputThreshold: number): number {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return 1;
  const scaled = Math.min(8_192, Math.max(64, Math.floor(contextWindow / 8)));
  const cap = Math.max(1, Math.floor(Math.max(inputThreshold, 0) / 2));
  return Math.min(scaled, cap);
}

/**
 * Output cap for the one summary request.
 * It follows the output reserve, not the caller's generation `maxTokens`, and still cannot exceed the model cap.
 */
export function summaryOutputLimit(modelMaxTokens: number, contextWindow: number): number {
  const scaled = Math.max(32, Math.floor(outputReserve(contextWindow) / 2));
  const modelCap = Number.isSafeInteger(modelMaxTokens) && modelMaxTokens > 0 ? modelMaxTokens : scaled;
  return Math.max(1, Math.min(modelCap, scaled));
}
