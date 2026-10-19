import { createModels } from "@amazme/ai/models";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { AgentDoc, createRegistry, Harness } from "@amazme/durable";
import { join } from "node:path";
import { lockSessionDatabase, openSessionStorage, type SessionLease } from "./session-database.ts";
import { lockSession } from "./sessions.ts";

/**
 * Read the project cwd stored in a Durable session, before opening it for use. The session lock is held while the
 * database is read (and released afterwards), so this fails like any other open when another process has the session.
 */
export async function readDurableSessionCwd(directory: string): Promise<string | undefined> {
	const lease = await lockSessionDatabase(directory, join(directory, "session.sqlite"), lockSession);
	try {
		return await readCwd(lease);
	} finally {
		await lease.release();
	}
}

async function readCwd(lease: SessionLease): Promise<string | undefined> {
	const harness = await Harness.open(
		await openSessionStorage(lease),
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
