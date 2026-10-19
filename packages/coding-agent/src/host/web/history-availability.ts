import type { Context } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { HistoryPage } from "../../durable/conversation-view.ts";
import type { Conversations } from "../services/conversations.ts";

interface HistoryScope {
	readonly service: Pick<Conversations, "older">;
	readonly sessionId: string;
	readonly conversationId: string;
	readonly before: string;
	readonly revision: number;
}

const HISTORY_SEARCH_PAGE = 100;

/**
 * Every stored page older than the transcript the page already shows, oldest first.
 * A repeated cursor stops the walk so a broken page cannot loop.
 */
export async function loadRemainingHistory(
	older: Conversations["older"],
	conversationId: string,
	before: string | null,
	cursor: string | null,
	context: Context,
): Promise<{ readonly entries: HistoryPage["entries"]; readonly cursor: null }> {
	const pages: HistoryPage["entries"][] = [];
	const seen = new Set<string>();
	let next = cursor;
	while (true) {
		const page = await older(conversationId, next === null ? before : null, next, HISTORY_SEARCH_PAGE, context);
		if (page.cursor !== undefined && seen.has(page.cursor)) break;
		pages.push(page.entries);
		if (page.cursor === undefined) break;
		seen.add(page.cursor);
		next = page.cursor;
	}
	return { entries: pages.reverse().flat(), cursor: null };
}

/** Unknown history is not "more": probe one stored entry without adding it to the transcript. */
export class HistoryAvailability {
	#probe: { readonly scope: HistoryScope; more: boolean } | undefined;
	readonly #onChange: () => void;
	readonly #onError: (error: unknown) => void;

	constructor(onChange: () => void, onError: (error: unknown) => void) {
		this.#onChange = onChange;
		this.#onError = onError;
	}

	update(scope: HistoryScope | undefined): boolean {
		if (scope === undefined) {
			this.#probe = undefined;
			return false;
		}
		const previous = this.#probe;
		if (previous !== undefined && previous.scope.service === scope.service
			&& previous.scope.sessionId === scope.sessionId && previous.scope.conversationId === scope.conversationId
			&& previous.scope.before === scope.before && previous.scope.revision === scope.revision) return previous.more;

		const probe = { scope, more: false };
		this.#probe = probe;
		void scope.service.older(scope.conversationId, scope.before, null, 1, BACKGROUND_CONTEXT).then(
			(page) => {
				if (this.#probe !== probe) return;
				probe.more = page.entries.length > 0;
				if (probe.more) this.#onChange();
			},
			(error: unknown) => {
				if (this.#probe === probe) this.#onError(error);
			},
		);
		return false;
	}
}
