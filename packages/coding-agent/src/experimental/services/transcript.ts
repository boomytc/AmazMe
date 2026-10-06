import { defineService, type ReplicatedState } from "@amazme/chord";
import type { ConversationView } from "@amazme/durable";

/** The root conversation's durable view: active entries and its live, inbox, agent, and usage documents. */
export interface Transcript {
	readonly state: ReplicatedState<ConversationView>;
}

export const Transcript = defineService<Transcript>("amazme.transcript");
