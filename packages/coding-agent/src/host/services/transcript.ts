import { defineService, type ReplicatedState } from "@amazme/chord";
import type { ConversationView, InboxState, LiveState } from "@amazme/durable";

/** The root conversation's durable view: active entries and its live, inbox, agent, and usage documents. */
export interface Transcript {
	readonly state: ReplicatedState<ConversationView>;
}

export const Transcript = defineService<Transcript>("amazme.transcript");

/** The `amazme.live` document of a view: the active run, the streaming answer, and running tools. */
export function liveOf(view: ConversationView): LiveState {
	return (view.docs["amazme.live"] ?? {}) as LiveState;
}

/** The `amazme.inbox` document of a view: inputs the session accepted but has not started yet. */
export function inboxOf(view: ConversationView): InboxState {
	return (view.docs["amazme.inbox"] ?? { items: [] }) as InboxState;
}
