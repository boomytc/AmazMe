import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.ts";

/** A read-only check of an existing database file, run before anything can write to it. Throw to refuse the open. */
export type NodeSqlitePreflight = (reader: SqliteExecutor) => void | Promise<void>;

/** Node SQLite connection settings for a database file. */
export type NodeSqliteDatabaseOptions = {
	/** SQLite WAL auto-checkpoint threshold. SQLite and this adapter default to 1,000 pages; 0 disables it. */
	readonly walAutoCheckpointPages?: number;
	/** Time SQLite waits for a competing file lock. SQLite defaults to 0; this adapter defaults to 5,000 ms. */
	readonly busyTimeoutMs?: number;
	/**
	 * Inspect an existing file before the first write (`journal_mode`, migrations, the closing checkpoint). When set,
	 * the file is read without modifying, creating, or checkpointing the database, `-wal`, or `-shm`; a file that is not
	 * SQLite fails here. Omit it to open without a preflight.
	 */
	readonly preflight?: NodeSqlitePreflight;
};

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

type TransactionScope = { active: boolean };

const ignore = (): void => {};

/**
 * Runs operations in call order. An operation starts immediately when nothing is running or waiting;
 * otherwise it waits for everything before it. An asynchronous operation holds the queue until it settles.
 */
class SerialOperationQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;

	run<T>(operation: () => T): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		try {
			return Promise.resolve(operation());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	runAsync<T>(operation: () => Promise<T>): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		this.pending++;
		// Publish the barrier before the operation starts, so calls it makes synchronously wait behind it.
		const { promise: barrier, resolve: releaseBarrier } = Promise.withResolvers<void>();
		this.tail = barrier;
		let started: Promise<T>;
		try {
			started = operation();
		} catch (error) {
			started = Promise.reject(error);
		}
		return started.finally(() => {
			this.pending--;
			releaseBarrier();
		});
	}

	private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
		this.pending++;
		return this.release(this.tail.then(operation));
	}

	private release<T>(operation: Promise<T>): Promise<T> {
		const settled = operation.finally(() => {
			this.pending--;
		});
		this.tail = settled.then(ignore, ignore);
		return settled;
	}
}

/**
 * Executes SQL on one connection. Prepared statements are cached per connection by SQL text, so the
 * database and its transaction handles share them across transactions.
 */
abstract class NodeSqliteExecutor implements SqliteExecutor {
	protected readonly database: DatabaseSync;
	protected readonly statements: Map<string, StatementSync>;

	constructor(database: DatabaseSync, statements: Map<string, StatementSync>) {
		this.database = database;
		this.statements = statements;
	}

	exec(sql: string): Promise<void> {
		return this.runOperation(() => {
			this.database.exec(sql);
		});
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.runOperation(() => {
			this.statement(sql).run(...params);
		});
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.runOperation(() => this.statement(sql).get(...params) as T | undefined);
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.runOperation(() => this.statement(sql).all(...params) as T[]);
	}

	protected abstract runOperation<T>(operation: () => T): Promise<T>;

	private statement(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (statement === undefined) {
			statement = this.database.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}
}

class NodeSqliteTransaction extends NodeSqliteExecutor {
	private readonly scope: TransactionScope;

	constructor(database: DatabaseSync, statements: Map<string, StatementSync>, scope: TransactionScope) {
		super(database, statements);
		this.scope = scope;
	}

	protected async runOperation<T>(operation: () => T): Promise<T> {
		if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
		return operation();
	}
}

/** `SqliteDatabase` adapter backed by Node's built-in `node:sqlite`. */
export class NodeSqliteDatabase extends NodeSqliteExecutor implements SqliteDatabase {
	private readonly access = new SerialOperationQueue();
	private closed = false;

	constructor(database: DatabaseSync) {
		super(database, new Map());
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.access.runAsync(async () => {
			this.database.exec("BEGIN IMMEDIATE");
			const scope = { active: true };
			try {
				const result = await callback(new NodeSqliteTransaction(this.database, this.statements, scope));
				scope.active = false;
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}

	close(): Promise<void> {
		return this.access.run(() => {
			if (this.closed) return;
			this.closed = true;
			this.statements.clear();
			try {
				this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				this.database.close();
			}
		});
	}

	protected runOperation<T>(operation: () => T): Promise<T> {
		return this.access.run(operation);
	}
}

async function fileSize(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function inspect(location: string | URL, check: NodeSqlitePreflight | undefined): Promise<void> {
	const database = new DatabaseSync(location, { readOnly: true });
	try {
		const reader = new NodeSqliteDatabase(database);
		// The first read parses the header, so a file that is not SQLite fails here.
		await reader.get("SELECT count(*) AS count FROM sqlite_schema");
		await check?.(reader);
	} finally {
		database.close();
	}
}

/**
 * Read an existing database file without changing it, then run `check` on it. Nothing happens when the file does not
 * exist. Without a `-wal`, the file is opened `immutable`, which writes no `-wal`/`-shm` and takes no locks. An
 * immutable open ignores the `-wal`, so when one has content (a crash left it uncheckpointed), the file and its `-wal`
 * are copied to a private temporary directory and read there, which sees the committed state without touching the
 * originals. The caller must keep other writers out (session locks do).
 */
export async function preflightNodeSqliteFile(path: string, check?: NodeSqlitePreflight): Promise<void> {
	if (path === ":memory:" || path === "" || path.startsWith("file:")) return;
	if ((await fileSize(path)) === undefined) return;
	if (((await fileSize(`${path}-wal`)) ?? 0) === 0) {
		const url = pathToFileURL(path);
		url.searchParams.set("immutable", "1");
		await inspect(url, check);
		return;
	}
	const directory = await mkdtemp(join(tmpdir(), "amazme-sqlite-preflight-"));
	try {
		const copy = join(directory, "database.sqlite");
		await copyFile(path, copy);
		await copyFile(`${path}-wal`, `${copy}-wal`);
		await inspect(copy, check);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Open and configure a Node-backed SQLite database facade. */
export async function openNodeSqliteDatabase(
	path: string,
	options: NodeSqliteDatabaseOptions = {},
): Promise<NodeSqliteDatabase> {
	const checkpointPages = options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES;
	const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
	if (options.preflight !== undefined) await preflightNodeSqliteFile(path, options.preflight);
	if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
	const database = new DatabaseSync(path, { timeout });
	const adapter = new NodeSqliteDatabase(database);
	try {
		await adapter.exec("PRAGMA journal_mode = WAL");
		await adapter.exec("PRAGMA synchronous = NORMAL");
		await adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpointPages}`);
		return adapter;
	} catch (error) {
		try {
			await adapter.close();
		} catch {
			// Preserve the configuration failure.
		}
		throw error;
	}
}
