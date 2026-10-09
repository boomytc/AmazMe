import type { Context } from "@amazme/chord";
import { withoutAbortSignal } from "@amazme/chord/context";
import { getOrThrow } from "@amazme/durable/env";
import type { ExecutionEnv, FileRevision } from "@amazme/durable/env";
import { canonicalFilePath, withFileMutationQueue } from "@amazme/durable/file-operations";

export const MAX_FILE_BYTES = 262_144;
export const MAX_SNAPSHOT_BYTES = 1_048_576;
export type Image = { path: string; target: string; data: string | null; version: string | null };
export type Scope = { root: string; envId: string };

export async function scope(env: ExecutionEnv, context: Context): Promise<Scope> {
	return { root: await canonicalFilePath(env, env.cwd, context), envId: env.id };
}

export async function readImage(env: ExecutionEnv, path: string, context: Context): Promise<Image> {
	const absolute = getOrThrow(await env.absolutePath(path, context));
	const target = await canonicalFilePath(env, absolute, context);
	const root = (await scope(env, context)).root;
	const marker = ".checkpoint-root";
	const prefix = getOrThrow(await env.joinPath([root, marker], context)).slice(0, -marker.length);
	if (!target.startsWith(prefix)) throw new Error("Checkpoint path escapes the current project");
	const relative = target.slice(prefix.length);
	if (relative.split("/").some((part) => part === ".git" || part === ".amazme"))
		throw new Error("Checkpoint files cannot include Git or AmazMe internal state");
	const opened = await env.openBinaryReader(absolute, { noFollow: true }, context);
	if (!opened.ok) {
		if (opened.error.code === "not_found") return { path: relative, target, data: null, version: null };
		throw opened.error;
	}
	const reader = opened.value;
	try {
		const before = getOrThrow(await reader.revision(context));
		const size = getOrThrow(await reader.info(context)).size;
		if (size > MAX_FILE_BYTES) throw new Error(`Checkpoint file exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
		const bytes = new Uint8Array(size);
		for (let offset = 0; offset < size; ) {
			const chunk = getOrThrow(await reader.read(offset, size - offset, context));
			if (chunk.length === 0) throw new Error(`Checkpoint file changed during reading: ${path}`);
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		const after = getOrThrow(await reader.revision(context));
		const revision = getOrThrow(await env.fileRevision(absolute, context));
		if (before !== after || after !== revision.version || revision.path !== target)
			throw new Error(`Checkpoint file changed during reading: ${path}`);
		return { path: relative, target, data: Buffer.from(bytes).toString("base64"), version: revision.version };
	} finally {
		await reader.close(withoutAbortSignal(context));
	}
}

export function boundImages(files: readonly Image[]): void {
	const bytes = files.reduce(
		(total, file) => total + (file.data === null ? 0 : Buffer.byteLength(file.data, "base64")),
		0,
	);
	if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(`Checkpoint exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
	if (new Set(files.map((file) => file.target)).size !== files.length)
		throw new Error("Checkpoint paths resolve to duplicate files");
}

export function sameRevision(a: Image, b: Image): boolean {
	return a.target === b.target && a.version === b.version;
}

/** Caller holds every selected file's existing mutation queue throughout restore or rollback. */
export async function publish(
	env: ExecutionEnv,
	observed: Image,
	data: string | null,
	context: Context,
): Promise<Image> {
	const current = await readImage(env, observed.path, context);
	if (!sameRevision(current, observed)) throw new Error(`File changed since the restore preview: ${observed.path}`);
	if (current.data === data) return current;
	const revision: FileRevision = { path: observed.target, version: observed.version ?? "" };
	if (data === null) getOrThrow(await env.removeFileChecked(observed.target, revision, context));
	else
		getOrThrow(
			await env.writeFileChecked(
				observed.target,
				Buffer.from(data, "base64"),
				observed.version === null ? { kind: "createIfAbsent" } : { kind: "replaceIfVersion", revision },
				context,
			),
		);
	const result = await readImage(env, observed.path, context);
	if (result.target !== observed.target || result.data !== data)
		throw new Error(`Published checkpoint bytes changed before observation: ${observed.path}`);
	return result;
}

export function lockImages<T>(
	env: ExecutionEnv,
	files: readonly Image[],
	run: () => Promise<T>,
	context: Context,
): Promise<T> {
	const ordered = files.map((file) => file.target).sort();
	const acquire = (index: number): Promise<T> =>
		index === ordered.length ? run() : withFileMutationQueue(env, ordered[index]!, () => acquire(index + 1), context);
	return acquire(0);
}
