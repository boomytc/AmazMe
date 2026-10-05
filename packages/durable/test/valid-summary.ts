import { SUMMARY_MIN_CHARS } from "../src/compaction/plan.ts";
import { SUMMARY_SECTION_HEADINGS } from "../src/compaction/serialize.ts";

const SECTION_BODIES = [
  "进展已记下。",
  "保持现有压缩边界。",
  "无。",
  "按原计划继续。",
];

/** A summary the publisher accepts: every required heading, and at least SUMMARY_MIN_CHARS. */
export function validSummary(note: string): string {
  const bodies = [note, ...SECTION_BODIES];
  let text = SUMMARY_SECTION_HEADINGS.map((heading, index) => `${heading}\n${bodies[index] ?? "无。"}`).join("\n");
  if (text.length < SUMMARY_MIN_CHARS) text += `\n${"已核对。".repeat(SUMMARY_MIN_CHARS)}`;
  return text;
}
