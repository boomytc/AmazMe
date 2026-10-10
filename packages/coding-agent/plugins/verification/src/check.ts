import type { Context } from "@amazme/chord";
import type { TaskId, TaskRuntime, ToolTaskResult } from "@amazme/durable";
import { defineTask, LiveDoc, NestedResultDoc, ToolTask } from "@amazme/durable";
import type { CommandCheck } from "./state.ts";

export type Candidate = { text: string; limited: boolean; stopReason: string };
type Input = {
	candidate: Candidate;
	checks: CommandCheck[];
	timeoutSeconds: number;
};
export type Observation = {
	name: string;
	task: TaskId<ToolTaskResult>;
	status: "passed" | "failed" | "timed_out" | "unverified" | "cancelled";
	exitCode: number | null;
	output: string;
};
export type CheckResult = {
	status: Observation["status"];
	candidate: Candidate;
	checks: Observation[];
};

export function formatChecks(checks: readonly Observation[]): string {
	return checks
		.map(
			(check) =>
				`${check.name}: ${check.status}${check.exitCode === null ? "" : ` (exit ${check.exitCode})`}\n${check.output}`,
		)
		.join("\n");
}
type State =
	| { phase: "start" }
	| {
			phase: "check";
			deadline: number;
			next: number;
			child: TaskId<ToolTaskResult> | null;
			checks: Observation[];
	  };
type Runtime = TaskRuntime<Input, State, CheckResult, object>;

async function finish(
	runtime: Runtime,
	candidate: Candidate,
	checks: Observation[],
	status: CheckResult["status"],
	context: Context,
): Promise<void> {
	await runtime.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		const owned = new Set<TaskId>(checks.map((check) => check.task));
		if (live.nestedTools !== undefined) {
			live.nestedTools = live.nestedTools.filter((slot) => !owned.has(slot.taskId));
			if (live.nestedTools.length === 0) delete live.nestedTools;
		}
		return {
			status: "terminal",
			outcome:
				status === "cancelled"
					? { status: "aborted", result: { status, candidate, checks } }
					: { status: "completed", result: { status, candidate, checks } },
		};
	}, context);
}

/** Sequential command checks in the existing tool kernel; intent and replay remain each tool's responsibility. */
export const Check = defineTask<Input, State, CheckResult>({
	name: "amazme.verification.check",
	version: 1,
	initial: () => ({ phase: "start" }),
	phases: {
		async start(task, runtime, context) {
			await runtime.commit(
				() => ({
					status: "running",
					checkpoint: {
						phase: "check",
						deadline: runtime.now() + task.input.timeoutSeconds * 1000,
						next: 0,
						child: null,
						checks: [],
					},
				}),
				context,
			);
		},
		async check(task, runtime, context) {
			let state = task.state.checkpoint;
			const input = task.input,
				recovered = state.child !== null;
			if (state.next >= input.checks.length) return finish(runtime, input.candidate, state.checks, "passed", context);
			if (state.child === null) {
				if (runtime.now() >= state.deadline)
					return finish(runtime, input.candidate, state.checks, "timed_out", context);
				const check = input.checks[state.next]!;
				let created: TaskId<ToolTaskResult> | undefined;
				await runtime.commit(async (tx) => {
					const callId = `verification:${runtime.taskId}:${state.next}`;
					const parentCallId = `verification:${runtime.taskId}`;
					const child = await tx.createTask(
						ToolTask,
						{
							kind: "nested",
							parent: runtime.taskId,
							key: `check-${state.next}`,
							parentCallId,
							call: {
								type: "toolCall",
								id: callId,
								name: check.tool,
								arguments: {
									command: check.command,
									timeout: Math.max(1, Math.ceil((state.deadline - runtime.now()) / 1000)),
								},
							},
						},
						{ ownership: { kind: "task", taskId: runtime.taskId } },
					);
					const live = await tx.doc(LiveDoc, runtime.conversationId);
					live.nestedTools ??= [];
					live.nestedTools.push({
						taskId: child,
						parentCallId,
						parentTaskId: runtime.taskId,
						arguments: {
							command: check.command,
							timeout: Math.max(1, Math.ceil((state.deadline - runtime.now()) / 1000)),
						},
						callId,
						name: check.tool,
						status: "pending",
					});
					created = child;
					return { status: "running", checkpoint: { ...state, child } };
				}, context);
				state = { ...state, child: created! };
			}
			const before = await runtime.getTask(state.child!, context);
			const checkpoint = before?.state.checkpoint;
			const expiredIntent =
				recovered &&
				runtime.now() >= state.deadline &&
				before?.state.status !== "terminal" &&
				before?.state.status !== "completing" &&
				checkpoint !== null &&
				typeof checkpoint === "object" &&
				!Array.isArray(checkpoint) &&
				checkpoint.phase === "execute";
			const completed = runtime.waitForTask(state.child!, context);
			const first = await Promise.race([
				completed.then((record) => ({ record })),
				runtime.sleep(state.deadline, context).then(() => ({ expired: true as const })),
			]);
			if ("expired" in first) await runtime.abortOwned(state.child!, context);
			const record = "record" in first ? first.record : await completed;
			const outcome = record.state.outcome;
			const result = (await runtime.snapshot(NestedResultDoc, runtime.taskId, String(state.child), context))?.result;
			const output = [
				typeof result?.structuredOutput === "string"
					? result.structuredOutput
					: result?.structuredOutput !== null &&
							typeof result?.structuredOutput === "object" &&
							!Array.isArray(result.structuredOutput) &&
							typeof result.structuredOutput.output === "string"
						? result.structuredOutput.output
						: undefined,
				...(result?.diagnostics ?? []).map((item) => item.message),
				outcome.error?.message,
				outcome.reason,
			]
				.filter(Boolean)
				.join("\n");
			const details = result?.details;
			const facts = details !== null && typeof details === "object" && !Array.isArray(details) ? details : undefined;
			const timedOut =
				("expired" in first && outcome.status === "aborted") ||
				(record.endedAt ?? runtime.now()) > state.deadline ||
				facts?.interruption === "timeout";
			const interrupted = expiredIntent || result?.diagnostics?.some((item) => item.code === "interrupted") === true;
			const uncertain = facts?.exit_code === undefined || interrupted;
			const passed = outcome.status === "completed" && result?.isError !== true && facts?.exit_code === 0;
			const status = interrupted
				? ("unverified" as const)
				: timedOut
					? ("timed_out" as const)
					: uncertain
						? ("unverified" as const)
						: passed
							? ("passed" as const)
							: ("failed" as const);
			const observation: Observation = {
				name: input.checks[state.next]!.name,
				task: state.child!,
				status,
				exitCode: typeof facts?.exit_code === "number" ? facts.exit_code : null,
				output:
					`${interrupted ? "Interrupted execution may have partially run; not automatically retried.\n" : ""}${output}`.slice(
						0,
						6000,
					),
			};
			const checks = [...state.checks, observation];
			if (status !== "passed") return finish(runtime, input.candidate, checks, status, context);
			await runtime.commit(
				() => ({
					status: "running",
					checkpoint: { ...state, next: state.next + 1, child: null, checks },
				}),
				context,
			);
		},
	},
	abort: async (task, runtime, context) => {
		const state = task.state.checkpoint;
		const checks = state.phase === "check" ? [...state.checks] : [];
		if (state.phase === "check" && state.child !== null)
			checks.push({
				name: task.input.checks[state.next]!.name,
				task: state.child,
				status: "cancelled",
				exitCode: null,
				output: "Check cancelled; completion is not verified.",
			});
		await finish(runtime, task.input.candidate, checks, "cancelled", context);
	},
});
