import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@amazme/chord/context";
import { defineFacet } from "@amazme/chord";
import type { Context, Facet, MutableReplicatedState } from "@amazme/chord";
import { Schedules } from "@amazme/coding-agent/plugin";
import type {
	AgentPromptResult,
	HostPromptRequest,
	HostPromptResult,
	ScheduleInput,
	ScheduleRecord,
	ScheduleResult,
	ScheduleRun,
	ScheduleRunReceipt,
	SchedulesState,
} from "@amazme/coding-agent/plugin";
import { createScheduleFile } from "./file.ts";
import { conversationId, policy, SCHEDULE_MAX_PROMPT } from "./records.ts";
import { firstTarget, latestDue, MINUTE, nextTarget, normalizeRule, timestamp } from "./rules.ts";

export { SCHEDULE_MAX_PROMPT } from "./records.ts";
export const SCHEDULE_DEFAULT_TICK_MS = 5_000;
export const SCHEDULE_MAX_RUNNING = 4;

export interface SchedulesServiceOptions {
	readonly agentDir: () => string;
	readonly hostId: () => string;
	run(
		sessionId: string,
		request: HostPromptRequest,
		accepted: (operationId: string) => Promise<void>,
		context: Context,
	): Promise<HostPromptResult>;
	cancel(sessionId: string, request: HostPromptRequest, context: Context): Promise<AgentPromptResult | null>;
	readonly now?: () => number;
	readonly tickMs?: number;
}

