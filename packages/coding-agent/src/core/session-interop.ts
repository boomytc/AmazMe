/**
 * The two transcripts one session has, projected onto each other.
 *
 * A terminal session is the append-only JSONL the TUI lists and resumes; a hosted session is the
 * durable transcript the web client, the client TUI, and the desktop client read. The same session
 * can be opened on either side, so each side needs the other's shape: a host seeds a hosted session
 * from the terminal's file, and keeps the terminal's file current from the durable transcript. Both
 * projections are pure — identity, ordering, and the report are decided here, and the callers own
 * the files and the storage.
 *
 * What cannot be carried is counted, never dropped in silence:
 * - Terminal bookkeeping (`model_change`, `thinking_level_change`, `usage`, `label`, `session_info`,
 *   `custom`, `custom_message`, `context_edit`) is not transcript content, so the hosted session
 *   keeps its own model, thinking level, and settings.
 * - Terminal message roles a durable entry cannot hold (extension `custom`, `branchSummary`,
 *   `bashExecution`) are counted by role.
 * - A terminal `compaction` entry becomes a durable context reset carrying its summary, which is the
 *   durable way of saying "the history before this point was summarized".
 * - A durable `reset` entry with no handoff message has no terminal counterpart and is counted.
 */
import type { Message, UserMessage } from "@amazme/ai";
import {
	AssistantEntry,
	type EntryDraft,
	ResetEntry,
	SystemEntry,
	ToolResultEntry,
	UserEntry,
} from "@amazme/durable";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "./messages.ts";
import type { SessionEntry, SessionHeader } from "./session-manager.ts";

/** What one projection could not carry, by name, with how many entries it stood for. */
export type SessionInteropSkips = Readonly<Record<string, number>>;

export interface SessionInteropReport {
	/** Entries written as transcript content. */
	readonly carried: number;
	/** Entries counted under a name they could not be carried as. */
	readonly skipped: SessionInteropSkips;
}

/** The prompt a compaction summary contributes to model context, as the terminal wraps it. */
function wrapCompactionSummary(summary: string): string {
	return `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`;
}

/** The summary behind a wrapped compaction message, or `undefined` when it is not one. */
function unwrapCompactionSummary(text: string): string | undefined {
	if (!text.startsWith(COMPACTION_SUMMARY_PREFIX) || !text.endsWith(COMPACTION_SUMMARY_SUFFIX)) return undefined;
	return text.slice(COMPACTION_SUMMARY_PREFIX.length, text.length - COMPACTION_SUMMARY_SUFFIX.length);
}

function countKey(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Project terminal entries onto durable writes, in order.
 *
 * Messages keep their role: user, assistant, and tool results become the durable entries of that
 * kind, and a system message becomes a positional system entry. Every other entry is counted under
 * its `type`, or under its message role when the terminal carried it as a message.
 */
export function sessionEntriesToDurableDrafts(entries: readonly SessionEntry[]): {
	readonly drafts: readonly EntryDraft[];
	readonly report: SessionInteropReport;
} {
	const drafts: EntryDraft[] = [];
	const skipped: Record<string, number> = {};
	let carried = 0;
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message;
			switch (message.role) {
				case "user":
					drafts.push({ kind: UserEntry.kind, model: [message] });
					break;
				case "assistant":
					drafts.push({ kind: AssistantEntry.kind, model: [message] });
					break;
				case "toolResult":
					drafts.push({ kind: ToolResultEntry.kind, model: [message], data: { diagnostics: [] } });
					break;
				case "system":
					drafts.push({ kind: SystemEntry.kind, model: [message] });
					break;
				default:
					countKey(skipped, `message:${message.role}`);
					continue;
			}
			carried += 1;
			continue;
		}
		if (entry.type === "compaction") {
			const handoff: UserMessage = {
				role: "user",
				content: [{ type: "text", text: wrapCompactionSummary(entry.summary) }],
				timestamp: new Date(entry.timestamp).getTime(),
			};
			drafts.push({ kind: ResetEntry.kind, model: [handoff], head: "self" });
			carried += 1;
			continue;
		}
		countKey(skipped, entry.type);
	}
	return { drafts, report: { carried, skipped } };
}

/**
 * Project durable entries onto the terminal's file entries: its header, then one message entry per
 * model message, chained in order. A message carrying a wrapped summary becomes the terminal's own
 * summary message, which is how the terminal represents "the history before this point was
 * summarized".
 *
 * Entry ids derive from the durable entry's id and the message's position, so a second projection of
 * the same transcript writes the same ids and the terminal's tree stays stable across refreshes.
 */
export function durableEntriesToSessionFile(
	entries: readonly { readonly id: unknown; readonly kind: string; readonly model?: readonly Message[] }[],
	header: { readonly id: string; readonly cwd: string; readonly timestamp: string },
): { readonly entries: readonly (SessionHeader | SessionEntry)[]; readonly report: SessionInteropReport } {
	const file: (SessionHeader | SessionEntry)[] = [
		{ type: "session", version: 3, id: header.id, timestamp: header.timestamp, cwd: header.cwd },
	];
	const skipped: Record<string, number> = {};
	let carried = 0;
	let parentId: string | null = null;
	for (const entry of entries) {
		const messages = entry.model ?? [];
		if (messages.length === 0) {
			// A reset with no handoff starts a context with nothing to say: the terminal has no entry
			// for it, and a bookkeeping-only entry has no messages at all.
			countKey(skipped, entry.kind);
			continue;
		}
		messages.forEach((message, index) => {
			const id = `e${String(entry.id)}${index === 0 ? "" : `.${index}`}`;
			const summary = summaryOf(message);
			file.push({
				type: "message",
				id,
				parentId,
				timestamp: header.timestamp,
				message:
					summary === undefined
						? message
						: {
								role: "compactionSummary",
								summary,
								tokensBefore: 0,
								timestamp: new Date(header.timestamp).getTime(),
							},
			});
			parentId = id;
			carried += 1;
		});
	}
	return { entries: file, report: { carried, skipped } };
}

/** The summary a durable entry's message carries, when it carries one. */
function summaryOf(message: Message): string | undefined {
	if (message.role !== "user") return undefined;
	const content = message.content;
	if (typeof content === "string") return unwrapCompactionSummary(content);
	const part = content.find((candidate) => candidate.type === "text");
	return part === undefined ? undefined : unwrapCompactionSummary(part.text);
}
