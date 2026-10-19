import { localService } from "@amazme/protocol/services";
import type { Context } from "@amazme/chord";
import type { Conversation, ConversationId, Harness } from "@amazme/durable";
import { assertConversationWritable, withConversationAdmission } from "../../durable/fork-management.ts";

/** Trusted in-process plugins share the selected conversation's existing kernel. Never published over RPC. */
export interface AgentRuntime {
	current(context: Context): Promise<{ harness: Harness; conversation: Conversation }>;
	/** Serialize a short plugin state change with archive admission, using the host's current conversation. */
	withWritableConversation<T>(change: (conversation: Conversation) => Promise<T>, context: Context): Promise<T>;
}

export const AgentRuntime = localService<AgentRuntime>("amazme.local.agent-runtime");

export function createAgentRuntime(
	harness: Harness,
	selected: () => ConversationId,
	unavailable: () => boolean,
): AgentRuntime {
	const current: AgentRuntime["current"] = async (context) => {
		context.abortSignal?.throwIfAborted();
		if (unavailable()) throw new Error("Plugins are unavailable; finish reloading or restart the session");
		const conversation = await harness.conversation(selected(), context);
		if (conversation === undefined) throw new Error("Selected conversation is unavailable");
		return { harness, conversation };
	};
	return {
		current,
		async withWritableConversation(change, context) {
			const { conversation } = await current(context);
			return withConversationAdmission(harness, context, async () => {
				if (unavailable()) throw new Error("Plugins are unavailable; finish reloading or restart the session");
				await assertConversationWritable(harness, conversation.id, context);
				context.abortSignal?.throwIfAborted();
				if (unavailable()) throw new Error("Plugins are unavailable; finish reloading or restart the session");
				return change(conversation);
			});
		},
	};
}
