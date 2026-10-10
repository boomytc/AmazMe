import type { Context } from "@amazme/chord";
import type { EntryId, EntryRecord } from "@amazme/durable";

const MAX_SCANNED = 500;
const MAX_SEARCH_TEXT = 1_000_000;
const ENTRY_SEARCH_TEXT = 64_000;

/** The caller supplies a conversation-bound reader; no storage path or foreign scope is accepted. */
export type HistoryReader = (
	before: EntryId | undefined,
	limit: number,
	context: Context,
) => Promise<readonly EntryRecord[]>;

export function entryId(value: string): EntryId {
	const id = Number(value);
	if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(id))
		throw new Error("Entry ID must be a positive safe integer");
	return id as EntryId;
}

/** Raw immutable records, including those outside the compacted model context. */
export async function searchHistory(
	read: HistoryReader,
	query: string,
	before: EntryId | undefined,
	limit: number,
	context: Context,
) {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0 || needle.length > 512) throw new Error("Query must contain 1 to 512 characters");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Limit must be an integer from 1 to 20");
	const matches: Array<{
		entryId: string;
		sourceConversationId: string;
		kind: string;
		text: string;
		textLimited: boolean;
	}> = [];
	let scanned = 0;
	let searched = 0;
	let textLimited = false;
	let nextBefore: string | null = null;
	while (scanned < MAX_SCANNED && searched < MAX_SEARCH_TEXT) {
		context.abortSignal?.throwIfAborted();
		const entries = await read(before, Math.min(32, MAX_SCANNED - scanned), context);
		if (entries.length === 0) return { matches, scanned, nextBefore: null, textLimited };
		for (const entry of entries) {
			context.abortSignal?.throwIfAborted();
			scanned += 1;
			before = entry.id;
			nextBefore = String(entry.id);
			const projected = historyText(entry, Math.min(ENTRY_SEARCH_TEXT, MAX_SEARCH_TEXT - searched));
			searched += projected.text.length;
			textLimited ||= projected.more;
			const index = projected.text.toLowerCase().indexOf(needle);
			if (index >= 0) {
				const start = Math.max(0, index - 240);
				matches.push({
					entryId: String(entry.id),
					sourceConversationId: String(entry.conversationId),
					kind: entry.kind,
					text: projected.text.slice(start, start + 1200),
					textLimited: projected.more || projected.text.length > 1200,
				});
			}
			if (matches.length === limit || searched >= MAX_SEARCH_TEXT) return { matches, scanned, nextBefore, textLimited };
		}
	}
	return { matches, scanned, nextBefore, textLimited };
}

/** A text window of one visible record; image bytes and provider reasoning are not copied into recall. */
export function readHistoryEntry(entry: EntryRecord, offset: number, maxChars: number) {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
		throw new Error("Offset must be an integer from 0 to 1000000");
	if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 8000)
		throw new Error("maxChars must be an integer from 1 to 8000");
	const projected = historyText(entry, offset + maxChars);
	const capped = projected.more && offset + maxChars > 1_000_000;
	return {
		entryId: String(entry.id),
		sourceConversationId: String(entry.conversationId),
		kind: entry.kind,
		text: projected.text.slice(offset),
		offset,
		nextOffset: projected.more && !capped ? offset + maxChars : null,
		textLimited: capped,
	};
}

function historyText(entry: EntryRecord, maxChars: number): { text: string; more: boolean } {
	const chunks: string[] = [];
	let remaining = maxChars;
	for (const part of textParts(entry)) {
		if (part.length > remaining) {
			chunks.push(part.slice(0, remaining));
			return { text: chunks.join(""), more: true };
		}
		chunks.push(part);
		remaining -= part.length;
	}
	return { text: chunks.join(""), more: false };
}

function* textParts(entry: EntryRecord): Generator<string> {
	for (const message of entry.model ?? []) {
		// Earlier search output is not new evidence, and must not recursively amplify returned excerpts.
		if (message.role === "toolResult" && /^history_(?:search|read)$/.test(message.toolName)) continue;
		yield `${message.role}: `;
		if (typeof message.content === "string") yield message.content;
		else
			for (const block of message.content) {
				if (block.type === "text") yield block.text;
				else if (block.type === "image") yield `[image ${block.mimeType}]`;
				else if (block.type === "toolCall" && !/^history_(?:search|read)$/.test(block.name))
					yield `[tool ${block.name}]`;
			}
		yield "\n";
	}
}
