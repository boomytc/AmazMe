import { checkSqliteSchemaVersion, validateSqliteSchemaPrefix } from "@amazme/chord/sqlite";
import { type NodeSqliteDatabaseOptions, openNodeSqliteDatabase } from "@amazme/chord/sqlite/node";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "./migrations.ts";
import { createSqliteSchema } from "./schema.ts";
import { SqliteStorage, type SqliteStorageOptions } from "./storage.ts";

export {
	NodeSqliteDatabase,
	type NodeSqliteDatabaseOptions,
	openNodeSqliteDatabase,
} from "@amazme/chord/sqlite/node";

/** Node SQLite connection settings plus durable storage options. */
export type NodeSqliteStorageOptions = NodeSqliteDatabaseOptions & SqliteStorageOptions;

/**
 * Open or create file-backed durable storage using Node's built-in SQLite, optionally under a table prefix.
 *
 * An existing file is checked read-only first: a file that is not SQLite, or a schema newer than this release, is
 * refused before any write, so the database, `-wal`, and `-shm` are left exactly as they were. A failed migration rolls
 * back. Schema failures are `SqliteSchemaError` from `@amazme/chord/sqlite`.
 */
export async function openNodeSqliteStorage(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteStorage> {
	const { prefix, ...databaseOptions } = options;
	if (prefix !== undefined) validateSqliteSchemaPrefix(prefix);
	const table = createSqliteSchema(prefix).tables.durableSchema;
	return SqliteStorage.open(
		await openNodeSqliteDatabase(path, {
			preflight: (reader) => checkSqliteSchemaVersion(reader, { table, currentVersion: CURRENT_SQLITE_SCHEMA_VERSION }),
			...databaseOptions,
		}),
		{ prefix },
	);
}
