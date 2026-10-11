/**
 * The terminal session store, as a host reads and writes it: the JSONL files `SessionManager`
 * lists and resumes under `<agentDir>/sessions/<encoded-cwd>/`. A host never edits a terminal
 * session's meaning — it reads one to seed a hosted session, writes the mirror of a hosted session
 * so the terminal's own list shows that session, and deletes a session's files when the host removes
 * it so the terminal's list drops it too.
 *
 * Reading goes through `SessionManager` itself, so the entries are exactly what the terminal would
 * load. Writing replaces the whole file from a projection that is deterministic for a given
 * transcript: a refresh cannot leave a half-written session behind, and the ids it writes are the
 * same every time.
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { durableEntriesToSessionFile, type SessionInteropReport } from "../core/session-interop.ts";
import { assertSessionFileUnchanged, readSessionFileSnapshot, SessionMirrorConflict } from "./session-mirror-file.ts";
import type { SessionFileFingerprint } from "./session-mirror-file.ts";
import {
	getDefaultSessionDir,
	SessionManager,
	SESSION_ARCHIVE_SUFFIX,
	type SessionEntry,
	type SessionHeader,
	type SessionInfo,
} from "../core/session-manager.ts";

/** One terminal session, as a host lists it. */
export interface LocalSession {
	readonly id: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly path: string;
	readonly name?: string;
}

/**
 * The terminal sessions of one working directory. A host lists the same project's sessions the
 * terminal's own picker would, not every session in the agent directory.
 */
export async function listLocalSessions(cwd: string): Promise<readonly LocalSession[]> {
	const sessions = await SessionManager.list(cwd, undefined, undefined, undefined, true);
	return sessions.map(localSession);
}

/** Match headers by their real directory, including history created through a symlink. */
export async function listProjectLocalSessions(directories: readonly string[]): Promise<readonly LocalSession[]> {
	const paths = new Map<string, Promise<string>>();
	const canonical = (cwd: string): Promise<string> => {
		let path = paths.get(cwd);
		if (!path) { path = realpath(cwd).catch(() => resolve(cwd)); paths.set(cwd, path); }
		return path;
	};
	const allowed = new Set(await Promise.all(directories.map(canonical)));
	const sessions = await SessionManager.listAll(undefined, undefined, undefined, true);
	const matches = await Promise.all(sessions.map(async session => allowed.has(await canonical(session.cwd)) ? localSession(session) : undefined));
	return matches.filter(session => session !== undefined);
}

function localSession(session: SessionInfo): LocalSession {
	return {
		id: session.id,
		cwd: session.cwd,
		createdAt: session.created.getTime(),
		path: session.path,
		...(session.name === undefined ? {} : { name: session.name }),
	};
}

/** One terminal session's header and entries, read with the terminal's own reader. */
export async function readLocalSession(
	cwd: string,
	id: string,
): Promise<{ readonly header: SessionHeader; readonly entries: readonly SessionEntry[] } | undefined> {
	const found = (await listLocalSessions(cwd)).find((session) => session.id === id);
	if (found === undefined) return undefined;
	const manager = SessionManager.open(found.path);
	const header = manager.getHeader();
	if (header === null) return undefined;
	return { header, entries: manager.getEntries() };
}

/**
 * The terminal's own file for one session, when it has one. A host reads it to seed a hosted session
 * and then keeps writing that same file, so the session stays one row in the terminal's list.
 */
export async function findLocalSessionPath(cwd: string, id: string): Promise<string | undefined> {
	return (await listLocalSessions(cwd)).find((session) => session.id === id)?.path;
}

/**
 * The file a session the host created for itself is mirrored into. Built from the session's creation
 * time and id the way the terminal names its own files, so the terminal's list reads the id and age
 * it would for a session it made itself.
 */
export function mirrorPath(cwd: string, sessionId: string, createdAt: number): string {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return join(getDefaultSessionDir(cwd), `${timestamp}_${sessionId}.jsonl`);
}

/**
 * Write the mirror of a hosted transcript into the terminal's store, replacing the file whole. The
 * report names what the projection could not carry, so a caller can log it rather than let the
 * terminal quietly miss entries.
 */
export interface SessionMirrorInput {
	readonly path: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly createdAt: number;
	/** The display name `/name` reads. Written as `session_info` so the terminal's own reader sees it. */
	readonly name?: string;
	readonly entries: readonly {
		readonly id: unknown;
		readonly kind: string;
		readonly model?: readonly import("@amazme/ai").Message[];
	}[];
}

