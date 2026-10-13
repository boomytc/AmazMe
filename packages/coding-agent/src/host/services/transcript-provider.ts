import { serviceFacet } from "@amazme/protocol/services";
import type { Context, Facet } from "@amazme/chord";
import { withAbortSignal } from "@amazme/chord/context";
import type { Conversation } from "@amazme/durable";
import { Transcript } from "./transcript.ts";

/** Acquire the durable view only when its owning Chord resource opens. */
export function createTranscriptServiceFacet(conversation: Conversation, context: Context): Facet {
	return serviceFacet("@amazme/transcript", Transcript, [], async (_services, signal) => {
		const state = await conversation.viewState(withAbortSignal(signal, context));
		return { value: { state }, close: () => state.dispose() };
	});
}
