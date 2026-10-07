/**
 * The terminal session store, as a host reads and writes it: the JSONL files `SessionManager`
 * lists and resumes under `<agentDir>/sessions/<encoded-cwd>/`. A host never edits a terminal
 * session's meaning — it reads one to seed a hosted session, and writes the mirror of a hosted
 * session so the terminal's own list shows that session.
 *
 * Reading goes through `SessionManager` itself, so the entries are exactly what the terminal would
 * load. Writing replaces the whole file from a projection that is deterministic for a given
 * transcript: a refresh cannot leave a half-written session behind, and the ids it writes are the
 * same every time.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { durableEntriesToSessionFile, type SessionInteropReport } from "../core/session-interop.ts";
import {
	getDefaultSessionDir,
	SessionManager,
	type SessionEntry,
	type SessionHeader,
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
	const sessions = await SessionManager.list(cwd);
	return sessions.map((session) => ({
		id: session.id,
		cwd: session.cwd,
		createdAt: session.created.getTime(),
		path: session.path,
		...(session.name === undefined ? {} : { name: session.name }),
	}));
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
export async function writeSessionMirror(input: {
	readonly path: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly entries: readonly {
		readonly id: unknown;
		readonly kind: string;
		readonly model?: readonly import("@amazme/ai").Message[];
	}[];
}): Promise<SessionInteropReport> {
	const projection = durableEntriesToSessionFile(input.entries, {
		id: input.sessionId,
		cwd: input.cwd,
		timestamp: new Date(input.createdAt).toISOString(),
	});
	await mkdir(dirname(input.path), { recursive: true });
	const temporary = `${input.path}.tmp-${process.pid}`;
	await writeFile(temporary, `${projection.entries.map(line).join("\n")}\n`, "utf8");
	await rename(temporary, input.path);
	return projection.report;
}

function line(entry: SessionHeader | SessionEntry): string {
	return JSON.stringify(entry);
}
