import { defineTask } from "@amazme/durable";
import type { TaskRuntime } from "@amazme/durable";
import type { Context } from "@amazme/chord";
import type { ExecutionEnv } from "@amazme/durable/env";
import { lockImages, publish, readImage, sameRevision, scope } from "./files.ts";
import { RestoreOwner } from "./state.ts";
import type { Plan } from "./state.ts";

type Input = { plan: Plan; backup: string };
type Receipt = { index: number; version: string | null };
type Progress = { next: number; intent: number | null; applied: Receipt[]; reason: string; conflicts: string[] };
type State = (Progress & { phase: "apply" }) | (Progress & { phase: "rollback" });
export type Result = {
	status: "restored" | "rolled_back" | "rollback_conflict";
	backup: string;
	paths: string[];
	conflicts: string[];
	reason: string;
};
type Runtime = TaskRuntime<Input, State, Result, object>;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function finish(runtime: Runtime, result: Result, context: Context, aborted = false) {
	await runtime.commit(async (tx) => {
		const owner = await tx.doc(RestoreOwner);
		if (owner.task === runtime.taskId) owner.task = null;
		return {
			status: "terminal",
			outcome: aborted
				? { status: "aborted", result }
				: result.status === "restored"
					? { status: "completed", result }
					: { status: "failed", result, error: { message: result.reason || "Checkpoint rollback conflict" } },
		};
	}, context);
}

async function environment(runtime: Runtime, plan: Plan, context: Context): Promise<ExecutionEnv> {
	const env = await runtime.env(context);
	if (env === undefined) throw new Error("Checkpoint restore requires a file environment");
	const current = await scope(env, context);
	if (current.root !== plan.root || current.envId !== plan.envId)
		throw new Error("Checkpoint restore belongs to a different project or environment");
	return env;
}

async function verifyApplied(
	env: ExecutionEnv,
	plan: Plan,
	applied: readonly Receipt[],
	context: Context,
): Promise<void> {
	for (const receipt of applied) {
		const item = plan.files[receipt.index]!;
		const current = await readImage(env, item.before.path, context);
		if (
			current.target !== item.before.target ||
			current.version !== receipt.version ||
			current.data !== item.after.data
		)
			throw new Error(`File changed after checkpoint publication: ${item.before.path}`);
	}
}

async function rollback(runtime: Runtime, input: Input, saved: State, context: Context): Promise<Result> {
	const conflicts = [...saved.conflicts];
	const paths = input.plan.files.map(({ before }) => before.path);
	const result = (): Result => ({
		status: conflicts.length === 0 ? "rolled_back" : "rollback_conflict",
		backup: input.backup,
		paths,
		conflicts,
		reason: saved.reason,
	});
	let env: ExecutionEnv;
	try {
		env = await environment(runtime, input.plan, context);
	} catch (error) {
		if (context.abortSignal?.aborted) throw error;
		return { ...result(), status: "rollback_conflict", conflicts: [message(error)] };
	}
	return lockImages(
		env,
		input.plan.files.map(({ before }) => before),
		async () => {
			let state = { ...saved, phase: "rollback" as const, applied: [...saved.applied] };
			// Publication and its receipt can be separated by a crash. Verify bytes before treating it as applied.
			if (state.intent !== null) {
				const index = state.intent,
					item = input.plan.files[index]!;
				try {
					const current = await readImage(env, item.before.path, context);
					if (current.target !== item.before.target) throw new Error("File target changed");
					if (current.data !== item.before.data) {
						if (current.data !== item.after.data)
							throw new Error("Unrecorded publication no longer matches target bytes");
						state.applied.push({ index, version: current.version });
					}
				} catch (error) {
					if (context.abortSignal?.aborted) throw error;
					conflicts.push(`${item.before.path}: ${message(error)}`);
				}
				state.intent = null;
				state.conflicts = [...conflicts];
				await runtime.commit(() => ({ status: "running", checkpoint: state }), context);
			}
			while (state.applied.length > 0) {
				const receipt = state.applied.at(-1)!,
					item = input.plan.files[receipt.index]!;
				try {
					const current = await readImage(env, item.before.path, context);
					if (current.target !== item.before.target) throw new Error("File target changed");
					// A previous rollback publication may already be durable, or an external writer restored those bytes.
					if (current.data !== item.before.data) {
						if (current.version !== receipt.version)
							throw new Error("File changed after restore; keeping external bytes");
						await publish(env, current, item.before.data, context);
					}
				} catch (error) {
					if (context.abortSignal?.aborted) throw error;
					conflicts.push(`${item.before.path}: ${message(error)}`);
				}
				state = { ...state, applied: state.applied.slice(0, -1), conflicts: [...conflicts] };
				await runtime.commit(() => ({ status: "running", checkpoint: state }), context);
			}
			return result();
		},
		context,
	);
}

export const Restore = defineTask<Input, State, Result>({
	name: "amazme.checkpoint.restore",
	version: 1,
	initial: () => ({ phase: "apply", next: 0, intent: null, applied: [], reason: "", conflicts: [] }),
	phases: {
		async apply(task, runtime, context) {
			let state: State = task.state.checkpoint;
			try {
				const env = await environment(runtime, task.input.plan, context);
				await lockImages(
					env,
					task.input.plan.files.map(({ before }) => before),
					async () => {
						await verifyApplied(env, task.input.plan, state.applied, context);
						// Validate all untouched files before the first publication, including after restart.
						for (let index = state.next; index < task.input.plan.files.length; index++) {
							if (index === state.intent) continue;
							const before = task.input.plan.files[index]!.before;
							if (!sameRevision(await readImage(env, before.path, context), before))
								throw new Error(`File changed since the restore preview: ${before.path}`);
						}
						while (state.next < task.input.plan.files.length) {
							const index = state.next,
								item = task.input.plan.files[index]!;
							const current = await readImage(env, item.before.path, context);
							if (current.target !== item.before.target) throw new Error(`File target changed: ${item.before.path}`);
							if (state.intent !== index || current.data !== item.after.data) {
								if (!sameRevision(current, item.before)) throw new Error(`File changed: ${item.before.path}`);
								state = { ...state, intent: index };
								await runtime.commit(() => ({ status: "running", checkpoint: state }), context);
								const written = await publish(env, current, item.after.data, context);
								state = { ...state, applied: [...state.applied, { index, version: written.version }] };
							} else state = { ...state, applied: [...state.applied, { index, version: current.version }] };
							state = { ...state, next: index + 1, intent: null };
							await runtime.commit(() => ({ status: "running", checkpoint: state }), context);
						}
						await verifyApplied(env, task.input.plan, state.applied, context);
						await finish(
							runtime,
							{
								status: "restored",
								backup: task.input.backup,
								paths: task.input.plan.files.map(({ before }) => before.path),
								conflicts: [],
								reason: "",
							},
							context,
						);
					},
					context,
				);
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				await runtime.commit(
					() => ({ status: "running", checkpoint: { ...state, phase: "rollback", reason: message(error) } }),
					context,
				);
			}
		},
		async rollback(task, runtime, context) {
			await finish(runtime, await rollback(runtime, task.input, task.state.checkpoint, context), context);
		},
	},
	async abort(task, runtime, context) {
		const result = await rollback(
			runtime,
			task.input,
			{ ...task.state.checkpoint, reason: "Restore cancelled" },
			context,
		);
		await finish(runtime, result, context, true);
	},
});
