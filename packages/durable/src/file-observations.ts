import { FileError } from "./file-error.ts";
import type { FileWriteIntent } from "./env/index.ts";

export type FileObservation = { kind: "present"; version: string } | { kind: "absent" };
export type FileObservationState = { files: Record<string, FileObservation> };
export const MAX_FILE_OBSERVATIONS = 1024;

/** A file namespace and canonical target, not an environment object's identity or a working directory. */
export function fileObservationKey(namespace: string, path: string): string {
	return JSON.stringify([namespace, path]);
}

/** Refresh the bounded insertion order; evicted targets require another read before replacement. */
export function recordFileObservation(
	state: FileObservationState,
	namespace: string,
	path: string,
	observation: FileObservation | undefined,
): void {
	const key = fileObservationKey(namespace, path);
	delete state.files[key];
	if (observation === undefined) return;
	state.files[key] = { ...observation };
	const keys = Object.keys(state.files);
	for (const oldest of keys.slice(0, Math.max(0, keys.length - MAX_FILE_OBSERVATIONS))) delete state.files[oldest];
}

export function observedWriteIntent(path: string, observation: FileObservation | undefined): FileWriteIntent {
	return observation?.kind === "present"
		? { kind: "replaceIfVersion", revision: { path, version: observation.version } }
		: { kind: "createIfAbsent" };
}

export function observedEditIntent(
	path: string,
	observation: FileObservation | undefined,
): Extract<FileWriteIntent, { kind: "replaceIfVersion" }> {
	if (observation === undefined) throw new FileError("not_observed", `Read ${path} before editing it`, path);
	if (observation.kind === "absent") throw new FileError("not_found", `Cannot edit ${path}: file not found`, path);
	return { kind: "replaceIfVersion", revision: { path, version: observation.version } };
}
