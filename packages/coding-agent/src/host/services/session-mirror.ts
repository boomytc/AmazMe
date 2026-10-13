import { remoteService } from "@amazme/protocol/services";
import type { ReplicatedState } from "@amazme/chord";

export interface SessionMirrorWarning {
	readonly path: string;
	readonly detail: string;
}

export interface SessionMirrorStatus {
	readonly warning: SessionMirrorWarning | null;
}

/** A presentation warning, not a durable model-context document. */
export interface SessionMirror {
	readonly state: ReplicatedState<SessionMirrorStatus>;
}

export const SessionMirror = remoteService<SessionMirror>("amazme.session-mirror", {}, ["state"]);
