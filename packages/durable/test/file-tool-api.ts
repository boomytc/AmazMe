import type { Context } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { createSession, MemoryStorage, type ConversationId, type Session } from "../src/index.ts";
import type { ExecutionEnv } from "../src/env/index.ts";
import type { ToolExecutionApi } from "../src/harness/types.ts";

// Unit fixtures sharing a cwd represent one conversation, including calls through different environment objects.
const owners = new Map<string, Promise<{ session: Session; conversationId: ConversationId }>>();

export async function fileToolApi(env: ExecutionEnv | undefined): Promise<ToolExecutionApi> {
	const key = env?.cwd ?? "no-environment";
	let owner = owners.get(key);
	if (owner === undefined) {
		owner = (async () => {
			const session = createSession(new MemoryStorage());
			const conversationId = await session.commit(
				async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
				BACKGROUND_CONTEXT,
			);
			return { session, conversationId };
		})();
		owners.set(key, owner);
	}
	const { session, conversationId } = await owner;
	return {
		conversationId,
		env,
		taskId: 1,
		callId: "call",
		snapshot: session.snapshot.bind(session),
		commit: session.commit.bind(session),
		output: () => {},
		diagnostic: () => {},
		details: async () => {},
	} as unknown as ToolExecutionApi;
}

export async function closeFileToolApis(context: Context = BACKGROUND_CONTEXT): Promise<void> {
	for (const owner of owners.values()) await (await owner).session.close(context);
	owners.clear();
}
