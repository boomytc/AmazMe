import { awaitWithContext } from "@amazme/chord/context";
import type { Context } from "@amazme/chord";
import { defineTask, ToolTask } from "@amazme/durable";
import type { TaskOutcome, TaskRuntime } from "@amazme/durable";
import { Job } from "./job.ts";
import type { JobInput, JobResult } from "./job.ts";
import type { Plan } from "./plan.ts";
import { Control } from "./state.ts";
import type { Active, RunResult, State } from "./state.ts";

export type RunInput = {
	plan: Plan;
	args: string;
	model: JobInput["model"];
	instructions: string;
	allowed: string[];
};
type Runtime = TaskRuntime<RunInput, State, RunResult, object>;

function summary(plan: Plan, jobs: JobResult[], status: RunResult["status"]): RunResult {
	const checks = jobs.filter((job) => job.kind === "command" && plan.stages[job.stage]?.role === "verify");
	const expected = plan.stages.reduce(
		(total, stage) => total + (stage.role === "verify" ? stage.jobs.filter((job) => job.kind === "command").length : 0),
		0,
	);
	return {
		status,
		jobs,
		verification: checks.some((job) => job.status === "failed" || job.status === "timed_out")
			? "failed"
			: expected > 0 && checks.length === expected && checks.every((job) => job.status === "passed")
				? "passed"
				: "unverified",
	};
}
async function publish(runtime: Runtime, result: RunResult, context: Context): Promise<void> {
	await runtime.commit(
		() => ({
			status: "running",
			checkpoint: { phase: "publish", result, receipt: null },
		}),
		context,
	);
}

async function collect(
	runtime: Runtime,
	plan: Plan,
	state: Extract<State, { phase: "drive" }>,
	active: Active,
	outcome: TaskOutcome<JobResult>,
	context: Context,
): Promise<void> {
	const spec = plan.stages[active.stage]!.jobs[active.job]!;
	const output = outcome.result ?? {
		task: active.task,
		kind: spec.kind,
		stage: active.stage,
		job: active.job,
		name: spec.name,
		status: "failed" as const,
		text: outcome.error?.message ?? outcome.reason ?? "Job result is unavailable",
		limited: false,
		entry: null,
		conversation: null,
		tokens: 0,
	};
	const jobs = [...state.jobs, output],
		pending = state.active.filter((item) => item.task !== active.task);
	const failed = output.status !== "passed" && output.status !== "completed";
	await runtime.commit(
		() => ({
			status: "running",
			checkpoint: {
				...state,
				phase: failed && plan.stages[state.stage]!.onFailure === "stop" ? "stop" : "drive",
				active: pending,
				jobs,
			},
		}),
		context,
	);
}

