import type { SqliteDatabase, SqliteExecutor } from "./database.ts";
import { validateSqliteSchemaPrefix } from "./schema.ts";

export type SqliteMigration = {
	readonly version: number;
	readonly statements: readonly string[];
};

type SchemaRow = { readonly version: number };

async function readSchemaVersion(database: SqliteExecutor, table: string, currentVersion: number): Promise<number> {
	const row = await database.get<SchemaRow>(`SELECT version FROM ${table} WHERE singleton = 1`);
	if (row === undefined) throw new Error("SQLite schema metadata is missing");
	if (!Number.isSafeInteger(row.version) || row.version < 0) throw new Error("SQLite schema version is invalid");
	if (row.version > currentVersion)
		throw new Error(`SQLite schema version ${row.version} is newer than supported version ${currentVersion}`);
	return row.version;
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
			for (const statement of migration.statements) await transaction.exec(statement);
			await transaction.run(`UPDATE ${table} SET version = ? WHERE singleton = 1`, migration.version);
		}
	});
}
