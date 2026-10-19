// Opens one session the way a host does and reports the outcome as one JSON line on stdout. Used by the concurrency
// test in session-database-open.test.ts. Arguments: <session directory> <mode: open | cwd> <hold milliseconds>.
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { readDurableSessionCwd } from "../../src/durable/session-cwd.ts";
import { lockSessionDatabase, openSessionStorage, SessionOpenError } from "../../src/durable/session-database.ts";
import { lockSession } from "../../src/durable/sessions.ts";

const [directory, mode, hold] = process.argv.slice(2);
if (directory === undefined || (mode !== "open" && mode !== "cwd")) throw new Error("usage: <directory> <open|cwd> <ms>");

async function open(): Promise<void> {
	if (mode === "cwd") {
		await readDurableSessionCwd(directory!);
		return;
	}
	const lease = await lockSessionDatabase(directory!, join(directory!, "session.sqlite"), lockSession);
	try {
		const storage = await openSessionStorage(lease);
		await sleep(Number(hold ?? 0));
		await storage.close(BACKGROUND_CONTEXT);
	} finally {
		await lease.release();
	}
}

try {
	await open();
	process.stdout.write(`${JSON.stringify({ result: "opened" })}\n`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	const result = error instanceof SessionOpenError
		? "session-open-error"
		: message.startsWith("Session is already open in another process")
			? "locked"
			: "error";
	process.stdout.write(`${JSON.stringify({ result, name: error instanceof Error ? error.name : typeof error, message })}\n`);
}
