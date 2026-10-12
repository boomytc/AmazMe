import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { Conversations } from "../services/conversations.ts";

interface HistoryScope {
	readonly service: Pick<Conversations, "older">;
	readonly sessionId: string;
	readonly conversationId: string;
	readonly before: string;
	readonly revision: number;
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
