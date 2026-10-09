import { randomUUID } from "node:crypto";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@amazme/chord/context";
import { defineFacet } from "@amazme/chord";
import type { Context, Facet, MutableReplicatedState } from "@amazme/chord";
import { Schedules } from "@amazme/coding-agent/plugin";
import type {
	HostPromptRequest,
	HostPromptResult,
	ScheduleInput,
	ScheduleRecord,
	ScheduleResult,
	ScheduleRun,
	ScheduleRunReceipt,
	SchedulesState,
} from "@amazme/coding-agent/plugin";
import type { AgentPromptResult } from "@amazme/coding-agent/plugin";
import { createScheduleFile } from "./file.ts";
import { conversationId, MAX_SCHEDULE_TIME, SCHEDULE_MAX_PROMPT, timestamp } from "./records.ts";

export { SCHEDULE_MAX_PROMPT } from "./records.ts";
export const SCHEDULE_MIN_MINUTES = 1;
export const SCHEDULE_DEFAULT_TICK_MS = 5_000;

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

/** One host owns the file lease. Durable submissions own execution and deduplication. */
export function createSchedulesService(
	options: SchedulesServiceOptions,
	createState: (initial: SchedulesState) => MutableReplicatedState<SchedulesState>,
): SchedulesService {
	const now = options.now ?? Date.now;
	const tickMs = options.tickMs ?? SCHEDULE_DEFAULT_TICK_MS;
	const state = createState({
		revision: 1,
		path: "",
		tickMs,
		problem: null,
		schedules: [],
	});
	let timer: NodeJS.Timeout | undefined;
	let ticking = false;
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

	const mutate = <T>(operation: () => Promise<T>, context: Context, writable = true, settling = false): Promise<T> => {
		const result = mutationTail.then(async () => {
			if (writable && file.path.length === 0) throw new Error("Activate schedules before using the store.");
			if (stopped && !settling) throw new Error("Schedules are stopped.");
			if (writable) await file.own(context);
			return operation();
		});
		mutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	const request = (record: ScheduleRecord, run: ScheduleRun): HostPromptRequest => ({
		conversationId: record.conversationId,
		requestId: run.requestId,
		message: record.prompt,
	});
	const cleanupContext = (context: Context): Context => withoutAbortSignal(context);
	const cancelRun = async (record: ScheduleRecord, pending: ScheduleRun, context: Context) => {
		const settled = await options.cancel(record.sessionId, request(record, pending), cleanupContext(context));
		return settled?.status === "done"
			? { status: "done" as const, note: "Answered." }
			: { status: "cancelled" as const, note: "Cancelled." };
	};

	const run = async (record: ScheduleRecord, pending: ScheduleRun, context: Context): Promise<ScheduleResult> => {
		let status: ScheduleRunReceipt["status"] = "unanswered";
		let note = "";
		let cancelled = false;
		try {
			if (pending.cancelling) {
				({ status, note } = await cancelRun(record, pending, context));
			} else {
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
									(current) => ({
										...current,
										pending: { ...current.pending!, operationId },
									}),
									cleanupContext(context),
								);
							},
							cleanupContext(context),
							true,
							true,
						);
					},
					context,
				);
				status = settled.status;
				note =
					settled.status === "done"
						? "Answered."
						: settled.status === "unanswered"
							? `No answer: ${settled.reason}`
							: `failed: ${settled.message}`;
			}
		} catch (error) {
			if (context.abortSignal?.aborted) {
				try {
					({ status, note } = await cancelRun(record, pending, context));
					cancelled = true;
				} catch (cancelError) {
					error = new AggregateError([error, cancelError], "Schedule cancellation awaits recovery");
				}
			}
			if (!cancelled) {
				await mutate(
					async () => {
						if (find(record.id)?.pending?.requestId !== pending.requestId) return;
						await update(
							record.id,
							(current) => ({
								...current,
								pending: {
									...current.pending!,
									cancelling: current.pending!.cancelling || context.abortSignal?.aborted === true,
									problem: describe(error),
								},
							}),
							cleanupContext(context),
						);
					},
					cleanupContext(context),
					true,
					true,
				);
				return {
					ok: false,
					problem: `Delivery awaits recovery: ${describe(error)}`,
				};
			}
		}
		await mutate(
			async () => {
				const current = find(record.id);
				if (current?.pending?.requestId !== pending.requestId) return;
				const receipt: ScheduleRunReceipt = {
					requestId: pending.requestId,
					operationId: current.pending.operationId,
					startedAt: pending.startedAt,
					finishedAt: now(),
					status,
					note,
				};
				await update(
					record.id,
					(latest) => ({
						...latest,
						pending: null,
						history: [...latest.history.filter((entry) => entry.requestId !== receipt.requestId), receipt].slice(-20),
						lastRunAt: pending.startedAt,
						lastOutcome: note,
						nextRunAt:
							pending.scheduledFor !== null && latest.enabled
								? Math.min(MAX_SCHEDULE_TIME, now() + latest.everyMs)
								: latest.nextRunAt,
					}),
					cleanupContext(context),
				);
			},
			cleanupContext(context),
			true,
			true,
		);
		return status === "done" || status === "cancelled" ? { ok: true, note } : { ok: false, problem: note };
	};
	const execute = async (
		id: string,
		context: Context,
		automatic: boolean,
		manualKey?: string,
	): Promise<ScheduleResult> => {
		const admitted = await mutate<{ refusal: string } | { done: Promise<ScheduleResult> }>(async () => {
			if (stopped) return { refusal: "Schedules are stopped." };
			context.abortSignal?.throwIfAborted();
			await file.check(context);
			const record = find(id);
			if (record === undefined) return { refusal: "That schedule is gone." };
			const prior = record.history.find((receipt) => receipt.requestId === manualKey);
			if (prior !== undefined && record.pending?.requestId !== manualKey)
				return {
					done: Promise.resolve(
						prior.status === "done" || prior.status === "cancelled"
							? { ok: true, note: prior.note }
							: { ok: false, problem: prior.note },
					),
				};
			if (running.has(id))
				return manualKey === record.pending?.requestId
					? { done: running.get(id)!.done }
					: { refusal: "That schedule is already running." };
			if (manualKey !== undefined && record.pending !== null && manualKey !== record.pending.requestId)
				return { refusal: "The current delivery needs recovery before a new run." };
			if (record.pending === null && automatic && (!record.enabled || record.nextRunAt > now()))
				return { refusal: "That schedule is not due." };
			const pending: ScheduleRun = record.pending ?? {
				requestId: automatic
					? `schedule:${id}:${record.nextRunAt}`
					: (manualKey ?? `schedule:${id}:manual:${randomUUID()}`),
				operationId: null,
				startedAt: now(),
				scheduledFor: automatic ? record.nextRunAt : null,
				cancelling: false,
				problem: null,
			};
			if (record.pending === null) await update(id, (current) => ({ ...current, pending }), context);
			const controller = new AbortController();
			const { promise: done, resolve, reject } = Promise.withResolvers<ScheduleResult>();
			running.set(id, { controller, done });
			void run(record, pending, withAbortSignal(controller.signal, withoutAbortSignal(context))).then(
				(result) => {
					running.delete(id);
					resolve(result);
				},
				(error: unknown) => {
					running.delete(id);
					reject(error);
				},
			);
			return { done };
		}, context);
		return "refusal" in admitted ? { ok: false, problem: admitted.refusal } : awaitWithContext(admitted.done, context);
	};
	const cancel = async (id: string, context: Context): Promise<ScheduleResult> => {
		const entry = await mutate(async () => {
			if (stopped) throw new Error("Schedules are stopped.");
			context.abortSignal?.throwIfAborted();
			const record = find(id);
			if (record?.pending === undefined || record.pending === null) return undefined;
			await update(
				id,
				(current) => ({
					...current,
					pending: { ...current.pending!, cancelling: true },
				}),
				context,
			);
			return running.get(id);
		}, context);
		if (entry !== undefined) {
			entry.controller.abort(new Error("Schedule was cancelled."));
			return entry.done;
		}
		return find(id)?.pending ? execute(id, context, false) : { ok: true, note: "No active prompt." };
	};
	const tick = async (context: Context): Promise<void> => {
		if (stopped || file.problem !== null || ticking) return;
		ticking = true;
		try {
			for (const record of file.schedules.filter(
				(candidate) => candidate.pending !== null || (candidate.enabled && candidate.nextRunAt <= now()),
			)) {
				if (stopped) break;
				await execute(record.id, context, true);
			}
		} finally {
			ticking = false;
		}
	};

	return {
		service: {
			state,
			async add(input, context) {
				const prompt = input.prompt.trim();
				if (input.sessionId.length === 0 || !conversationId(input.conversationId))
					return {
						ok: false,
						problem: "A schedule needs a fixed session and conversation.",
					};
				if (prompt.length === 0 || prompt.length > SCHEDULE_MAX_PROMPT)
					return {
						ok: false,
						problem: `A prompt must contain 1–${SCHEDULE_MAX_PROMPT} characters.`,
					};
				if (!Number.isFinite(input.everyMinutes) || input.everyMinutes < SCHEDULE_MIN_MINUTES)
					return { ok: false, problem: "The gap must be at least one minute." };
				const everyMs = Math.round(input.everyMinutes * 60_000);
				const at = now();
				if (!timestamp(at + everyMs)) return { ok: false, problem: "The schedule time is out of range." };
				return mutate(async () => {
					if (stopped) return { ok: false, problem: "Schedules are stopped." };
					context.abortSignal?.throwIfAborted();
					await file.commit(
						[
							...file.schedules,
							{
								id: randomUUID(),
								sessionId: input.sessionId,
								conversationId: input.conversationId,
								prompt,
								everyMs,
								enabled: true,
								createdAt: at,
								lastRunAt: null,
								lastOutcome: null,
								nextRunAt: at + everyMs,
								pending: null,
								history: [],
							},
						],
						context,
					);
					return { ok: true, note: "Added. It runs on its own from now on." };
				}, context);
			},
			async remove(id, context) {
				await cancel(id, context);
				await mutate(async () => {
					if (stopped) throw new Error("Schedules are stopped.");
					if (find(id)?.pending) throw new Error("Cancel the current delivery before removing this schedule.");
					await file.commit(
						file.schedules.filter((record) => record.id !== id),
						context,
					);
				}, context);
			},
			setEnabled: (id, enabled, context) =>
				mutate(async () => {
					if (stopped) return { ok: false, problem: "Schedules are stopped." };
					context.abortSignal?.throwIfAborted();
					if (find(id) === undefined) return { ok: false, problem: "That schedule is gone." };
					await update(
						id,
						(record) => ({
							...record,
							enabled,
							nextRunAt: enabled ? now() + record.everyMs : record.nextRunAt,
						}),
						context,
					);
					return { ok: true, note: enabled ? "Running again." : "Paused." };
				}, context),
			runNow: (id, requestId, context) =>
				requestId.trim().length === 0 || requestId.length > 256
					? Promise.resolve({ ok: false, problem: "A manual run needs a stable request ID of at most 256 characters." })
					: execute(id, context, false, `schedule:${id}:manual:${requestId}`),
			cancel,
			reload: (context) =>
				mutate(
					async () => {
						if (stopped || running.size > 0) throw new Error("Wait for running schedules before reloading the file.");
						context.abortSignal?.throwIfAborted();
						await file.load(context);
					},
					context,
					false,
				),
		},
		tick,
		start() {
			if (stopped || timer !== undefined) return;
			timer = setInterval(() => {
				void tick(BACKGROUND_CONTEXT).catch(() => {});
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
							async () => {
								await file.commit(
									file.schedules.map((record) =>
										record.pending !== null
											? {
													...record,
													pending: { ...record.pending, cancelling: true },
												}
											: record,
									),
									BACKGROUND_CONTEXT,
								);
							},
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
						.concat(
							recovering.map((record) => run(record, { ...record.pending!, cancelling: true }, BACKGROUND_CONTEXT)),
						),
				);
				errors.push(...settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
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
