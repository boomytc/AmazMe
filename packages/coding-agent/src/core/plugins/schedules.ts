import { defineService } from "@amazme/chord";
import type { Context, ReplicatedState } from "@amazme/chord";

export type ScheduleRule =
	| { kind: "interval"; everyMinutes: number }
	| { kind: "once"; at: string; timeZone: string }
	| { kind: "cron"; expression: string; timeZone: string };

export interface SchedulePolicy {
	busy: "queue" | "skip";
	missed: "latest" | "skip";
	graceMinutes: number;
	timeoutSeconds: number;
}

/** One planned prompt: what to send, to which session, and how often. */
export interface ScheduleRecord extends SchedulePolicy {
	id: string;
	generation: number;
	/** The session the prompt goes to. */
	sessionId: string;
	/** Captured when the plan is created; focus changes do not redirect it. */
	conversationId: string;
	prompt: string;
	rule: ScheduleRule;
	enabled: boolean;
	createdAt: number;
	/** When it runs next; a disabled schedule keeps the value it would have used. */
	nextRunAt: number | null;
	/** Committed before dispatch. Retained across transport failure and host restart. */
	pending: ScheduleRun | null;
	/** At most twenty settlement receipts; conversation history owns the actual output. */
	history: ScheduleRunReceipt[];
}

export interface ScheduleRun {
	requestId: string;
	operationId: string | null;
	startedAt: number;
	deadlineAt: number;
	scheduledFor: number | null;
	cancelReason: "cancelled" | "timed_out" | null;
	problem: string | null;
}

export interface ScheduleRunReceipt {
	requestId: string;
	operationId: string | null;
	startedAt: number;
	finishedAt: number;
	scheduledFor: number | null;
	status: "done" | "unanswered" | "refused" | "cancelled" | "timed_out" | "skipped";
	detail: string | null;
}

export interface SchedulesState {
	revision: number;
	/** A read-only store problem; repair the file and reload before accepting changes or runs. */
	problem: string | null;
	/** The file the schedules are stored in, so a reader can find it. */
	path: string;
	/** The gap between the host's checks for due schedules. */
	tickMs: number;
	/** In id order. */
	schedules: ScheduleRecord[];
}

/** What adding or running a schedule produced; a refused input is a value, not a thrown call. */
export type ScheduleResult =
	| {
			readonly ok: true;
			readonly code: "added" | "updated" | "enabled" | "paused" | "idle" | "done" | "cancelled" | "skipped";
	  }
	| { readonly ok: false; readonly problem: string; readonly code?: "refused" | "unanswered" | "timed_out" };

export interface ScheduleInput extends SchedulePolicy {
	/** Stable plan ID generated once before submitting the create action. */
	readonly id: string;
	readonly sessionId: string;
	readonly conversationId: string;
	readonly prompt: string;
	readonly rule: ScheduleRule;
}

/** Planned prompts the host runs on their own, stored in one file. */
export interface Schedules {
	readonly state: ReplicatedState<SchedulesState>;
	add(input: ScheduleInput, context: Context): Promise<ScheduleResult>;
	/** Change an idle plan against the configuration version the editor read; retries are idempotent. */
	update(input: ScheduleInput, expectedGeneration: number, context: Context): Promise<ScheduleResult>;
	/** Remove the plan, cancel its accepted prompt, and wait for owned cleanup. */
	remove(id: string, context: Context): Promise<void>;
	setEnabled(id: string, enabled: boolean, context: Context): Promise<ScheduleResult>;
	/** Run even while paused. Reuse the action's requestId on retries; distinct actions cannot overlap. */
	runNow(id: string, requestId: string, context: Context): Promise<ScheduleResult>;
	/** Cancel or recover cancellation of the plan's current admission without delivering new input. */
	cancel(id: string, context: Context): Promise<ScheduleResult>;
	/** Re-read the file while no schedule is running. */
	reload(context: Context): Promise<void>;
}

export const Schedules = defineService<Schedules>("amazme.schedules");
