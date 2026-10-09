import { defineDoc } from "@amazme/durable";
import type { ConversationId, EntryId, TaskId } from "@amazme/durable";
import type { JobResult } from "./job.ts";

export type RunResult = {
	status: "completed" | "failed" | "cancelled";
	verification: "passed" | "failed" | "unverified";
	jobs: JobResult[];
};
export type Active = { stage: number; job: number; task: TaskId<JobResult> };
export type State =
	| {
			phase: "drive";
			stage: number;
			next: number;
			active: Active[];
			jobs: JobResult[];
	  }
	| {
			phase: "paused";
			stage: number;
			next: number;
			active: Active[];
			jobs: JobResult[];
	  }
	| {
			phase: "stop";
			stage: number;
			next: number;
			active: Active[];
			jobs: JobResult[];
	  }
	| { phase: "publish"; result: RunResult; receipt: TaskId | null };

export const Control = defineDoc<{ paused: boolean }>({
	kind: "amazme.workflow.control",
	version: 1,
	scope: "task",
	initial: () => ({ paused: false }),
});
export const Admission = defineDoc<{
	run: TaskId<RunResult> | null;
	controlApplied: boolean;
}>({
	kind: "amazme.workflow.admission",
	version: 1,
	scope: "task",
	initial: () => ({ run: null, controlApplied: false }),
});
/** IDs only; checkpoints, results and ownership remain the existing task records' authority. */
export const Index = defineDoc<{
	runs: {
		task: TaskId<RunResult>;
		conversation: ConversationId;
		name: string;
		at: number;
	}[];
}>({
	kind: "amazme.workflow.index",
	version: 1,
	scope: "session",
	initial: () => ({ runs: [] }),
});

export type JobStatus = "completed" | "passed" | "failed" | "timed_out" | "cancelled" | "unverified";
export type Evidence = {
	task: TaskId;
	kind: "agent" | "command";
	stage: number;
	job: number;
	name: string;
	status: JobStatus;
	text: string;
	limited: boolean;
	entry: EntryId | null;
	conversation: ConversationId | null;
};
