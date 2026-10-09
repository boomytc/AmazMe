import type { SubmissionId, TaskId, ToolTaskResult } from "@amazme/durable";
import { defineDoc } from "@amazme/durable";
import type { CheckResult } from "./check.ts";

export type CommandCheck = {
	name: string;
	command: string;
	tool: "bash" | "powershell";
};
export type Policy = {
	enabled: boolean;
	checks: CommandCheck[];
	maxCorrections: number;
	timeoutSeconds: number;
};
export type Round = {
	generation: TaskId;
	task: TaskId<CheckResult>;
	run: SubmissionId;
	correctiveRequest: boolean | null;
	receipt: TaskId<ToolTaskResult> | null;
};

/** Atomically remember configuration changes by invocation, including safe tool recovery. */
export const ConfigurationChange = defineDoc<{ applied: boolean }>({
	kind: "amazme.verification.configuration-change",
	version: 1,
	scope: "task",
	initial: () => ({ applied: false }),
});

export const PolicyDoc = defineDoc<Policy>({
	kind: "amazme.verification.policy",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({
		enabled: false,
		checks: [],
		maxCorrections: 2,
		timeoutSeconds: 60,
	}),
});

/** Admission index and per-input limits; outcomes remain in ordinary task records. */
export const Rounds = defineDoc<{
	run: SubmissionId | null;
	policy: Policy | null;
	correctiveRequests: number;
	rounds: Round[];
}>({
	kind: "amazme.verification.rounds",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({
		run: null,
		policy: null,
		correctiveRequests: 0,
		rounds: [],
	}),
});
