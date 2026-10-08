import { type Context, defineService } from "@amazme/chord";

/** A fresh worker-owned check; the host never opens a running worker's SQLite file. */
export interface SessionLifecycle {
	isEmpty(context: Context): Promise<boolean>;
	refreshMirror(context: Context): Promise<void>;
}

export const SessionLifecycle = defineService<SessionLifecycle>("amazme.session-lifecycle");
