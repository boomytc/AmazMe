import type { Context } from "@amazme/chord";
import { withoutAbortSignal } from "@amazme/chord/context";
import { getOrThrow } from "@amazme/durable/env";
import type { ExecutionEnv, FileRevision } from "@amazme/durable/env";
import { canonicalFilePath, withFileMutationQueue } from "@amazme/durable/file-operations";

export const MAX_MEMORY_BYTES = 32_768;
export const AUTO_CAPTURE = "<!-- auto-capture: true -->";
export type MemoryFile = { path: string; target: string; text: string; revision: FileRevision | undefined };

export async function memoryPath(env: ExecutionEnv, context: Context): Promise<string> {
	return getOrThrow(await env.joinPath([env.cwd, ".amazme", "memory.md"], context));
}

export async function candidateDirectory(env: ExecutionEnv, context: Context): Promise<string> {
	return getOrThrow(await env.joinPath([env.cwd, ".amazme", "memory", "inbox"], context));
}

export async function candidatePath(env: ExecutionEnv, id: string, context: Context): Promise<string> {
	if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))
		throw new Error("Candidate ID must be a UUID from list_candidates");
	return getOrThrow(await env.joinPath([await candidateDirectory(env, context), `${id}.md`], context));
}

/** Bounded stable read on one opened file; an absent memory has no captured revision. */
export async function readMemoryFile(env: ExecutionEnv, path: string, context: Context): Promise<MemoryFile> {
	const canonical = await canonicalFilePath(env, path, context);
	const root = await canonicalFilePath(env, env.cwd, context);
	const marker = ".memory-root";
	const prefix = getOrThrow(await env.joinPath([root, marker], context)).slice(0, -marker.length);
	if (!canonical.startsWith(prefix)) throw new Error("Memory path escapes the current project");
	const opened = await env.openBinaryReader(path, { noFollow: true }, context);
	if (!opened.ok) {
		if (opened.error.code === "not_found") return { path, target: canonical, text: "", revision: undefined };
		throw opened.error;
	}
	const reader = opened.value;
	try {
		const before = getOrThrow(await reader.revision(context));
		const size = getOrThrow(await reader.info(context)).size;
		if (size > MAX_MEMORY_BYTES) throw new Error(`Memory file exceeds ${MAX_MEMORY_BYTES} bytes`);
		const bytes = new Uint8Array(size);
		for (let offset = 0; offset < size; ) {
			const chunk = getOrThrow(await reader.read(offset, size - offset, context));
			if (chunk.length === 0) throw new Error("Memory file changed while reading");
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		const after = getOrThrow(await reader.revision(context));
		const revision = getOrThrow(await env.fileRevision(path, context));
		if (before !== after || after !== revision.version || revision.path !== canonical)
			throw new Error("Memory file changed while reading");
		return { path, target: canonical, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), revision };
	} finally {
		await reader.close(withoutAbortSignal(context));
	}
}

export async function replaceMemoryFile(env: ExecutionEnv, current: MemoryFile, content: string, context: Context) {
	if (new TextEncoder().encode(content).length > MAX_MEMORY_BYTES)
		throw new Error(`Memory file exceeds ${MAX_MEMORY_BYTES} bytes`);
	return withFileMutationQueue(
		env,
		current.path,
		async () => {
			if ((await canonicalFilePath(env, current.path, context)) !== current.target)
				throw new Error("Memory path changed before publication");
			return getOrThrow(
				await env.writeFileChecked(
					current.target,
					content,
					current.revision === undefined
						? { kind: "createIfAbsent" }
						: { kind: "replaceIfVersion", revision: current.revision },
					context,
				),
			);
		},
		context,
	);
}
