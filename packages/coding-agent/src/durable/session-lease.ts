// Kept apart from session-database.ts so code that only locks sessions (sessions.ts, loaded by the CLI entry before
// it silences runtime warnings) does not load node:sqlite.

const LEASE: unique symbol = Symbol("SessionLease");

/**
 * Proof that this process holds a session directory's lock. Only {@link lockSessionDatabase} makes one, after its lock
 * call has resolved, so `openSessionStorage` cannot run (and its preflight cannot copy or clean up files next to
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
 * then return the lease that lets `openSessionStorage` open `database`.
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

/** Throw unless `lease` came from {@link lockSessionDatabase} and has not been released. */
export function assertSessionLeaseHeld(lease: SessionLease): void {
	const isReleased = leases.get(lease);
	if (isReleased === undefined) throw new Error("openSessionStorage requires a lease from lockSessionDatabase");
	if (isReleased()) throw new Error(`Session lock was already released: ${lease.directory}`);
}
