import { remoteService } from "@amazme/protocol/services";
import { type Context } from "@amazme/chord";

/** A fresh worker-owned check; the host never opens a running worker's SQLite file. */
export interface SessionLifecycle {
	isEmpty(context: Context): Promise<boolean>;
	refreshMirror(context: Context): Promise<void>;
	stopWork(context: Context): Promise<void>;
}

export const SessionLifecycle = remoteService<SessionLifecycle>("amazme.session-lifecycle", {"isEmpty":0,"refreshMirror":0,"stopWork":0}, []);
