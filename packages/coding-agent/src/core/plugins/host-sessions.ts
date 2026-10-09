import { defineService } from "@amazme/chord";
import type { Context } from "@amazme/chord";

/** Process-local host capabilities for selected server facets. Work remains in the existing Session workers. */
export interface HostSessions {
	agentDir(): string;
	/** Run one prompt and join its accepted work before returning, including caller cancellation. */
	prompt(sessionId: string, prompt: string, context: Context): Promise<string>;
}

export const HostSessions = defineService<HostSessions>("amazme.host-sessions", { local: true });
