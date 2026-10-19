import { createModels } from "@amazme/ai/models";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { AgentDoc, createRegistry, Harness } from "@amazme/durable";
import { join } from "node:path";
import { openSessionStorage } from "./session-database.ts";

/** Read the project cwd stored in a Durable session, before opening it for use. */
export async function readDurableSessionCwd(directory: string): Promise<string | undefined> {
	const harness = await Harness.open(
		await openSessionStorage(join(directory, "session.sqlite")),
		{ models: createModels(), registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT);
		const agent = await harness.snapshot(AgentDoc, root.id, BACKGROUND_CONTEXT);
		return typeof agent?.cwd === "string" ? agent.cwd : undefined;
	} finally {
		await harness.close(BACKGROUND_CONTEXT).catch(() => {});
	}
}
