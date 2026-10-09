import { defineService } from "@amazme/chord";
import type { Context } from "@amazme/chord";
import type { AgentPromptResult } from "./agent-controller.ts";

export interface HostPromptRequest {
	readonly conversationId: string;
	readonly requestId: string;
	readonly message: string;
}

export type HostPromptResult = AgentPromptResult | { status: "refused"; code: string; message: string };

/** Process-local host capabilities for selected server facets. Work remains in the existing Session workers. */
export interface HostSessions {
	agentDir(): string;
	hostId(): string;
	/** Run one prompt and join its accepted work before returning, including caller cancellation. */
	prompt(
		sessionId: string,
		request: HostPromptRequest,
		accepted: (operationId: string) => Promise<void>,
		context: Context,
	): Promise<HostPromptResult>;
	/** Find and cancel this request only. Unknown keys never create new input. */
	cancelPrompt(sessionId: string, request: HostPromptRequest, context: Context): Promise<AgentPromptResult | null>;
}

export const HostSessions = defineService<HostSessions>("amazme.host-sessions", { local: true });
