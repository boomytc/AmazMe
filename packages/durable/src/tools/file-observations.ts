import type { Context } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { defineDoc } from "../documents.ts";
import type { FileRevision, FileWriteOutcome } from "../env/index.ts";
import {
	type FileObservation,
	type FileObservationState,
	fileObservationKey,
	recordFileObservation,
} from "../file-observations.ts";
import type { ToolExecutionApi } from "../harness/types.ts";

/** A resumed conversation retains observations; a new branch or conversation must read for itself. */
export const FileObservationDoc = defineDoc<FileObservationState>({
	kind: "amazme.file-observations",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ files: {} }),
});

export async function priorFileObservation(
	api: ToolExecutionApi,
	namespace: string,
	path: string,
	context: Context,
): Promise<FileObservation | undefined> {
	const state = await api.snapshot(FileObservationDoc, api.conversationId, context);
	return state?.files[fileObservationKey(namespace, path)];
}

export async function observeFile(
	api: ToolExecutionApi,
	namespace: string,
	path: string,
	observation: FileObservation | undefined,
	context: Context,
): Promise<void> {
	await api.commit(async (tx) => {
		recordFileObservation(await tx.doc(FileObservationDoc, api.conversationId), namespace, path, observation);
	}, context);
}

export async function observeRead(
	api: ToolExecutionApi,
	namespace: string,
	revision: FileRevision,
	context: Context,
): Promise<void> {
	await observeFile(api, namespace, revision.path, { kind: "present", version: revision.version }, context);
}

/** Publication already succeeded; an observation commit failure must not turn it into a reported failed write. */
export async function observeMutation(
	api: ToolExecutionApi,
	namespace: string,
	outcome: FileWriteOutcome,
): Promise<void> {
	try {
		await observeFile(
			api,
			namespace,
			outcome.path,
			outcome.version === undefined ? undefined : { kind: "present", version: outcome.version },
			BACKGROUND_CONTEXT,
		);
	} catch {
		api.diagnostic({
			severity: "warn",
			code: "observation_unavailable",
			message:
				"File write completed, but its observation could not be saved. Read the file again before another edit or replacement.",
		});
	}
}