/** Pure export, also used to recognize a previous mirror without trusting terminal-only content. */
export function projectSessionMirror(input: SessionMirrorInput): { readonly content: string; readonly report: SessionInteropReport } {
	const projection = durableEntriesToSessionFile(input.entries, {
		id: input.sessionId,
		cwd: input.cwd,
		timestamp: new Date(input.createdAt).toISOString(),
	});
	const entries = withSessionName(projection.entries, input.name);
	return { content: `${entries.map(line).join("\n")}\n`, report: projection.report };
}

/**
 * Replace only an unchanged target. The final check narrows, but cannot eliminate, the
 * check-to-rename race with non-cooperating writers on an existing file.
 */
export async function writeSessionMirror(input: SessionMirrorInput & { readonly guard: { readonly expected: SessionFileFingerprint | undefined } }): Promise<SessionInteropReport & { readonly fingerprint: SessionFileFingerprint }> {
	const projection = projectSessionMirror(input);
	await assertSessionFileUnchanged(input.path, input.guard.expected);
	await mkdir(dirname(input.path), { recursive: true });
	const temporary = `${input.path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(temporary, projection.content, { encoding: "utf8", flag: "wx" });
		const written = await readSessionFileSnapshot(temporary);
		if (written === undefined) throw new Error("Temporary mirror disappeared");
		await assertSessionFileUnchanged(input.path, input.guard.expected);
		if (input.guard.expected === undefined) {
			// Unlike rename, hard-link creation cannot overwrite a target created after the check.
			try { await link(temporary, input.path); }
			catch (error: unknown) {
				if (error instanceof Error && "code" in error && error.code === "EEXIST") {
					throw new SessionMirrorConflict("terminal file was created by another writer");
				}
				throw error;
			}
		} else {
			await rename(temporary, input.path);
		}
		return { ...projection.report, fingerprint: written.fingerprint };
	} finally {
		await rm(temporary, { force: true });
	}
}

/**
 * Record a display name on a terminal session file, the way `/name` does. An empty name clears it.
 * Returns the name the file now reports.
 */
export async function writeLocalSessionName(path: string, name: string): Promise<string | undefined> {
	const manager = SessionManager.open(path);
	manager.appendSessionInfo(name);
	return manager.getSessionName();
}

/**
 * Delete every terminal file of one session in `cwd`'s store. The roster lists a terminal session
 * from these files, so a session the host removes must lose them too, or it comes back as a
 * terminal row. The caller stops the session's worker first, so no mirror rewrites a deleted file.
 */
export async function deleteLocalSessionFiles(cwd: string, id: string): Promise<void> {
	const paths = (await listLocalSessions(cwd)).filter((session) => session.id === id).map((session) => session.path);
	const directory = getDefaultSessionDir(cwd);
	const markers = (await readdir(directory)).filter(name => name.endsWith(`_${id}.jsonl${SESSION_ARCHIVE_SUFFIX}`));
	await Promise.all([
		...paths.flatMap(path => [rm(path, { force: true }), rm(`${path}${SESSION_ARCHIVE_SUFFIX}`, { force: true })]),
		...markers.map(name => rm(join(directory, name), { force: true })),
	]);
}

/** A discovery marker hides the mirror in /resume without touching its append-only history. */
export async function setLocalSessionArchived(cwd: string, id: string, createdAt: number, archived: boolean): Promise<void> {
	const found = (await listLocalSessions(cwd)).filter(session => session.id === id).map(session => session.path);
	const paths = found.length > 0 ? found : [mirrorPath(cwd, id, createdAt)];
	for (const path of paths) {
		const marker = `${path}${SESSION_ARCHIVE_SUFFIX}`;
		if (archived) { await mkdir(dirname(marker), { recursive: true }); await writeFile(marker, ""); }
		else await rm(marker, { force: true });
	}
}

/** Append the name the terminal's `/name` reads. A blank name leaves the file without one. */
function withSessionName(
	entries: readonly (SessionHeader | SessionEntry)[],
	name: string | undefined,
): readonly (SessionHeader | SessionEntry)[] {
	const display = name?.trim() ?? "";
	if (display.length === 0) return entries;
	const parent = [...entries].reverse().find((entry) => entry.type !== "session");
	const header = entries.find((entry) => entry.type === "session");
	return [
		...entries,
		{
			type: "session_info",
			id: "session-name",
			parentId: parent?.id ?? null,
			timestamp: header?.timestamp ?? new Date(0).toISOString(),
			name: display,
		},
	];
}

function line(entry: SessionHeader | SessionEntry): string {
	return JSON.stringify(entry);
}