/** A persisted plan over ordinary owned jobs. Pausing changes admission, not already issued model requests. */
export const Run = defineTask<RunInput, State, RunResult>({
	name: "amazme.workflow.run",
	version: 1,
	initial: () => ({ phase: "drive", stage: 0, next: 0, active: [], jobs: [] }),
	phases: {
		async drive(task, runtime, context) {
			const state = task.state.checkpoint,
				plan = task.input.plan;
			if ((await runtime.snapshot(Control, runtime.taskId, context))?.paused === true)
				return runtime.commit(
					() => ({
						status: "running",
						checkpoint: { ...state, phase: "paused" },
					}),
					context,
				);
			for (const active of state.active) {
				const record = await runtime.getTask(active.task, context);
				if (record?.state.status !== "terminal") continue;
				return collect(runtime, plan, state, active, record.state.outcome, context);
			}
			const stage = plan.stages[state.stage]!;
			if (state.next >= stage.jobs.length && state.active.length === 0) {
				if (state.stage + 1 === plan.stages.length)
					return publish(
						runtime,
						summary(
							plan,
							state.jobs,
							state.jobs.every((job) => job.status === "passed" || job.status === "completed") ? "completed" : "failed",
						),
						context,
					);
				return runtime.commit(
					() => ({
						status: "running",
						checkpoint: { ...state, stage: state.stage + 1, next: 0 },
					}),
					context,
				);
			}
			if (state.next < stage.jobs.length && state.active.length < plan.concurrency) {
				let remaining = 40000;
				const evidence = state.jobs
					.filter((job) => job.stage < state.stage)
					.map((job) => {
						const text = job.text.slice(0, Math.min(2000, remaining));
						remaining -= text.length;
						return {
							...job,
							text,
							limited: job.limited || text.length < job.text.length,
						};
					});
				return runtime.commit(async (tx) => {
					if ((await tx.doc(Control, runtime.taskId)).paused)
						return {
							status: "running",
							checkpoint: { ...state, phase: "paused" },
						};
					const child = await tx.createTask(
						Job,
						{
							spec: stage.jobs[state.next]!,
							stage: state.stage,
							job: state.next,
							role: stage.role,
							objective: plan.description,
							args: task.input.args,
							evidence,
							timeoutSeconds: plan.jobTimeoutSeconds,
							model: task.input.model,
							instructions: task.input.instructions,
							allowed: [...task.input.allowed],
						},
						{ ownership: { kind: "task", taskId: runtime.taskId } },
					);
					return {
						status: "running",
						checkpoint: {
							...state,
							next: state.next + 1,
							active: [...state.active, { stage: state.stage, job: state.next, task: child }],
						},
					};
				}, context);
			}
			const settled = await Promise.race(state.active.map((active) => runtime.waitForTask(active.task, context)));
			await collect(
				runtime,
				plan,
				state,
				state.active.find((active) => active.task === settled.id)!,
				settled.state.outcome,
				context,
			);
		},
		async paused(task, runtime, context) {
			const watch = await runtime.watchDoc(Control, runtime.taskId, context);
			if (watch === undefined) throw new Error("Workflow control is unavailable");
			try {
				if (watch.value?.paused === true)
					await awaitWithContext(
						new Promise<void>((resolve) => {
							watch.start(async (value) => {
								if (value?.paused !== true) resolve();
							});
						}),
						context,
					);
				await runtime.commit(
					() => ({
						status: "running",
						checkpoint: { ...task.state.checkpoint, phase: "drive" },
					}),
					context,
				);
			} finally {
				await watch.stop();
			}
		},
		async stop(task, runtime, context) {
			const state = task.state.checkpoint;
			await Promise.all(state.active.map((active) => runtime.abortOwned(active.task, context)));
			const jobs = [...state.jobs];
			for (const active of state.active) {
				const outcome = (await runtime.waitForTask(active.task, context)).state.outcome;
				if (outcome.result !== undefined) jobs.push(outcome.result);
			}
			await publish(runtime, summary(task.input.plan, jobs, "failed"), context);
		},
		async publish(task, runtime, context) {
			const state = task.state.checkpoint;
			if (state.receipt === null)
				return runtime.commit(async (tx) => {
					const receipt = await tx.createTask(
						ToolTask,
						{
							kind: "nested",
							parent: runtime.taskId,
							key: "receipt",
							parentCallId: `workflow:${runtime.taskId}`,
							call: {
								type: "toolCall",
								id: `workflow:${runtime.taskId}:result`,
								name: "workflow",
								arguments: {
									action: "status",
									runId: String(runtime.taskId),
								},
							},
						},
						{ ownership: { kind: "task", taskId: runtime.taskId } },
					);
					return { status: "running", checkpoint: { ...state, receipt } };
				}, context);
			await runtime.waitForTask(state.receipt, context);
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: { status: "completed", result: state.result },
				}),
				context,
			);
		},
	},
	abort: async (task, runtime, context) => {
		const state = task.state.checkpoint;
		const jobs = state.phase === "publish" ? [...state.result.jobs] : [...state.jobs];
		if (state.phase !== "publish")
			for (const active of state.active) {
				const record = await runtime.getTask(active.task, context);
				if (record?.state.status === "terminal" && record.state.outcome.result !== undefined)
					jobs.push(record.state.outcome.result);
			}
		await runtime.commit(
			() => ({
				status: "terminal",
				outcome: {
					status: "aborted",
					result: summary(task.input.plan, jobs, "cancelled"),
				},
			}),
			context,
		);
	},
});
