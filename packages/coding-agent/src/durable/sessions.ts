import { createHash, randomUUID } from "node:crypto";
import {
	access,
	mkdir,
	readdir,
	realpath,
	rm,
	stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { expandTildePath, getAgentDir } from "../config.ts";

/**
 * How long a crashed process's session lock stays reserved.
 * A live holder refreshes the lock before this elapses. proper-lockfile's own
 * refresh interval is left at its default, half of this value.
 */
export const SESSION_LOCK_STALE_MS = 10_000;

/** A session lease; persistent sessions own a locked directory containing `session.sqlite`. */
export interface SessionLocation {
	id: string;
	directory?: string;
	database?: string;
	cwd: string;
	created: boolean;
	/**
	 * Host-owned directory for session-scoped tool artifacts (code-mode output, review snapshots).
	 * Persistent sessions use `<directory>/artifacts` (deleted with the session directory).
	 * Ephemeral / `--no-session` sessions get a private `amazme-session-artifacts-` temp directory
	 * removed in {@link SessionLocation.release}.
	 */
	artifactDirectory: string;
	release(): Promise<void>;
}

function sessionRoot(cwd: string, sessionDir: string | undefined): string {
	const base =
		sessionDir === undefined
			? join(getAgentDir(), "experimental", "durable-sessions")
			: resolve(cwd, expandTildePath(sessionDir));
	return join(
		base,
		createHash("sha256").update(cwd).digest("hex").slice(0, 24),
	);
}

/** JSONL transcripts written by the removed session kernel, under the default sessions directory. */
async function legacyJsonlExists(cwd: string): Promise<boolean> {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	try {
		const names = await readdir(join(getAgentDir(), "sessions", safePath));
		return names.some((name) => name.endsWith(".jsonl"));
	} catch {
		return false;
	}
}

async function hasDatabase(directory: string): Promise<boolean> {
	try {
		await access(join(directory, "session.sqlite"));
		return true;
	} catch {
		return false;
	}
}

function sessionAlreadyOpenError(directory: string, cause: unknown): Error {
	const seconds = SESSION_LOCK_STALE_MS / 1000;
	return new Error(
		`Session is already open in another process: ${directory}. ` +
			`If that process crashed, wait about ${seconds} seconds and run again to take over the session.`,
		{ cause },
	);
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error))
		return undefined;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

/** Fail at once when a live process holds `directory`. A lock older than {@link SESSION_LOCK_STALE_MS} is taken over by proper-lockfile. */
export async function lockSession(
	directory: string,
): Promise<() => Promise<void>> {
	try {
		return await lockfile.lock(directory, {
			realpath: false,
			stale: SESSION_LOCK_STALE_MS,
			retries: 0,
		});
	} catch (error) {
		// Only a held lock is a session conflict. Permission and missing-path errors stay as they are.
		if (errorCode(error) !== "ELOCKED") throw error;
		throw sessionAlreadyOpenError(directory, error);
	}
}

/** Whether `cwd` already has a persisted Durable session in the selected root. */
export async function hasDurableSession(
	cwd: string,
	options: { sessionDir?: string } = {},
): Promise<boolean> {
	try {
		const root = sessionRoot(await realpath(resolve(cwd)), options.sessionDir);
		const entries = await readdir(root, { withFileTypes: true });
		const candidates = entries.filter(
			(entry) =>
				entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name),
		);
		return (
			await Promise.all(
				candidates.map((entry) => hasDatabase(join(root, entry.name))),
			)
		).some(Boolean);
	} catch {
		return false;
	}
}

/**
 * Resolve `--session` to exactly one existing session: an ID in this cwd's storage group, or a session directory.
 * Nothing is created. A missing or ambiguous ID fails instead of opening another session.
 */
