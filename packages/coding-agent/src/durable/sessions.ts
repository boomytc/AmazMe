import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { expandTildePath, getAgentDir } from "../config.ts";

/** A session lease; persistent sessions own a locked directory containing `session.sqlite`. */
export interface SessionLocation {
	id: string;
	directory?: string;
	database?: string;
	cwd: string;
	created: boolean;
	release(): Promise<void>;
}

function sessionRoot(cwd: string, sessionDir: string | undefined): string {
	const base = sessionDir === undefined
		? join(getAgentDir(), "experimental", "durable-sessions")
		: resolve(cwd, expandTildePath(sessionDir));
	return join(base, createHash("sha256").update(cwd).digest("hex").slice(0, 24));
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

/** Whether `cwd` already has a persisted Durable session in the selected root. */
export async function hasDurableSession(
	cwd: string,
	options: { sessionDir?: string } = {},
): Promise<boolean> {
	try {
		const root = sessionRoot(await realpath(resolve(cwd)), options.sessionDir);
		const entries = await readdir(root, { withFileTypes: true });
		const candidates = entries.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name));
		return (await Promise.all(candidates.map((entry) => hasDatabase(join(root, entry.name))))).some(Boolean);
	} catch {
		return false;
	}
}

/** A fresh memory session, a new persisted session, or the newest persisted session for `cwd`. */
export async function selectSession(
	cwdInput: string,
	continueSession: boolean,
	options: { sessionDir?: string; noSession?: boolean; sessionDirectory?: string } = {},
): Promise<SessionLocation> {
	if (options.noSession && (continueSession || options.sessionDirectory !== undefined)) {
		throw new Error("--no-session cannot be combined with --continue or an explicit session");
	}
	const cwd = await realpath(resolve(cwdInput));
	if (options.noSession) return { id: randomUUID(), cwd, created: true, release: async () => {} };
	if (options.sessionDirectory !== undefined) {
		const directory = await realpath(resolve(options.sessionDirectory));
		const database = join(directory, "session.sqlite");
		await access(database).catch(() => {
			throw new Error(`Not a Durable session directory: ${directory}`);
		});
		let release: () => Promise<void>;
		try {
			release = await lockfile.lock(directory, {
				realpath: false,
				retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 },
			});
		} catch (error) {
			throw new Error(`Session is already open in another process: ${directory}`, { cause: error });
		}
		return { id: basename(directory), directory, database, cwd, created: false, release };
	}
	const root = sessionRoot(cwd, options.sessionDir);
	await mkdir(root, { recursive: true });

	let directory: string;
	let created = false;
	if (continueSession) {
		const entries = await readdir(root, { withFileTypes: true });
		const candidates = entries
			.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name))
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
		directory = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
		await mkdir(directory);
		created = true;
	}

	let release: () => Promise<void>;
	try {
		// A lock left by a crashed process goes stale after 10 s; wait that long before giving up.
		release = await lockfile.lock(directory, {
			realpath: false,
			retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 },
		});
	} catch (error) {
		throw new Error(`Session is already open in another process: ${directory}`, { cause: error });
	}
	return { id: basename(directory), directory, database: join(directory, "session.sqlite"), cwd, created, release };
}
