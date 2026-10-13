import { localService } from "@amazme/protocol/services";
import type { Context } from "@amazme/chord";
import type { Conversation, ConversationId, Harness } from "@amazme/durable";

/** Trusted in-process plugins share the selected conversation's existing kernel. Never published over RPC. */
export interface AgentRuntime {
	current(context: Context): Promise<{ harness: Harness; conversation: Conversation }>;
}

export const AgentRuntime = localService<AgentRuntime>("amazme.local.agent-runtime");

export function createAgentRuntime(
	harness: Harness,
	selected: () => ConversationId,
	unavailable: () => boolean,
): AgentRuntime {
	return {
		async current(context) {
			context.abortSignal?.throwIfAborted();
			if (unavailable()) throw new Error("Plugins are unavailable; finish reloading or restart the session");
			const conversation = await harness.conversation(selected(), context);
			if (conversation === undefined) throw new Error("Selected conversation is unavailable");
			return { harness, conversation };
		} };
}
