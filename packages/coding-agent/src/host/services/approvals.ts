import { type Context, defineService, type ReplicatedState } from "@amazme/chord";

/** One tool call waiting for a decision. */
export interface ApprovalRequest {
	/** The id a decision names. */
	id: string;
	/** The tool the call would run. */
	tool: string;
	/** A one-line digest of the call, for the reader to judge it by. */
	detail: string;
	/** The call, the task, and the conversation it belongs to. */
	callId: string;
	taskId: string;
	conversationId: string;
	/** When the call started waiting. */
	at: number;
}

export interface ApprovalsState {
	revision: number;
	pending: ApprovalRequest[];
}

/** The tool calls waiting for a decision, and the decision itself. */
export interface Approvals {
	readonly state: ReplicatedState<ApprovalsState>;
	/** Approve or deny one request; an id that is no longer pending reports false. */
	decide(id: string, approved: boolean, context: Context): Promise<boolean>;
}

export const Approvals = defineService<Approvals>("amazme.approvals");
