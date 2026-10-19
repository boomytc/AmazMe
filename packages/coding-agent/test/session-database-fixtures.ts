import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";

/** Session databases a host must refuse without writing to them. */
export const BROKEN_SESSION_DATABASES = [
	{ fixture: "newer-schema", kind: "newer-schema" },
	{ fixture: "wal-newer-schema", kind: "newer-schema" },
	{ fixture: "rollback-journal-newer-schema", kind: "newer-schema" },
	{ fixture: "not-a-database", kind: "not-a-database" },
	{ fixture: "migration-fails", kind: "migration-failed" },
] as const;
export type BrokenSessionDatabase = (typeof BROKEN_SESSION_DATABASES)[number]["fixture"];

async function createCurrentDatabase(path: string): Promise<void> {
	const storage = await openNodeSqliteStorage(path);
	await storage.close(BACKGROUND_CONTEXT);
}

function edit(path: string, sql: string): void {
	const database = new DatabaseSync(path);
	try {
		database.exec(sql);
	} finally {
		database.close();
	}
}

/** A healthy session database at the current schema version, as `<directory>/session.sqlite`. */
export async function writeCurrentSessionDatabase(directory: string): Promise<string> {
	await mkdir(directory, { recursive: true });
	const path = join(directory, "session.sqlite");
	await createCurrentDatabase(path);
	return path;
}

/**
 * Write `fixture` as `<directory>/session.sqlite` (plus `-wal` for the crash case). The directory is created; nothing
 * else is written into it.
 */
export async function writeBrokenSessionDatabase(directory: string, fixture: BrokenSessionDatabase): Promise<string> {
	await mkdir(directory, { recursive: true });
	const path = join(directory, "session.sqlite");
	switch (fixture) {
		case "newer-schema":
			await createCurrentDatabase(path);
			edit(path, "UPDATE durable_schema SET version = 99");
			break;
		case "rollback-journal-newer-schema":
			// Not in WAL mode: enabling WAL before the version check used to rewrite the header.
			await createCurrentDatabase(path);
			edit(path, "PRAGMA journal_mode = DELETE; UPDATE durable_schema SET version = 99");
			break;
		case "wal-newer-schema": {
			// A crash image: the main file is still at the current version, and the uncheckpointed `-wal` holds a newer
			// release's commit. An immutable read ignores the `-wal` and would wrongly accept it.
			const scratch = join(directory, ".fixture");
			await mkdir(scratch);
			const source = join(scratch, "session.sqlite");
			await createCurrentDatabase(source);
			const writer = new DatabaseSync(source);
			try {
				writer.exec("PRAGMA wal_autocheckpoint = 0");
				writer.exec("UPDATE durable_schema SET version = 99");
				await copyFile(source, path);
				await copyFile(`${source}-wal`, `${path}-wal`);
			} finally {
				writer.close();
				await rm(scratch, { recursive: true, force: true });
			}
			break;
		}
		case "not-a-database":
			await writeFile(path, "This is a note someone saved over the session database.\n".repeat(200));
			break;
		case "migration-fails":
			// A version 1 database whose upgrade to version 2 fails: the table the migration creates already exists.
			await createCurrentDatabase(path);
			edit(path, "UPDATE durable_schema SET version = 1; CREATE TABLE tasks_v2 (value TEXT)");
			break;
	}
	return path;
}

/** Every entry in `directory` with the sha256 of its bytes, so a changed, created, or deleted file shows up. */
export async function snapshotDirectory(directory: string): Promise<Record<string, string>> {
	const snapshot: Record<string, string> = {};
	for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(directory, entry.name);
		snapshot[entry.name] = entry.isFile()
			? createHash("sha256").update(await readFile(path)).digest("hex")
			: entry.isDirectory()
				? `directory: ${JSON.stringify(await snapshotDirectory(path))}`
				: "other";
	}
	return snapshot;
}