export async function resolveExplicitSession(
	cwdInput: string,
	spec: string,
	options: { sessionDir?: string } = {},
): Promise<{ directory: string; cwd: string }> {
	const cwd = await realpath(resolve(cwdInput));
	const asPath = resolve(cwd, expandTildePath(spec));
	try {
		if ((await stat(asPath)).isDirectory()) {
			await access(join(asPath, "session.sqlite"));
			const directory = await realpath(asPath);
			return { directory, cwd: (await readSessionCwd(directory)) ?? cwd };
		}
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	const root = sessionRoot(cwd, options.sessionDir);
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error))
			throw new Error(`No durable session matches "${spec}" for ${cwd}`);
		throw error;
	}
	const candidates: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !matchesSessionId(entry.name, spec)) continue;
		if (await hasDatabase(join(root, entry.name))) candidates.push(entry.name);
	}
	if (candidates.length === 0)
		throw new Error(`No durable session matches "${spec}" for ${cwd}`);
	if (candidates.length > 1) {
		throw new Error(
			`Session "${spec}" is ambiguous for ${cwd}: ${candidates.sort().join(", ")}`,
		);
	}
	const directory = join(root, candidates[0]!);
	return { directory, cwd: (await readSessionCwd(directory)) ?? cwd };
}

/** A full session ID, its UUID part, or a unique timestamp prefix. */
function matchesSessionId(name: string, spec: string): boolean {
	return (
		name === spec || name.endsWith(`-${spec}`) || name.startsWith(`${spec}-`)
	);
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

/** The recorded cwd, read without importing the Harness module into every session-listing caller. */
async function readSessionCwd(directory: string): Promise<string | undefined> {
	const { readDurableSessionCwd } = await import("./session-cwd.ts");
	return readDurableSessionCwd(directory);
}

/** A fresh memory session, a new persisted session, or the newest persisted session for `cwd`. */
export async function selectSession(
	cwdInput: string,
	continueSession: boolean,
	options: {
		sessionDir?: string;
		noSession?: boolean;
		sessionDirectory?: string;
	} = {},
): Promise<SessionLocation> {
	if (
		options.noSession &&
		(continueSession || options.sessionDirectory !== undefined)
	) {
		throw new Error(
			"--no-session cannot be combined with --continue or an explicit session",
		);
	}
	const cwd = await realpath(resolve(cwdInput));
	if (options.noSession) {
		// Lazy path only: do not mkdtemp here. An unused lease that never releases must leave no
		// empty directory behind; writers create the directory on first use (recursive mkdir).
		const artifactDirectory = join(
			tmpdir(),
			`amazme-session-artifacts-${randomUUID()}`,
		);
		return {
			id: randomUUID(),
			cwd,
			created: true,
			artifactDirectory,
			release: async () => {
				await rm(artifactDirectory, { recursive: true, force: true });
			},
		};
	}
	if (options.sessionDirectory !== undefined) {
		const directory = await realpath(resolve(options.sessionDirectory));
		const database = join(directory, "session.sqlite");
		await access(database).catch(() => {
			throw new Error(`Not a Durable session directory: ${directory}`);
		});
		const release = await lockSession(directory);
		return {
			id: basename(directory),
			directory,
			database,
			cwd,
			created: false,
			artifactDirectory: join(directory, "artifacts"),
			release,
		};
	}
	const root = sessionRoot(cwd, options.sessionDir);
	await mkdir(root, { recursive: true });

	let directory: string;
	let created = false;
	if (continueSession) {
		const entries = await readdir(root, { withFileTypes: true });
		const candidates = entries
			.filter(
				(entry) =>
					entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name),
			)
			.map((entry) => entry.name)
			.sort()
			.reverse();
		let newest: string | undefined;
		for (const candidate of candidates) {
			if (await hasDatabase(join(root, candidate))) {
				newest = candidate;
				break;
			}
		}
		if (newest === undefined) {
			if (await legacyJsonlExists(cwd)) {
				throw new Error(
					`No Durable session exists for ${cwd}. JSONL history is still on disk. Run \`amazme import <session.jsonl>\` before --continue.`,
				);
			}
			throw new Error(`No durable session exists for ${cwd}`);
		}
		directory = join(root, newest);
	} else {
		directory = join(
			root,
			`${String(Date.now()).padStart(13, "0")}-${randomUUID()}`,
		);
		await mkdir(directory);
		created = true;
	}

	const release = await lockSession(directory);
	return {
		id: basename(directory),
		directory,
		database: join(directory, "session.sqlite"),
		cwd,
		created,
		artifactDirectory: join(directory, "artifacts"),
		release,
	};
}
