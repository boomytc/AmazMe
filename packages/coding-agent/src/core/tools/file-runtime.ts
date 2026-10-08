import type { Context } from "@amazme/chord";
import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@amazme/chord/context";
import type { FileSystem, FileWriteOutcome } from "@amazme/durable/env";
import { FileError, getOrThrow } from "@amazme/durable/env";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
import { canonicalFilePath } from "@amazme/durable/file-operations";
import type { ExtensionContext } from "../extensions/types.ts";
import type { FileObservationScope, FileObservationStore } from "../file-observations.ts";
import { createMemoryFileObservations } from "../file-observations.ts";

export interface FileToolOptions {
	/** One filesystem capability, including checked publication, for local or remote tools. */
	fileSystem?: FileSystem;
	/** Share this owner when constructing standalone read/edit/write separately. AgentSession supplies its own owner. */
	observations?: FileObservationStore;
}

export function createFileRuntime(cwd: string, options?: FileToolOptions, additionalOptions: readonly string[] = []) {
	if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options)))
		throw new Error("File tool options must be an object");
	const knownOptions = new Set(["fileSystem", "observations", ...additionalOptions]);
	for (const key of Object.keys(options ?? {})) {
		if (!knownOptions.has(key)) throw new Error(`Unsupported file tool option: ${key}`);
	}
	const observations = options?.observations ?? createMemoryFileObservations();
	const local = new NodeExecutionEnv({ cwd });
	const fileSystem = options?.fileSystem;
	return (signal?: AbortSignal, ctx?: ExtensionContext) => {
		const executionCwd = ctx?.cwd ?? cwd;
		const parentSignal = ctx?.signal;
		const parent = parentSignal ? withAbortSignal(parentSignal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
		return {
			files: fileSystem ?? (executionCwd !== cwd ? new NodeExecutionEnv({ cwd: executionCwd }) : local),
			context: signal ? withAbortSignal(signal, parent) : parent,
			observations: (ctx?.fileObservations ?? observations).capture(),
		};
	};
}

export function throwIfAborted(context: Context): void {
	if (context.abortSignal?.aborted) throw new Error("Operation aborted");
}

/** Await the opened reader's cleanup even when cancellation arrives while IO is in flight. */
export async function readObservedBytes(files: FileSystem, path: string, context: Context) {
	const target = await canonicalFilePath(files, path, context);
	const reader = getOrThrow(await files.openBinaryReader(target, undefined, context));
	try {
		const before = getOrThrow(await reader.revision(context));
		const info = getOrThrow(await reader.info(context));
		if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > 2 ** 31 - 1)
			throw new FileError("invalid", "File is too large for a complete binary read", target);
		const buffer = Buffer.allocUnsafe(info.size);
		let offset = 0;
		while (offset < info.size) {
			throwIfAborted(context);
			const bytes = getOrThrow(await reader.read(offset, Math.min(1024 * 1024, info.size - offset), context));
			if (bytes.length === 0) break;
			buffer.set(bytes, offset);
			offset += bytes.length;
		}
		const after = getOrThrow(await reader.revision(context));
		throwIfAborted(context);
		return {
			buffer: buffer.subarray(0, offset),
			path: target,
			version: after,
			stable: before === after && offset === info.size,
		};
	} finally {
		await reader.close(withoutAbortSignal(context));
	}
}

/** A published mutation remains successful even if its journal can no longer accept the observation. */
export async function observePublished(
	scope: FileObservationScope,
	namespace: string,
	outcome: FileWriteOutcome,
): Promise<string> {
	try {
		await scope.record(
			namespace,
			outcome.path,
			outcome.version === undefined ? undefined : { kind: "present", version: outcome.version },
		);
		if (outcome.version !== undefined) return "";
	} catch {}
	return "\n[File write completed, but its observation could not be saved. Read the file again before another edit or replacement.]";
}
