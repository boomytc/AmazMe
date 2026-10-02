import { estimateRequestTokens, type Message } from "@amazme/ai";

/** One model-visible entry. A compaction entry is the previous summary, not a stored user message. */
export type TranscriptEntry =
  | { id: string; timestamp: number; kind: "message"; message: Message }
  | { id: string; timestamp: number; kind: "compaction"; summary: string };

export interface TailCut {
  summarized: TranscriptEntry[];
  kept: TranscriptEntry[];
}

export type SelectResult = { ok: true; cut: TailCut } | { ok: false; message: string };

type GroupKind = "user" | "tools" | "other";

interface Group {
  kind: GroupKind;
  entries: TranscriptEntry[];
  tokens: number;
}

/** Project a transcript entry to the message shape used for budgeting. Does not mutate the entry. */
export function transcriptMessage(entry: TranscriptEntry): Message {
  if (entry.kind === "compaction") return { role: "user", content: entry.summary, timestamp: entry.timestamp };
  return entry.message;
}

/**
 * Choose a prefix to summarize and a verbatim tail.
 * Tool-call groups stay whole. The unanswered trailing user messages, and a trailing tool group, stay even when they exceed the tail budget.
 * An earlier user message does not pin the history after it. A previous summary is summarized again instead of being kept beside the new one.
 * Navigation summarizes the whole visible branch and keeps no tail.
 */
export function selectTail(
  entries: readonly TranscriptEntry[],
  keepTokens: number,
  boundary: "resume" | "finish" | "navigation",
): SelectResult {
  if (boundary === "navigation") {
    if (!entries.some((entry) => entry.kind === "message")) return nothing();
    return { ok: true, cut: { summarized: [...entries], kept: [] } };
  }
  const groups = groupEntries(entries);
  const requiredAt = mustKeepStart(groups);
  let cut = groups.length;
  let keptTokens = 0;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (!group) break;
    const required = index >= requiredAt;
    if (!required && keptTokens + group.tokens > keepTokens) break;
    cut = index;
    keptTokens += group.tokens;
  }
  const fittedCut = cut;
  for (let index = cut; index < groups.length; index++) {
    const group = groups[index];
    if (group?.entries.some((entry) => entry.kind === "compaction")) cut = index + 1;
  }
  if (fittedCut === 0 && boundary === "finish" && entries.some((entry) => entry.kind === "message")) {
    return { ok: true, cut: { summarized: [...entries], kept: [] } };
  }
  const summarized = groups.slice(0, cut).flatMap((group) => group.entries);
  const kept = groups.slice(cut).flatMap((group) => group.entries);
  if (!summarized.some((entry) => entry.kind === "message")) return nothing();
  return { ok: true, cut: { summarized, kept } };
}

function nothing(): SelectResult {
  return { ok: false, message: "nothing to compact" };
}

function groupEntries(entries: readonly TranscriptEntry[]): Group[] {
  const groups: Group[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.kind === "message" && entry.message.role === "assistant") {
      const calls = entry.message.content.filter((block) => block.type === "toolCall");
      if (calls.length > 0) {
        const ids = new Set(calls.map((call) => call.id));
        const grouped = [entry];
        let next = index + 1;
        while (next < entries.length) {
          const candidate = entries[next];
          if (!candidate || candidate.kind !== "message" || candidate.message.role !== "toolResult" || !ids.has(candidate.message.toolCallId)) break;
          grouped.push(candidate);
          next += 1;
        }
        groups.push({ kind: "tools", entries: grouped, tokens: groupTokens(grouped) });
        index = next - 1;
        continue;
      }
    }
    const kind: GroupKind = entry.kind === "message" && entry.message.role === "user" ? "user" : "other";
    groups.push({ kind, entries: [entry], tokens: groupTokens([entry]) });
  }
  return groups;
}

function mustKeepStart(groups: readonly Group[]): number {
  if (groups.length === 0) return 0;
  const last = groups.length - 1;
  if (groups[last]?.kind === "tools") return last;
  if (groups[last]?.kind === "user") {
    let start = last;
    while (start > 0 && groups[start - 1]?.kind === "user") start -= 1;
    return start;
  }
  return groups.length;
}

function groupTokens(entries: readonly TranscriptEntry[]): number {
  return estimateRequestTokens({ messages: entries.map(transcriptMessage) });
}