export interface SchedulesService {
	readonly service: {
		readonly state: MutableReplicatedState<SchedulesState>;
		add(input: ScheduleInput, context: Context): Promise<ScheduleResult>;
		update(input: ScheduleInput, expectedGeneration: number, context: Context): Promise<ScheduleResult>;
		remove(id: string, context: Context): Promise<void>;
		setEnabled(id: string, enabled: boolean, context: Context): Promise<ScheduleResult>;
		runNow(id: string, requestId: string, context: Context): Promise<ScheduleResult>;
		cancel(id: string, context: Context): Promise<ScheduleResult>;
		reload(context: Context): Promise<void>;
	};
	tick(context: Context): Promise<void>;
	start(): void;
	stop(): Promise<void>;
	activate(context: Context): Promise<void>;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function deadlineExpired(pending: ScheduleRun, context: Context, now: number): boolean {
	const reason: unknown = context.abortSignal?.reason;
	return (
		now >= pending.deadlineAt ||
		(typeof reason === "object" && reason !== null && "name" in reason && reason.name === "TimeoutError")
	);
}
function result(receipt: Pick<ScheduleRunReceipt, "status" | "detail">): ScheduleResult {
	if (receipt.status === "done" || receipt.status === "cancelled" || receipt.status === "skipped")
		return { ok: true, code: receipt.status };
	return {
		ok: false,
		code: receipt.status,
		problem:
			receipt.detail ??
			(receipt.status === "timed_out" ? "Execution deadline expired." : "The prompt produced no answer."),
	};
}

/** File admission is serialized; independent plans share a bounded set of existing worker requests. */
export function createSchedulesService(
	options: SchedulesServiceOptions,
	createState: (initial: SchedulesState) => MutableReplicatedState<SchedulesState>,
): SchedulesService {
	const now = options.now ?? Date.now;
	const tickMs = options.tickMs ?? SCHEDULE_DEFAULT_TICK_MS;
	const state = createState({ revision: 1, path: "", tickMs, problem: null, schedules: [] });
	let timer: NodeJS.Timeout | undefined;
	let admitting = false;
	let stopped = false;
	let stopPromise: Promise<void> | undefined;
	const running = new Map<string, { controller: AbortController; done: Promise<ScheduleResult> }>();
	let mutationTail: Promise<unknown> = Promise.resolve();
	const file = createScheduleFile(
		{
			agentDir: options.agentDir,
			hostId: options.hostId,
			tickMs,
			onCompromised(error) {
				for (const entry of running.values()) entry.controller.abort(error);
			},
		},
		state,
	);
	const { find, update } = file;
	const cleanup = (context: Context): Context => withoutAbortSignal(context);
	const mutate = <T>(operation: () => Promise<T>, context: Context, writable = true, settling = false): Promise<T> => {
		const pending = mutationTail.then(async () => {
			if (writable && file.path.length === 0) throw new Error("Activate schedules before using the store.");
			if (stopped && !settling) throw new Error("Schedules are stopped.");
			if (writable) await file.own(context);
			return operation();
		});
		mutationTail = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	};
	const request = (record: ScheduleRecord, run: ScheduleRun): HostPromptRequest => ({
		conversationId: record.conversationId,
		requestId: run.requestId,
		message: record.prompt,
		whenBusy: record.busy === "queue" ? "followUp" : "reject",
	});
	const finish = (id: string, receipt: ScheduleRunReceipt, context: Context, retire = false): Promise<void> =>
		mutate(
			async () => {
				const current = find(id);
				if (current === undefined || (current.pending !== null && current.pending.requestId !== receipt.requestId))
					return;
				const next =
					receipt.scheduledFor !== null || current.rule.kind === "once"
						? nextTarget(current.rule, receipt.scheduledFor ?? receipt.finishedAt, Math.max(receipt.finishedAt, now()))
						: current.nextRunAt;
				await update(
					id,
					(record) => ({
						...record,
						pending: null,
						nextRunAt: next,
						enabled: !retire && next !== null && record.enabled,
						history: [...record.history.filter((entry) => entry.requestId !== receipt.requestId), receipt].slice(-20),
					}),
					cleanup(context),
				);
			},
			cleanup(context),
			true,
			true,
		);
	const cancelRun = async (
		record: ScheduleRecord,
		pending: ScheduleRun,
		context: Context,
	): Promise<Pick<ScheduleRunReceipt, "status" | "detail">> => {
		const settled = await options.cancel(record.sessionId, request(record, pending), cleanup(context));
		return settled?.status === "done"
			? { status: "done", detail: null }
			: { status: pending.cancelReason ?? (now() >= pending.deadlineAt ? "timed_out" : "cancelled"), detail: null };
	};
	const run = async (record: ScheduleRecord, pending: ScheduleRun, context: Context): Promise<ScheduleResult> => {
		let outcome: Pick<ScheduleRunReceipt, "status" | "detail">;
		let retire = false;
		try {
			if (pending.cancelReason !== null || now() >= pending.deadlineAt)
				outcome = await cancelRun(record, pending, context);
			else {
				context.abortSignal?.throwIfAborted();
				const settled = await options.run(
					record.sessionId,
					request(record, pending),
					async (operationId) => {
						await mutate(
							async () => {
								if (find(record.id)?.pending?.requestId !== pending.requestId)
									throw new Error("Schedule receipt no longer belongs to this run.");
								await update(
									record.id,
									(current) => ({ ...current, pending: { ...current.pending!, operationId } }),
									cleanup(context),
								);
							},
							cleanup(context),
							true,
							true,
						);
					},
					context,
				);
				retire = settled.status === "refused" && settled.code === "target_missing";
				outcome =
					settled.status === "done"
						? { status: "done", detail: null }
						: settled.status === "refused" && settled.code === "busy" && record.busy === "skip"
							? { status: "skipped", detail: "busy" }
							: { status: settled.status, detail: settled.status === "unanswered" ? settled.reason : settled.message };
			}
		} catch (error) {
			let recovered: Pick<ScheduleRunReceipt, "status" | "detail"> | undefined;
			if (context.abortSignal?.aborted || now() >= pending.deadlineAt) {
				const reason =
					find(record.id)?.pending?.cancelReason ??
					(deadlineExpired(pending, context, now()) ? "timed_out" : "cancelled");
				let intentError: unknown;
				try {
					await mutate(
						() =>
							update(
								record.id,
								(current) => ({ ...current, pending: { ...current.pending!, cancelReason: reason } }),
								cleanup(context),
							),
						cleanup(context),
						true,
						true,
					);
				} catch (writeError) {
					intentError = writeError;
				}
				try {
					recovered = await cancelRun(record, { ...pending, cancelReason: reason }, context);
				} catch (cancelError) {
					error = new AggregateError(
						[error, ...(intentError === undefined ? [] : [intentError]), cancelError],
						"Schedule cancellation awaits recovery",
					);
				}
			}
			if (recovered === undefined) {
				await mutate(
					async () => {
						if (find(record.id)?.pending?.requestId !== pending.requestId) return;
						await update(
							record.id,
							(current) => ({ ...current, pending: { ...current.pending!, problem: describe(error) } }),
							cleanup(context),
						);
					},
					cleanup(context),
					true,
					true,
				);
				return { ok: false, problem: `Delivery awaits recovery: ${describe(error)}` };
			}
			outcome = recovered;
		}
		const current = find(record.id)?.pending;
		await finish(
			record.id,
			{
				requestId: pending.requestId,
				operationId: current?.operationId ?? pending.operationId,
				startedAt: pending.startedAt,
				finishedAt: now(),
				scheduledFor: pending.scheduledFor,
				...outcome,
			},
			context,
			retire,
		);
		return result(outcome);
	};
	type Admission = { refusal: string } | { done: Promise<ScheduleResult> };
	const admit = (id: string, context: Context, automatic: boolean, manualKey?: string): Promise<Admission> =>
		mutate(async () => {
			context.abortSignal?.throwIfAborted();
			await file.check(context);
			const record = find(id);
			if (record === undefined) return { refusal: "That schedule is gone." };
			const prior = record.history.find((receipt) => receipt.requestId === manualKey);
			if (prior !== undefined && record.pending?.requestId !== manualKey)
				return { done: Promise.resolve(result(prior)) };
			const active = running.get(id);
			if (active !== undefined)
				return manualKey === record.pending?.requestId
					? { done: active.done }
					: { refusal: "That schedule is already running." };
			if (manualKey !== undefined && record.pending !== null && manualKey !== record.pending.requestId)
				return { refusal: "The current delivery needs recovery before a new run." };
			if (
				running.size >= SCHEDULE_MAX_RUNNING &&
				!(record.pending !== null && (record.pending.cancelReason !== null || now() >= record.pending.deadlineAt))
			)
				return { refusal: "The host already has four automation runs. Retry when one finishes." };
			const at = now();
			if (
				record.pending === null &&
				automatic &&
				(!record.enabled || record.nextRunAt === null || record.nextRunAt > at)
			)
				return { refusal: "That schedule is not due." };
			const occurrence = automatic && record.nextRunAt !== null ? latestDue(record.rule, record.nextRunAt, at) : null;
			const pending: ScheduleRun = record.pending ?? {
				requestId: automatic ? `schedule:${id}:${record.generation}:${occurrence}` : manualKey!,
				operationId: null,
				startedAt: at,
				deadlineAt: at + record.timeoutSeconds * 1_000,
				scheduledFor: occurrence,
				cancelReason: null,
				problem: null,
			};
			if (
				record.pending === null &&
				automatic &&
				occurrence !== null &&
				record.missed === "skip" &&
				at - occurrence > record.graceMinutes * MINUTE
			) {
				const receipt: ScheduleRunReceipt = {
					requestId: pending.requestId,
					operationId: null,
					startedAt: at,
					finishedAt: at,
					scheduledFor: occurrence,
					status: "skipped",
					detail: "missed",
				};
				// Admission already owns the mutation line; do not recursively enter finish().
				const next = nextTarget(record.rule, occurrence, at);
				await update(
					id,
					(current) => ({
						...current,
						nextRunAt: next,
						enabled: next !== null && current.enabled,
						history: [...current.history, receipt].slice(-20),
					}),
					context,
				);
				return { done: Promise.resolve(result(receipt)) };
			}
			if (record.pending === null) await update(id, (current) => ({ ...current, pending }), context);
			const controller = new AbortController();
			const { promise: done, resolve, reject } = Promise.withResolvers<ScheduleResult>();
			running.set(id, { controller, done });
			const deadline = AbortSignal.timeout(
				Math.min(record.timeoutSeconds * 1_000, Math.max(0, pending.deadlineAt - now())),
			);
			const execution = withAbortSignal(deadline, withAbortSignal(controller.signal, cleanup(context)));
			void run(record, pending, execution).then(
				(value) => {
					running.delete(id);
					resolve(value);
				},
				(error: unknown) => {
					running.delete(id);
					reject(error);
				},
			);
			return { done };
		}, context);
	const execute = async (
		id: string,
		context: Context,
		automatic: boolean,
		manualKey?: string,
	): Promise<ScheduleResult> => {
		const admitted = await admit(id, context, automatic, manualKey);
		return "refusal" in admitted ? { ok: false, problem: admitted.refusal } : awaitWithContext(admitted.done, context);
	};
	const cancel = async (id: string, context: Context): Promise<ScheduleResult> => {
		context.abortSignal?.throwIfAborted();
		const owned = running.get(id);
		let entry: typeof owned;
		try {
			entry = await mutate(async () => {
				context.abortSignal?.throwIfAborted();
				const record = find(id);
				if (!record?.pending) return undefined;
				await update(
					id,
					(current) => ({
						...current,
						pending: {
							...current.pending!,
							cancelReason:
								current.pending!.cancelReason ?? (now() >= current.pending!.deadlineAt ? "timed_out" : "cancelled"),
						},
					}),
					context,
				);
				return running.get(id);
			}, context);
		} catch (error) {
			if (owned !== undefined) {
				owned.controller.abort(new Error("Schedule was cancelled."));
				try {
					await owned.done;
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Cancellation finished but its record needs repair");
				}
			}
			throw error;
		}
		if (entry !== undefined) {
			entry.controller.abort(new Error("Schedule was cancelled."));
			return entry.done;
		}
		const record = find(id);
		if (!record?.pending) return { ok: true, code: "idle" };
		const admitted = await admit(id, context, true);
		return "refusal" in admitted ? { ok: false, problem: admitted.refusal } : admitted.done;
	};
	const dispatch = async (context: Context): Promise<Promise<ScheduleResult>[]> => {
		if (stopped || file.problem !== null || admitting) return [];
		admitting = true;
		const accepted: Promise<ScheduleResult>[] = [];
		try {
			const candidates = file.schedules
				.filter(
					(record) =>
						!running.has(record.id) &&
						(record.pending !== null || (record.enabled && record.nextRunAt !== null && record.nextRunAt <= now())),
				)
				.sort(
					(a, b) =>
						(a.pending?.startedAt ?? a.nextRunAt ?? Infinity) - (b.pending?.startedAt ?? b.nextRunAt ?? Infinity),
				);
			for (const record of candidates) {
				if (stopped) break;
				if (
					running.size >= SCHEDULE_MAX_RUNNING &&
					!(record.pending !== null && (record.pending.cancelReason !== null || now() >= record.pending.deadlineAt))
				)
					continue;
				const admitted = await admit(record.id, context, true);
				if ("done" in admitted) accepted.push(admitted.done);
			}
			return accepted;
		} finally {
			admitting = false;
		}
	};

	const sameSettings = (
		record: ScheduleRecord,
		input: ScheduleInput,
		rule: ScheduleRecord["rule"],
		prompt: string,
	): boolean =>
		record.sessionId === input.sessionId &&
		record.conversationId === input.conversationId &&
		record.prompt === prompt &&
		JSON.stringify(record.rule) === JSON.stringify(rule) &&
		record.busy === input.busy &&
		record.missed === input.missed &&
		record.graceMinutes === input.graceMinutes &&
		record.timeoutSeconds === input.timeoutSeconds;

	return {
		service: {
			state,
			async add(input, context) {
				if (
					typeof input.id !== "string" ||
					input.id.length === 0 ||
					input.id.length > 256 ||
					input.sessionId.length === 0 ||
					!conversationId(input.conversationId)
				)
					return { ok: false, problem: "A plan needs a stable ID, session and conversation." };
				const prompt = input.prompt.trim();
				if (prompt.length === 0 || prompt.length > SCHEDULE_MAX_PROMPT || !policy({ ...input }))
					return { ok: false, problem: "Invalid prompt, busy/missed policy, grace or timeout." };
				let rule: ScheduleRecord["rule"];
				try {
					rule = normalizeRule(input.rule);
				} catch (error) {
					return { ok: false, problem: describe(error) };
				}
				return mutate(async () => {
					context.abortSignal?.throwIfAborted();
					await file.check(context);
					const previous = find(input.id);
					if (previous !== undefined) {
						const same = sameSettings(previous, input, rule, prompt);
						return same
							? { ok: true, code: "added" }
							: { ok: false, problem: "That plan ID already belongs to different settings." };
					}
					const at = now();
					const next = firstTarget(rule, at);
					if (next === null || next <= at || !timestamp(at + input.timeoutSeconds * 1_000))
						return { ok: false, problem: "The rule needs a valid future occurrence." };
					await file.commit(
						[
							...file.schedules,
							{
								id: input.id,
								generation: 1,
								sessionId: input.sessionId,
								conversationId: input.conversationId,
								prompt,
								rule,
								busy: input.busy,
								missed: input.missed,
								graceMinutes: input.graceMinutes,
								timeoutSeconds: input.timeoutSeconds,
								enabled: true,
								createdAt: at,
								nextRunAt: next,
								pending: null,
								history: [],
							},
						],
						context,
					);
					return { ok: true, code: "added" };
				}, context);
			},
			async update(input, expectedGeneration, context) {
				const prompt = input.prompt.trim();
				if (
					prompt.length === 0 ||
					prompt.length > SCHEDULE_MAX_PROMPT ||
					!policy({ ...input }) ||
					!Number.isSafeInteger(expectedGeneration) ||
					expectedGeneration < 1
				)
					return { ok: false, problem: "Invalid plan settings or configuration version." };
				let rule: ScheduleRecord["rule"];
				try {
					rule = normalizeRule(input.rule);
				} catch (error) {
					return { ok: false, problem: describe(error) };
				}
				return mutate(async () => {
					context.abortSignal?.throwIfAborted();
					await file.check(context);
					const previous = find(input.id);
					if (previous === undefined) return { ok: false, problem: "That schedule is gone." };
					if (previous.sessionId !== input.sessionId || previous.conversationId !== input.conversationId)
						return { ok: false, problem: "Create a new plan to change its fixed target." };
					const same = sameSettings(previous, input, rule, prompt);
					if (previous.generation !== expectedGeneration && !(same && previous.generation === expectedGeneration + 1))
						return { ok: false, problem: "The plan changed. Reopen the editor before saving." };
					if (same) return { ok: true, code: "updated" };
					if (previous.pending !== null)
						return { ok: false, problem: "Finish or cancel the current run before editing." };
					const at = now();
					const next =
						JSON.stringify(previous.rule) === JSON.stringify(rule) && previous.nextRunAt !== null
							? previous.nextRunAt
							: firstTarget(rule, at);
					if (next === null || (rule.kind === "once" && next <= at) || !Number.isSafeInteger(previous.generation + 1))
						return { ok: false, problem: "The changed rule needs a valid future occurrence." };
					await update(
						input.id,
						(current) => ({
							...current,
							rule,
							prompt,
							busy: input.busy,
							missed: input.missed,
							graceMinutes: input.graceMinutes,
							timeoutSeconds: input.timeoutSeconds,
							generation: current.generation + 1,
							nextRunAt: next,
							enabled: current.nextRunAt === null || current.enabled,
						}),
						context,
					);
					return { ok: true, code: "updated" };
				}, context);
			},

			async remove(id, context) {
				await cancel(id, context);
				await mutate(async () => {
					if (find(id)?.pending) throw new Error("Cancel the current delivery before removing this schedule.");
					await file.commit(
						file.schedules.filter((record) => record.id !== id),
						context,
					);
				}, context);
			},
			setEnabled: (id, enabled, context) =>
				mutate(async () => {
					context.abortSignal?.throwIfAborted();
					await file.check(context);
					const record = find(id);
					if (record === undefined) return { ok: false, problem: "That schedule is gone." };
					if (enabled && record.nextRunAt === null)
						return {
							ok: false,
							problem: "This plan has no remaining occurrence. Run it manually or create a new plan.",
						};
					if (record.enabled !== enabled) await update(id, (current) => ({ ...current, enabled }), context);
					return { ok: true, code: enabled ? "enabled" : "paused" };
				}, context),
			runNow: (id, requestId, context) =>
				typeof requestId !== "string" || requestId.trim().length === 0 || requestId.length > 256
					? Promise.resolve({ ok: false, problem: "A manual run needs a stable request ID of at most 256 characters." })
					: execute(id, context, false, `schedule:${id}:manual:${requestId}`),
			cancel,
			reload: (context) =>
				mutate(
					async () => {
						if (running.size > 0) throw new Error("Wait for running schedules before reloading the file.");
						context.abortSignal?.throwIfAborted();
						await file.load(context);
					},
					context,
					false,
				),
		},
		async tick(context) {
			await Promise.allSettled(await dispatch(context));
		},
		start() {
			if (stopped || timer !== undefined) return;
			timer = setInterval(() => {
				void dispatch(BACKGROUND_CONTEXT)
					.then((accepted) => Promise.allSettled(accepted))
					.catch(() => {});
			}, tickMs);
			timer.unref();
		},
		stop() {
			if (stopPromise !== undefined) return stopPromise;
			stopped = true;
			if (timer !== undefined) clearInterval(timer);
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			stopPromise = promise;
			void (async () => {
				const errors: unknown[] = [];
				await mutationTail;
				try {
					if (file.owned && file.schedules.some((record) => record.pending !== null))
						await mutate(
							() =>
								file.commit(
									file.schedules.map((record) =>
										record.pending === null
											? record
											: {
													...record,
													pending: {
														...record.pending,
														cancelReason:
															record.pending.cancelReason ??
															(now() >= record.pending.deadlineAt ? "timed_out" : "cancelled"),
													},
												},
									),
									BACKGROUND_CONTEXT,
								),
							BACKGROUND_CONTEXT,
							true,
							true,
						);
				} catch (error) {
					errors.push(error);
				}
				const recovering = file.owned
					? file.schedules.filter((record) => record.pending !== null && !running.has(record.id))
					: [];
				for (const entry of running.values()) entry.controller.abort(new Error("Schedules are stopped."));
				const settled = await Promise.allSettled(
					[...running.values()]
						.map((entry) => entry.done)
						.concat(recovering.map((record) => run(record, record.pending!, BACKGROUND_CONTEXT))),
				);
				errors.push(...settled.flatMap((entry) => (entry.status === "rejected" ? [entry.reason] : [])));
				await mutationTail;
				if (file.owned && file.schedules.some((record) => record.pending !== null))
					errors.push(new Error("Some deliveries still await cancellation recovery."));
				try {
					await file.close();
				} catch (error) {
					errors.push(error);
				}
				if (errors.length > 0) throw new AggregateError(errors, "Failed to stop schedules");
			})().then(resolve, reject);
			return promise;
		},
		activate: (context) => mutate(() => file.activate(context), context, false),
	};
}

export function createSchedulesFacet(options: SchedulesServiceOptions): Facet {
	return defineFacet({
		id: "@amazme/schedules",
		setup(env) {
			const runtime = createSchedulesService(options, (initial) => env.replicatedState(initial));
			env.provide(Schedules, runtime.service);
			env.own(() => runtime.stop());
			env.onActivate(async () => {
				await runtime.activate(BACKGROUND_CONTEXT);
				runtime.start();
			});
		},
	});
}
