import { isSqliteResourceError, SqliteSchemaError, type SqliteStorage } from "@amazme/durable/storage/sqlite";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";

/** Why a session database could not be opened. */
export type SessionOpenErrorKind =
	| "newer-schema"
	| "migration-failed"
	| "invalid-schema"
	| "not-a-database"
	| "corrupt";

/** The fields of a `SessionOpenError` that cross a process boundary (Session worker to server). */
export const SessionOpenErrorDataSchema = Type.Object({
	kind: Type.Union([
		Type.Literal("newer-schema"),
		Type.Literal("migration-failed"),
		Type.Literal("invalid-schema"),
		Type.Literal("not-a-database"),
		Type.Literal("corrupt"),
	]),
	path: Type.String({ minLength: 1 }),
	detail: Type.String(),
	version: Type.Optional(Type.Integer({ minimum: 0 })),
	supportedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type SessionOpenErrorData = Static<typeof SessionOpenErrorDataSchema>;

function reason(data: SessionOpenErrorData): string {
	switch (data.kind) {
		case "newer-schema":
			return data.version === undefined || data.supportedVersion === undefined
				? "it was written by a newer version of AmazMe."
				: `it was written by a newer version of AmazMe (schema version ${data.version}; this version supports up to ${data.supportedVersion}).`;
		case "migration-failed":
			return `upgrading it to the current format failed and was rolled back (${data.detail}).`;
		case "invalid-schema":
			return `its format information is missing or invalid (${data.detail}).`;
		case "not-a-database":
			return "the file is not a SQLite database. It may have been overwritten or damaged.";
		case "corrupt":
			return `the database file is damaged (${data.detail}).`;
	}
}

function remedy(data: SessionOpenErrorData): string {
	switch (data.kind) {
		case "newer-schema":
			return "Upgrade AmazMe to the latest version, then open this session again.";
		case "migration-failed":
			return "Keep a copy of the session directory and report this error. To keep working now, restore the file from a backup or move the session directory aside and start a new session.";
		case "invalid-schema":
		case "not-a-database":
		case "corrupt":
			return "Restore the file from a backup, or move the session directory aside and start a new session.";
	}
}

/** Readable text for a session database that cannot be opened: the path, the reason, and what to do. */
export function formatSessionOpenError(data: SessionOpenErrorData): string {
	return [
		`Cannot open session database ${data.path}`,
		`Reason: ${reason(data)}`,
		`What to do: ${remedy(data)} AmazMe did not create a new session in its place.`,
	].join("\n");
}

/**
 * A session database that exists but cannot be used. Nothing was written to it, and no session was created in its
 * place. The message is readable as is; `kind` and `path` let a host choose its own presentation.
 */
export class SessionOpenError extends Error {
	readonly kind: SessionOpenErrorKind;
	readonly path: string;
	/** The underlying SQLite or migration message. */
	readonly detail: string;
	readonly version: number | undefined;
	readonly supportedVersion: number | undefined;

	constructor(data: SessionOpenErrorData, options?: { readonly cause?: unknown }) {
		super(formatSessionOpenError(data), options);
		this.name = "SessionOpenError";
		this.kind = data.kind;
		this.path = data.path;
		this.detail = data.detail;
		this.version = data.version;
		this.supportedVersion = data.supportedVersion;
	}

	toJSON(): SessionOpenErrorData {
		return {
			kind: this.kind,
			path: this.path,
			detail: this.detail,
			...(this.version === undefined ? {} : { version: this.version }),
			...(this.supportedVersion === undefined ? {} : { supportedVersion: this.supportedVersion }),
		};
	}

	/** Rebuild an error sent across a process boundary; `undefined` when the value is not one. */
	static fromJSON(value: unknown): SessionOpenError | undefined {
		return Check(SessionOpenErrorDataSchema, value) ? new SessionOpenError(value) : undefined;
	}
}

/** The `SessionOpenError` inside `error`: itself, a cause, or one of an `AggregateError`'s errors. */
export function findSessionOpenError(error: unknown): SessionOpenError | undefined {
	const pending = [error];
	const seen = new Set<unknown>();
	while (pending.length > 0) {
		const current = pending.shift();
		if (current === undefined || current === null || seen.has(current)) continue;
		seen.add(current);
		if (current instanceof SessionOpenError) return current;
		if (current instanceof AggregateError) pending.push(...current.errors);
		if (current instanceof Error) pending.push(current.cause);
	}
	return undefined;
}

/** SQLite result codes (primary code, low byte) that mean the file itself is unusable. */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

function sqliteResultCode(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null || !("errcode" in error)) return undefined;
	return typeof error.errcode === "number" ? error.errcode & 0xff : undefined;
}

/**
 * The typed error for a failure opening the session database at `path`, or `undefined` when it is not about the file
 * itself (a busy lock, a missing directory, an I/O error) and should propagate unchanged.
 */
export function classifySessionDatabaseError(error: unknown, path: string): SessionOpenError | undefined {
	if (error instanceof SessionOpenError) return error;
	const seen = new Set<unknown>();
	for (let current = error; current !== undefined && current !== null && !seen.has(current); ) {
		seen.add(current);
		// A full disk or an I/O failure is about the machine, not the file: it propagates unchanged.
		if (isSqliteResourceError(current)) return undefined;
		const detail = current instanceof Error ? current.message : String(current);
		if (current instanceof SqliteSchemaError) {
			const kind: SessionOpenErrorKind =
				current.kind === "newer-schema"
					? "newer-schema"
					: current.kind === "migration-failed"
						? "migration-failed"
						: "invalid-schema";
			return new SessionOpenError(
				{
					kind,
					path,
					detail,
					...(current.version === undefined ? {} : { version: current.version }),
					supportedVersion: current.supportedVersion,
				},
				{ cause: error },
			);
		}
		const code = sqliteResultCode(current);
		if (code === SQLITE_NOTADB)
			return new SessionOpenError({ kind: "not-a-database", path, detail }, { cause: error });
		if (code === SQLITE_CORRUPT) return new SessionOpenError({ kind: "corrupt", path, detail }, { cause: error });
		current = current instanceof Error ? current.cause : undefined;
	}
	return undefined;
}

const LEASE: unique symbol = Symbol("SessionLease");

/**
 * Proof that this process holds a session directory's lock. Only {@link lockSessionDatabase} makes one, after its lock
 * call has resolved, so {@link openSessionStorage} cannot run (and its preflight cannot copy or clean up files next to
 * the database) while another process may be opening the same session.
 */
export interface SessionLease {
	readonly directory: string;
	readonly database: string;
	/** Release the lock; the lease cannot open storage afterwards. */
	release(): Promise<void>;
	readonly [LEASE]: true;
}

/**
 * Take the session directory's lock with `lock` (the host's own lock call and its semantics: fail when held, or wait),
 * then return the lease that lets {@link openSessionStorage} open `database`.
 */
export async function lockSessionDatabase(
	directory: string,
	database: string,
	lock: (directory: string) => Promise<() => Promise<void>>,
): Promise<SessionLease> {
	const unlock = await lock(directory);
	let released: Promise<void> | undefined;
	const lease: SessionLease = {
		directory,
		database,
		release: () => {
			released ??= unlock();
			return released;
		},
		[LEASE]: true,
	};
	leases.set(lease, () => released !== undefined);
	return lease;
}

const leases = new WeakMap<SessionLease, () => boolean>();

/**
 * The one entry every host (CLI, TUI, print, RPC, import, and the Session worker behind web and desktop) uses to open
 * a session's durable storage. It takes a {@link SessionLease}, so the read-only preflight and its `.preflight-*`
 * cleanup always run under the session lock. A database that exists but cannot be used is refused with
 * `SessionOpenError` before anything writes to it; the caller must not fall back to a new session.
 */
export async function openSessionStorage(lease: SessionLease): Promise<SqliteStorage> {
	const isReleased = leases.get(lease);
	if (isReleased === undefined) throw new Error("openSessionStorage requires a lease from lockSessionDatabase");
	if (isReleased()) throw new Error(`Session lock was already released: ${lease.directory}`);
	try {
		return await openNodeSqliteStorage(lease.database);
	} catch (error) {
		throw classifySessionDatabaseError(error, lease.database) ?? error;
	}
}
