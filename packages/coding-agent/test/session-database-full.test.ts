import { applySqliteMigrations, SqliteSchemaError } from "@amazme/chord/sqlite";
import { openNodeSqliteDatabase } from "@amazme/chord/sqlite/node";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { lockSessionDatabase, openSessionStorage, SessionOpenError } from "../src/durable/session-database.ts";
import { lockSession } from "../src/durable/sessions.ts";
import { snapshotDirectory, writeCurrentSessionDatabase } from "./session-database-fixtures.ts";
import { createTempDir } from "./temp-dir.ts";

// Stand in for Durable's storage open with one whose migration runs out of space, so SQLITE_FULL comes from a real
// migration transaction on the real session file.
const fill = vi.hoisted(() => ({ enabled: false }));
vi.mock("@amazme/durable/storage/sqlite/node", async (importActual) => ({
	...(await importActual<typeof import("@amazme/durable/storage/sqlite/node")>()),
	async openNodeSqliteStorage(path: string) {
		if (!fill.enabled) {
			const actual = await importActual<typeof import("@amazme/durable/storage/sqlite/node")>();
			return actual.openNodeSqliteStorage(path);
		}
		const database = await openNodeSqliteDatabase(path);
		try {
			await applySqliteMigrations(
				database,
				[
					{
						version: 1,
						statements: [
							"CREATE TABLE filler (body BLOB)",
							// The file may not grow, so the insert fails with SQLITE_FULL.
							"PRAGMA max_page_count = 1",
							"INSERT INTO filler (body) VALUES (zeroblob(1000000))",
						],
					},
				],
				{ table: "full_schema" },
			);
		} finally {
			await database.close();
		}
		throw new Error("migration unexpectedly succeeded");
	},
}));

describe("a migration that runs out of disk", () => {
	test("SQLITE_FULL reaches the caller as the original SQLite error and the session files are unchanged", async () => {
		const directory = join(createTempDir("amazme-session-db-full-"), "session");
		const path = await writeCurrentSessionDatabase(directory);
		const before = await snapshotDirectory(directory);
		fill.enabled = true;
		const lease = await lockSessionDatabase(directory, path, lockSession);
		let error: unknown;
		try {
			error = await openSessionStorage(lease).catch((caught: unknown) => caught);
		} finally {
			await lease.release();
		}
		expect(error).not.toBeInstanceOf(SessionOpenError);
		expect(error).not.toBeInstanceOf(SqliteSchemaError);
		expect(error).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 13 });
		expect(await snapshotDirectory(directory)).toEqual(before);
	});
});
