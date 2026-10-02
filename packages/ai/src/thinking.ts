import type { Model, ThinkingLevel } from "./types.ts";

const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/** Levels this chat model accepts. Non-reasoning models accept only "off". */
export function supportedThinkingLevels(model: Model): ThinkingLevel[] {
  if (model.reasoning !== true) return ["off"];
  return LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

export type ThinkingResolution =
  | { ok: true; parameter?: string }
  | { ok: false; level: ThinkingLevel };

/**
 * Map a unified thinking level to a protocol parameter.
 * An omitted level sends nothing. An unsupported level is rejected instead of clamped.
 */
export function resolveThinkingLevel(model: Model, level?: ThinkingLevel): ThinkingResolution {
  if (level === undefined) return { ok: true };
  if (!supportedThinkingLevels(model).includes(level)) return { ok: false, level };
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return { ok: true, parameter: mapped };
  if (level !== "off") return { ok: true, parameter: level };
  return { ok: true };
}
