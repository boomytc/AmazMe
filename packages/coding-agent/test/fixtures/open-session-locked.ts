// Opens one session the way a host does and reports the outcome as one JSON line on stdout. Used by the concurrency
// test in session-database-open.test.ts. Arguments: <session directory> <mode: open | cwd> <hold milliseconds>.
// Like a process entry (see src/quiet-warnings.ts), it silences warnings first and imports everything that can reach
// node:sqlite dynamically afterwards: the test asserts its stderr is empty with warnings left on.
import "../../src/quiet-warnings.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";

const { BACKGROUND_CONTEXT } = await import("@amazme/chord/context");
const { readDurableSessionCwd } = await import("../../src/durable/session-cwd.ts");
const { lockSessionDatabase, openSessionStorage, SessionOpenError } = await import("../../src/durable/session-database.ts");
const { lockSession } = await import("../../src/durable/sessions.ts");

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
