import type { Context } from "@amazme/chord";
import { awaitWithContext } from "@amazme/chord/context";
import { type ExecutionEnv, getOrThrow } from "../env/index.ts";

/** Tail of the mutation chain of each file, keyed by file system id and canonical path. */
const queues = new Map<string, Promise<void>>();

async function mutationKey(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const absolutePath = getOrThrow(await env.absolutePath(path, context));
	return `${env.id}\0${await canonicalFilePath(env, absolutePath, context)}`;
}

/**
 * The canonical path; for a file that does not exist yet, its canonical parent joined with its name, so a `write` that
 * creates a file and a later mutation of it share one key even under a symlinked directory.
 */
export async function canonicalFilePath(env: ExecutionEnv, absolutePath: string, context: Context): Promise<string> {
	const result = await env.canonicalPath(absolutePath, context);
	if (result.ok) return result.value;
	if (result.error.code !== "not_found") throw result.error;
	// The file system splits the path, so a name may contain characters that are separators elsewhere.
	const parent = getOrThrow(await env.joinPath([absolutePath, ".."], context));
	if (parent === absolutePath) throw result.error;
	const marker = ".amazme-name";
	const prefix = getOrThrow(await env.joinPath([parent, marker], context)).slice(0, -marker.length);
	if (!absolutePath.startsWith(prefix)) throw result.error;
	const name = absolutePath.slice(prefix.length);
	return getOrThrow(await env.joinPath([await canonicalFilePath(env, parent, context), name], context));
}

/**
 * Serialize `edit` and `write` mutations of one file within this process: same file system id and canonical path,
 * whichever environment object the call got. Other files, and other file systems, never wait. Concurrent calls on one
 * file run in the order their keys resolve. Not a lock against `bash` or other processes.
 */
export async function withFileMutationQueue<T>(
	env: ExecutionEnv,
	path: string,
	fn: () => Promise<T>,
	context: Context,
): Promise<T> {
	const key = await mutationKey(env, path, context);
	// Take the slot without awaiting, so no other call can take it in between.
	const previous = queues.get(key) ?? Promise.resolve();
	let release = (): void => {};
	const done = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => done);
	queues.set(key, tail);
	try {
		await awaitWithContext(previous, context);
		return await fn();
	} finally {
		release();
		void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
	}
}
