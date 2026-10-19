import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	applySqliteMigrations,
	checkSqliteSchemaVersion,
	isSqliteResourceError,
	type SqliteExecutor,
	SqliteSchemaError,
} from "../../src/sqlite/index.ts";
import { openNodeSqliteDatabase, preflightNodeSqliteFile } from "../../src/sqlite/node.ts";
import { createTempDir } from "../temp-dir.ts";

function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	return run(createTempDir("amazme-chord-sqlite-"));
}

function snapshot(directory: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(directory, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((entry) => [
				entry.name,
				entry.isFile()
					? createHash("sha256").update(readFileSync(join(directory, entry.name))).digest("hex")
					: "directory",
			]),
	);
}

/** A rollback-journal database at schema `version`, so enabling WAL would rewrite its header. */
function writeVersioned(path: string, version: number): void {
	const database = new DatabaseSync(path);
	database.exec(`CREATE TABLE app_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);
		INSERT INTO app_schema VALUES (1, ${version})`);
	database.close();
}

const checkApp = (reader: SqliteExecutor) => checkSqliteSchemaVersion(reader, { table: "app_schema", currentVersion: 2 });

describe("Node SQLite driver", () => {
	it("configures connection defaults and accepts explicit settings", async () => {
		for (const options of [{}, { busyTimeoutMs: 123, walAutoCheckpointPages: 0 }]) {
			const database = await openNodeSqliteDatabase(":memory:", options);
			try {
				expect(await database.get("PRAGMA busy_timeout")).toEqual({ timeout: options.busyTimeoutMs ?? 5_000 });
				expect(await database.get("PRAGMA wal_autocheckpoint")).toEqual({
					wal_autocheckpoint: options.walAutoCheckpointPages ?? 1_000,
				});
				expect(await database.get("PRAGMA synchronous")).toEqual({ synchronous: 1 });
			} finally {
				await database.close();
			}
		}
	});

	it("commits work done through the transaction handle and closes idempotently", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.transaction(async (transaction) => {
			await transaction.exec("CREATE TABLE async_probe (value INTEGER)");
			await transaction.run("INSERT INTO async_probe (value) VALUES (?)", 1);
		});
		expect(await database.get("SELECT value FROM async_probe")).toEqual({ value: 1 });
		await database.close();
		await database.close();
	});

	it("serializes concurrent transactions", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE transaction_queue (value INTEGER)");
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = database.transaction(async (transaction) => {
			await transaction.exec("INSERT INTO transaction_queue (value) VALUES (1)");
			markFirstStarted();
			await firstGate;
		});
		await firstStarted;

		let secondStarted = false;
		const second = database.transaction(async (transaction) => {
			secondStarted = true;
			await transaction.exec("INSERT INTO transaction_queue (value) VALUES (2)");
		});
		await Promise.resolve();
		expect(secondStarted).toBe(false);

		releaseFirst();
		await Promise.all([first, second]);
		expect(await database.all("SELECT value FROM transaction_queue ORDER BY value")).toEqual([
			{ value: 1 },
			{ value: 2 },
		]);
		await database.close();
	});

	it("runs operations in call order whether they start immediately or wait", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE call_order (value INTEGER)");
		// Operations called during a transaction must neither see its uncommitted rows nor join its rollback.
		const transaction = database.transaction(async (handle) => {
			await handle.run("INSERT INTO call_order (value) VALUES (?)", 1);
			await Promise.resolve();
			throw new Error("roll back");
		});
		const beforeWrite = database.all("SELECT value FROM call_order ORDER BY value");
		const write = database.run("INSERT INTO call_order (value) VALUES (?)", 2);
		const afterWrite = database.all("SELECT value FROM call_order ORDER BY value");
		await expect(transaction).rejects.toThrow("roll back");
		await write;
		expect(await beforeWrite).toEqual([]);
		expect(await afterWrite).toEqual([{ value: 2 }]);

		await database.close();
	});

	it("queues ordinary operations behind an active transaction", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE operation_queue (value INTEGER)");
		let markTransactionStarted!: () => void;
		const transactionStarted = new Promise<void>((resolve) => {
			markTransactionStarted = resolve;
		});
		let releaseTransaction!: () => void;
		const transactionGate = new Promise<void>((resolve) => {
			releaseTransaction = resolve;
		});
		const pending = database.transaction(async (transaction) => {
			await transaction.exec("INSERT INTO operation_queue (value) VALUES (1)");
			markTransactionStarted();
			await transactionGate;
		});
		await transactionStarted;

		let writeSettled = false;
		const write = database.exec("INSERT INTO operation_queue (value) VALUES (2)").finally(() => {
			writeSettled = true;
		});
		let readSettled = false;
		const read = database.all("SELECT value FROM operation_queue ORDER BY value").finally(() => {
			readSettled = true;
		});
		await Promise.resolve();
		expect(writeSettled).toBe(false);
		expect(readSettled).toBe(false);

		releaseTransaction();
		await pending;
		await write;
		await expect(read).resolves.toEqual([{ value: 1 }, { value: 2 }]);
		await database.close();
	});

	it("queues database calls made synchronously by a transaction that started immediately", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE barrier_probe (value INTEGER)");
		let outside!: Promise<void>;
		const transaction = database.transaction(async (handle) => {
			// Misuse: this call must wait for the transaction instead of joining it.
			outside = database.run("INSERT INTO barrier_probe (value) VALUES (?)", 2);
			await handle.run("INSERT INTO barrier_probe (value) VALUES (?)", 1);
			await Promise.resolve();
			throw new Error("roll back");
		});
		await expect(transaction).rejects.toThrow("roll back");
		await outside;
		expect(await database.all("SELECT value FROM barrier_probe")).toEqual([{ value: 2 }]);
		await database.close();
	});

	it("rejects a transaction handle used after its transaction settles", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE stale_probe (value INTEGER)");
		let handle!: SqliteExecutor;
		await database.transaction(async (transaction) => {
			handle = transaction;
			await transaction.run("INSERT INTO stale_probe (value) VALUES (?)", 1);
		});
		const stale = "SQLite transaction handle is no longer active";
		await expect(handle.exec("INSERT INTO stale_probe (value) VALUES (2)")).rejects.toThrow(stale);
		await expect(handle.run("INSERT INTO stale_probe (value) VALUES (?)", 3)).rejects.toThrow(stale);
		expect(await database.all("SELECT value FROM stale_probe")).toEqual([{ value: 1 }]);
		await database.close();
	});

	it("does not preserve the callback error when rollback itself fails", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE rollback_probe (value INTEGER)");
		await expect(
			database.transaction(async (transaction) => {
				await transaction.exec("INSERT INTO rollback_probe (value) VALUES (1)");
				await transaction.exec("COMMIT");
				throw new Error("rejected after an escaped commit");
			}),
		).rejects.toThrow(AggregateError);
		expect(await database.get("SELECT value FROM rollback_probe")).toEqual({ value: 1 });
		await database.close();
	});

	it("refuses a newer schema in its preflight without touching the file", () =>
		withDirectory(async (directory) => {
			const path = join(directory, "app.sqlite");
			writeVersioned(path, 3);
			const before = snapshot(directory);
			const error = await openNodeSqliteDatabase(path, { preflight: checkApp }).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(SqliteSchemaError);
			expect(error).toMatchObject({ kind: "newer-schema", version: 3, supportedVersion: 2 });
			expect(snapshot(directory)).toEqual(before);
			// Without a preflight the open enables WAL first, which rewrites the header.
			await (await openNodeSqliteDatabase(path)).close();
			expect(snapshot(directory)).not.toEqual(before);
		}));

	it("fails a file that is not SQLite in its preflight and leaves no -wal or -shm", () =>
		withDirectory(async (directory) => {
			const path = join(directory, "app.sqlite");
			writeFileSync(path, "not a database ".repeat(100));
			const before = snapshot(directory);
			await expect(preflightNodeSqliteFile(path)).rejects.toMatchObject({ errcode: 26 });
			expect(snapshot(directory)).toEqual(before);
		}));

	it("reads an uncheckpointed -wal through a private copy, so a newer commit in it is seen", () =>
		withDirectory(async (directory) => {
			const source = join(directory, "source");
			writeVersioned(`${source}.sqlite`, 2);
			const writer = new DatabaseSync(`${source}.sqlite`);
			writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; UPDATE app_schema SET version = 3");
			const crashed = join(directory, "crashed");
			mkdirSync(crashed);
			const path = join(crashed, "app.sqlite");
			copyFileSync(`${source}.sqlite`, path);
			copyFileSync(`${source}.sqlite-wal`, `${path}-wal`);
			writer.close();
			const before = snapshot(crashed);
			expect(Object.keys(before)).toEqual(["app.sqlite", "app.sqlite-wal"]);
			// A copy a killed preflight left behind is removed; this preflight's own copy is removed after use.
			mkdirSync(join(crashed, ".preflight-stale"));
			writeFileSync(join(crashed, ".preflight-stale", "database.sqlite"), "left by SIGKILL");
			await expect(preflightNodeSqliteFile(path, checkApp)).rejects.toMatchObject({ kind: "newer-schema", version: 3 });
			expect(snapshot(crashed)).toEqual(before);
		}));

	it("lets a current database through its preflight and opens it", () =>
		withDirectory(async (directory) => {
			const path = join(directory, "app.sqlite");
			writeVersioned(path, 2);
			const database = await openNodeSqliteDatabase(path, { preflight: checkApp });
			expect(await database.get("SELECT version FROM app_schema")).toEqual({ version: 2 });
			await database.close();
			await expect(preflightNodeSqliteFile(join(directory, "missing.sqlite"), checkApp)).resolves.toBeUndefined();
		}));

	it("reports a full disk during a migration as the original SQLite error and leaves the file alone", () =>
		withDirectory(async (directory) => {
			const path = join(directory, "app.sqlite");
			const setup = await openNodeSqliteDatabase(path);
			await applySqliteMigrations(setup, [{ version: 1, statements: ["CREATE TABLE notes (body TEXT)"] }], {
				table: "app_schema",
			});
			await setup.close();
			const before = snapshot(directory);
			const database = await openNodeSqliteDatabase(path, { preflight: checkApp });
			try {
				const full = [
					{ version: 1, statements: ["CREATE TABLE notes (body TEXT)"] },
					{
						version: 2,
						statements: [
							// The file may not grow, so the next write fails with SQLITE_FULL.
							"PRAGMA max_page_count = 1",
							"INSERT INTO notes (body) VALUES (zeroblob(1000000))",
						],
					},
				];
				const error = await applySqliteMigrations(database, full, { table: "app_schema" }).catch(
					(caught: unknown) => caught,
				);
				expect(error).not.toBeInstanceOf(SqliteSchemaError);
				expect(error).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 13 });
				expect(isSqliteResourceError(error)).toBe(true);
			} finally {
				await database.close();
			}
			expect(snapshot(directory)).toEqual(before);
		}));

	it("recognizes SQLITE_FULL and SQLITE_IOERR, including extended codes", () => {
		expect(isSqliteResourceError({ errcode: 13 })).toBe(true);
		expect(isSqliteResourceError({ errcode: 10 })).toBe(true);
		expect(isSqliteResourceError({ errcode: 10 | (3 << 8) })).toBe(true); // SQLITE_IOERR_WRITE
		expect(isSqliteResourceError({ errcode: 26 })).toBe(false);
		expect(isSqliteResourceError(new Error("disk full"))).toBe(false);
	});
});
