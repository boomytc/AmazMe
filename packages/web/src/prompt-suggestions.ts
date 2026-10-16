import type { Message } from "@amazme/ai";
import { UserEntry, type ConversationView } from "@amazme/durable";

export interface PromptSuggestionContext {
	readonly conversationId: string;
	readonly answerEntryId: string;
	readonly user: string;
	readonly answer: string;
}

function messageText(message: Message): string {
	return typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

/** Only a successful final answer after the most recent user input is a suggestion source. */
export function promptSuggestionContext(view: ConversationView | undefined): PromptSuggestionContext | undefined {
	if (!view) return undefined;
	let final: { id: string; text: string } | undefined;
	for (let i = view.entries.length - 1; i >= 0; i--) {
		const entry = view.entries[i]!;
		const message = entry.model?.[0];
		if (!message) continue;
		if (!final) {
			if (message.role !== "assistant" || message.stopReason !== "stop" || message.content.some(block => block.type === "toolCall")) return undefined;
			const text = messageText(message).trim();
			if (!text || /[?？]$/.test(text)) return undefined;
			final = { id: String(entry.id), text };
		} else if (message.role === "user") {
			if (entry.kind !== UserEntry.kind) return undefined;
			const user = messageText(message).trim();
			if (!user) return undefined;
			return { conversationId: String(view.conversation.id), answerEntryId: final.id, user: user.slice(0, 2000), answer: final.text.slice(-6000) };
		}
	}
	return undefined;
}

/**
 * One bounded candidate per source. A candidate belongs to the answer it was written for: it is
 * reported only while that answer is the current one, survives a temporary absence of a source
 * (a panel, a rebind), and is replaced only when a different source arrives. Typing, dismissal and
 * cancellation never restart generation for an answer the reader has already seen.
 */
export class PromptSuggestionController {
	readonly #changed: () => void;
	readonly #seen = new Set<string>();
	#key: string | undefined;
	#pending: AbortController | undefined;
	#value: { readonly key: string; readonly text: string } | undefined;
	constructor(changed: () => void) { this.#changed = changed; }
	/** The candidate for this exact source, or nothing while a different one is displayed. */
	valueFor(key: string | undefined): { readonly key: string; readonly text: string } | undefined {
		return key !== undefined && this.#value?.key === key ? this.#value : undefined;
	}
	update(key: string | undefined, eligible: boolean, request: (signal: AbortSignal) => Promise<string | null>): void {
		if (key !== this.#key) {
			this.#pending?.abort(); this.#pending = undefined; this.#key = key;
			if (key !== undefined && this.#value?.key !== key) this.#value = undefined;
		}
		if (!eligible) { this.#pending?.abort(); this.#pending = undefined; }
		if (key === undefined || !eligible || this.#seen.has(key)) return;
		this.#seen.add(key);
		if (this.#seen.size > 64) this.#seen.delete(this.#seen.values().next().value!);
		const pending = new AbortController(); this.#pending = pending;
		void Promise.resolve().then(() => pending.signal.aborted ? null : request(pending.signal)).then(text => {
			if (pending.signal.aborted || this.#pending !== pending || this.#key !== key) return;
			this.#pending = undefined;
			if (text) { this.#value = { key, text }; this.#changed(); }
		}, () => { if (this.#pending === pending) this.#pending = undefined; });
	}
	dismiss(): void {
		this.#pending?.abort(); this.#pending = undefined; this.#value = undefined;
		this.#changed();
	}
}
