import type { SqliteDatabase, SqliteExecutor } from "./database.ts";
import { validateSqliteSchemaPrefix } from "./schema.ts";

export type SqliteMigration = {
	readonly version: number;
	readonly statements: readonly string[];
};

type SchemaRow = { readonly version: number };

/** Why a database's schema cannot be used: written by a newer release, bad metadata, or a failed migration step. */
export type SqliteSchemaErrorKind = "newer-schema" | "missing-metadata" | "invalid-version" | "migration-failed";

/** A schema version or migration failure. The message is unchanged from the untyped errors it replaces. */
export class SqliteSchemaError extends Error {
	readonly kind: SqliteSchemaErrorKind;
	/** The stored version (`newer-schema`) or the version being migrated to (`migration-failed`). */
	readonly version: number | undefined;
	readonly supportedVersion: number;

	constructor(
		kind: SqliteSchemaErrorKind,
		message: string,
		options: { readonly version?: number; readonly supportedVersion: number; readonly cause?: unknown },
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "SqliteSchemaError";
		this.kind = kind;
		this.version = options.version;
		this.supportedVersion = options.supportedVersion;
	}
}

/** SQLite primary result codes for environment failures: `SQLITE_IOERR` (and its extended codes) and `SQLITE_FULL`. */
const SQLITE_IOERR = 10;
const SQLITE_FULL = 13;

/** Whether `error` is a SQLite `SQLITE_FULL` or `SQLITE_IOERR*` failure (extended codes included). */
export function isSqliteResourceError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("errcode" in error) || typeof error.errcode !== "number")
		return false;
	const primary = error.errcode & 0xff;
	return primary === SQLITE_IOERR || primary === SQLITE_FULL;
}

async function readSchemaVersion(database: SqliteExecutor, table: string, currentVersion: number): Promise<number> {
	const row = await database.get<SchemaRow>(`SELECT version FROM ${table} WHERE singleton = 1`);
	if (row === undefined)
		throw new SqliteSchemaError("missing-metadata", "SQLite schema metadata is missing", {
			supportedVersion: currentVersion,
		});
	if (!Number.isSafeInteger(row.version) || row.version < 0)
		throw new SqliteSchemaError("invalid-version", "SQLite schema version is invalid", {
			supportedVersion: currentVersion,
		});
	if (row.version > currentVersion)
		throw new SqliteSchemaError(
			"newer-schema",
			`SQLite schema version ${row.version} is newer than supported version ${currentVersion}`,
			{ version: row.version, supportedVersion: currentVersion },
		);
	return row.version;
}

/**
 * Read-only check that a database's schema can be opened by `currentVersion`: throws `SqliteSchemaError` for a newer or
 * malformed version. A database without the metadata table passes; migration creates it.
 */
export async function checkSqliteSchemaVersion(
	database: SqliteExecutor,
	options: { readonly table: string; readonly currentVersion: number },
): Promise<void> {
	validateSqliteSchemaPrefix(options.table);
	const existing = await database.get<{ name: string }>(
		"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
		options.table,
	);
	if (existing !== undefined) await readSchemaVersion(database, options.table, options.currentVersion);
}

/** Apply all pending migrations atomically, tracking their version in the named metadata table. */
export async function applySqliteMigrations(
	database: SqliteDatabase,
	migrations: readonly SqliteMigration[],
	options: { readonly table: string },
): Promise<void> {
	const { table } = options;
	validateSqliteSchemaPrefix(table);
	for (let index = 0; index < migrations.length; index++) {
		if (migrations[index]?.version !== index + 1) {
			throw new Error("SQLite migrations must have contiguous versions starting at 1");
		}
	}

	const currentVersion = migrations.at(-1)?.version ?? 0;
	// Reopening a current store only reads, even while another connection holds the writer lock.
	const existing = await database.get<{ name: string }>(
		"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
		table,
	);
	if (existing !== undefined && (await readSchemaVersion(database, table, currentVersion)) === currentVersion) return;

	await database.transaction(async (transaction) => {
		await transaction.exec(`CREATE TABLE IF NOT EXISTS ${table} (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT`);
		await transaction.run(`INSERT OR IGNORE INTO ${table} (singleton, version) VALUES (1, 0)`);
		// Another opener may have migrated while this one waited for the writer lock.
		const version = await readSchemaVersion(transaction, table, currentVersion);
		for (const migration of migrations) {
			if (migration.version <= version) continue;
			try {
				for (const statement of migration.statements) await transaction.exec(statement);
				await transaction.run(`UPDATE ${table} SET version = ? WHERE singleton = 1`, migration.version);
			} catch (error) {
				// A full disk or an I/O failure is about the machine, not the schema: report it as it is.
				if (isSqliteResourceError(error)) throw error;
				throw new SqliteSchemaError(
					"migration-failed",
					`SQLite migration to version ${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`,
					{ version: migration.version, supportedVersion: currentVersion, cause: error },
				);
			}
		}
	});
}
