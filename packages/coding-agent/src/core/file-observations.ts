import type { FileObservation, FileObservationState } from "@amazme/durable/file-observations";
import { fileObservationKey, recordFileObservation } from "@amazme/durable/file-observations";

export interface FileObservationScope {
	get(namespace: string, path: string): FileObservation | undefined;
	record(namespace: string, path: string, observation: FileObservation | undefined): Promise<void>;
}

export interface FileObservationStore {
	/** Capture the actual owner before starting asynchronous IO. */
	capture(): FileObservationScope;
}

export function createMemoryFileObservations(): FileObservationStore {
	const state: FileObservationState = { files: {} };
	return {
		capture: () => ({
			get: (namespace, path) => copyObservation(state.files[fileObservationKey(namespace, path)]),
			record: async (namespace, path, observation) => recordFileObservation(state, namespace, path, observation),
		}),
	};
}

function copyObservation(value: FileObservation | undefined): FileObservation | undefined {
	return value === undefined ? undefined : { ...value };
}
