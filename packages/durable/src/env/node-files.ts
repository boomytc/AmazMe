import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Context } from "@amazme/chord";
import { awaitWithContext } from "@amazme/chord/context";
import { FileError, type FileRevision, type FileWriteIntent, type FileWriteOutcome } from "./index.ts";

export function fileVersion(stats: BigIntStats): string {
	return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}

export async function readFileRevision(path: string, context: Context): Promise<FileRevision> {
	context.abortSignal?.throwIfAborted();
	const canonical = await realpath(path);
	const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stats = await file.stat({ bigint: true });
		if (!stats.isFile())
			throw new FileError(stats.isDirectory() ? "is_directory" : "invalid", "Not a regular file", path);
		context.abortSignal?.throwIfAborted();
		return { path: canonical, version: fileVersion(stats) };
	} finally {
		await file.close();
	}
}

/** A missing file keeps its canonical parent identity, including through directory aliases. */
async function targetPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(await targetPath(parent), basename(path));
	}
}

const writes = new Map<string, Promise<void>>();

/** Checked writers in this process share a barrier; external writers are checked again before publication. */
export async function writeFileChecked(
	path: string,
	content: string | Uint8Array,
	intent: FileWriteIntent,
	context: Context,
): Promise<FileWriteOutcome> {
	intent = { ...intent };
	context.abortSignal?.throwIfAborted();
	const target = await targetPath(path);
	const previous = writes.get(target) ?? Promise.resolve();
	let release = (): void => {};
	const done = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => done);
	writes.set(target, tail);
	try {
		await awaitWithContext(previous, context);
		return await publish(path, target, content, intent, context);
	} finally {
		release();
		void tail.then(() => {
			if (writes.get(target) === tail) writes.delete(target);
		});
	}
}

async function inspect(target: string): Promise<BigIntStats | undefined> {
	try {
		return await lstat(target, { bigint: true });
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function check(path: string, target: string, intent: FileWriteIntent): Promise<BigIntStats | undefined> {
	if ((await targetPath(path)) !== target)
		throw new FileError("stale_version", "File target changed; read it again", path);
	const current = await inspect(target);
	if (intent.kind === "createIfAbsent") {
		if (current !== undefined) throw new FileError("not_observed", "Read the existing file before replacing it", path);
	} else if (current === undefined || !current.isFile() || fileVersion(current) !== intent.version) {
		throw new FileError("stale_version", "File changed since it was read; read it again", path);
	}
	return current;
}

async function publish(
	path: string,
	target: string,
	content: string | Uint8Array,
	intent: FileWriteIntent,
	context: Context,
): Promise<FileWriteOutcome> {
	context.abortSignal?.throwIfAborted();
	const current = await check(path, target, intent);
	await mkdir(dirname(target), { recursive: true });
	context.abortSignal?.throwIfAborted();
	const staging = join(dirname(target), `.${basename(target)}.${randomUUID()}.staging`);
	await mkdir(staging, { mode: 0o700 });
	const temporary = join(staging, "content");
	let file: FileHandle | undefined;
	let committed = false;
	let cleanupAttempted = false;
	try {
		file = await open(temporary, "wx", 0o600);
		await file.writeFile(content, { signal: context.abortSignal });
		if (current !== undefined) await file.chmod(Number(current.mode & 0o7777n));
		await file.sync();
		context.abortSignal?.throwIfAborted();
		await check(path, target, intent);
		context.abortSignal?.throwIfAborted();
		if (intent.kind === "createIfAbsent") {
			try {
				await link(temporary, target);
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
					throw new FileError("not_observed", "Another writer created the file; read it before replacing it", path);
				}
				throw error;
			}
		} else {
			await rename(temporary, target);
		}
		committed = true;
		// Removing the staging link changes ctime of a newly created file; capture its revision afterwards.
		cleanupAttempted = true;
		await rm(staging, { recursive: true, force: true }).catch(() => {});
		// This handle identifies our published bytes even if another process immediately replaces the path.
		const version = await file
			.stat({ bigint: true })
			.then(fileVersion)
			.catch(() => undefined);
		return {
			path: target,
			...(version === undefined ? {} : { version }),
			operation: intent.kind === "createIfAbsent" ? "create" : "replace",
		};
	} finally {
		try {
			await file?.close().catch((error: unknown) => {
				if (!committed) throw error;
			});
		} finally {
			if (!cleanupAttempted) {
				try {
					await rm(staging, { recursive: true, force: true });
				} catch (error) {
					if (!committed) throw error;
				}
			}
		}
	}
}
