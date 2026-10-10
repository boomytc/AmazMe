import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";

export interface SessionFileFingerprint {
	readonly hash: string;
	readonly device: string;
	readonly inode: string;
	readonly size: string;
	readonly modified: string;
}

export interface SessionFileSnapshot {
	readonly content: string;
	readonly fingerprint: SessionFileFingerprint;
}

export class SessionMirrorConflict extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionMirrorConflict";
	}
}

/** Include file identity and mtime so replacement or touching identical bytes is not mistaken for our write. */
export function sameSessionFile(left: SessionFileFingerprint | undefined, right: SessionFileFingerprint | undefined): boolean {
	return left === undefined || right === undefined
		? left === right
		: left.hash === right.hash && left.device === right.device && left.inode === right.inode &&
			left.size === right.size && left.modified === right.modified;
}

/** Read a stable regular file; a missing file is distinct from an unreadable or changing one. */
export async function readSessionFileSnapshot(path: string): Promise<SessionFileSnapshot | undefined> {
	let before;
	try { before = await lstat(path, { bigint: true }); }
	catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	if (!before.isFile()) throw new SessionMirrorConflict("target is not a regular file");
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await file.stat({ bigint: true });
		const content = await file.readFile();
		const after = await file.stat({ bigint: true });
		const current = await lstat(path, { bigint: true });
		if (before.dev !== opened.dev || before.ino !== opened.ino ||
			opened.dev !== current.dev || opened.ino !== current.ino ||
			opened.size !== after.size || opened.mtimeNs !== after.mtimeNs ||
			after.size !== BigInt(content.length) || after.mtimeNs !== current.mtimeNs) {
			throw new SessionMirrorConflict("target changed while being read");
		}
		return {
			content: content.toString("utf8"),
			fingerprint: {
				hash: createHash("sha256").update(content).digest("hex"),
				device: after.dev.toString(),
				inode: after.ino.toString(),
				size: after.size.toString(),
				modified: after.mtimeNs.toString(),
			},
		};
	} finally { await file.close(); }
}

export async function assertSessionFileUnchanged(path: string, expected: SessionFileFingerprint | undefined): Promise<void> {
	if (!sameSessionFile(expected, (await readSessionFileSnapshot(path))?.fingerprint)) {
		throw new SessionMirrorConflict("terminal file was changed by another writer");
	}
}
