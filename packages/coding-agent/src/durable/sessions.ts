import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
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

/** A fresh memory session, a new persisted session, or the newest persisted session for `cwd`. */
export async function selectSession(
	cwdInput: string,
	continueSession: boolean,
	options: { sessionDir?: string; noSession?: boolean } = {},
): Promise<SessionLocation> {
	if (options.noSession && continueSession) throw new Error("--no-session cannot be combined with --continue or --resume");
	const cwd = await realpath(resolve(cwdInput));
	if (options.noSession) return { id: randomUUID(), cwd, created: true, release: async () => {} };
	const base = options.sessionDir === undefined
		? join(getAgentDir(), "experimental", "durable-sessions")
		: resolve(cwd, expandTildePath(options.sessionDir));
	const root = join(base, createHash("sha256").update(cwd).digest("hex").slice(0, 24));
	await mkdir(root, { recursive: true });

	let directory: string;
	let created = false;
	if (continueSession) {
		const entries = await readdir(root, { withFileTypes: true });
		const newest = entries
			.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name))
			.map((entry) => entry.name)
			.sort()
			.at(-1);
		if (!newest) throw new Error(`No durable session exists for ${cwd}`);
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
