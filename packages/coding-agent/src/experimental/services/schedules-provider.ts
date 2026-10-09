import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@amazme/chord/context";
import { type Context, defineFacet, type Facet, type MutableReplicatedState } from "@amazme/chord";
import {
	type ScheduleInput,
	type ScheduleRecord,
	type ScheduleResult,
	Schedules,
	type SchedulesState,
} from "./schedules.ts";

/** The shortest gap a schedule may have. */
export const SCHEDULE_MIN_MINUTES = 1;
/** The longest prompt the store accepts, so one file stays readable. */
export const SCHEDULE_MAX_PROMPT = 8_000;
/** How often the host looks for due schedules when nothing else says otherwise. */
export const SCHEDULE_DEFAULT_TICK_MS = 5_000;

export interface SchedulesServiceOptions {
	/** The agent directory: the schedules file lives beside the settings the CLI reads. */
	readonly agentDir: string;
	/** Run one prompt, joining its accepted work's cancellation before rejecting; the note is shown in the panel. */
	run(sessionId: string, prompt: string, context: Context): Promise<string>;
	/** The clock, so a test can move time instead of waiting for it. */
	readonly now?: () => number;
	/** The gap between the host's checks for due schedules. */
	readonly tickMs?: number;
}

interface SchedulesFile {
	readonly version: number;
	readonly schedules: readonly ScheduleRecord[];
}

/** Keep only what the store accepts: a prompt, a session, and a positive cadence. */
function parseSchedule(value: unknown): ScheduleRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		record.id.length === 0 ||
		typeof record.sessionId !== "string" ||
		record.sessionId.length === 0 ||
		typeof record.prompt !== "string" ||
		typeof record.everyMs !== "number" ||
		!Number.isFinite(record.everyMs) ||
		record.everyMs <= 0 ||
		typeof record.enabled !== "boolean" ||
		typeof record.createdAt !== "number" ||
		typeof record.nextRunAt !== "number"
	) {
		return undefined;
	}
	return {
		id: record.id,
		sessionId: record.sessionId,
		prompt: record.prompt,
		everyMs: record.everyMs,
		enabled: record.enabled,
		createdAt: record.createdAt,
		lastRunAt: typeof record.lastRunAt === "number" ? record.lastRunAt : null,
		lastOutcome: typeof record.lastOutcome === "string" ? record.lastOutcome : null,
		nextRunAt: record.nextRunAt,
	};
}

export interface SchedulesService {
	readonly service: {
		readonly state: MutableReplicatedState<SchedulesState>;
		add(input: ScheduleInput, context: Context): Promise<ScheduleResult>;
		remove(id: string, context: Context): Promise<void>;
		setEnabled(id: string, enabled: boolean, context: Context): Promise<ScheduleResult>;
		runNow(id: string, context: Context): Promise<ScheduleResult>;
		reload(context: Context): Promise<void>;
	};
	/** Run every schedule that is due, and record what each produced. */
	tick(context: Context): Promise<void>;
	/** Start the host's own check loop. */
	start(): void;
	/** Close admission, cancel accepted runs, and join their cleanup and the store's writes. */
	stop(): Promise<void>;
	/** The starting read, for the facet's activation. */
	activate(context: Context): Promise<void>;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The schedule store: one JSON file in the agent directory, written atomically (a temporary file
 * and a rename), read back at activation and on demand. The host runs due schedules itself; the
 * file is the same one a CLI could read, so a schedule made in the browser outlives the tab.
 *
 * A run is a whole turn against a session and can take minutes, so it stays outside the store's
 * write queue: only the reads, the record updates, and the writes are serialized, and the queue is
 * private to this service rather than the server's shared mutation tail.
 */
export function createSchedulesService(
	options: SchedulesServiceOptions,
	createState: (initial: SchedulesState) => MutableReplicatedState<SchedulesState>,
): SchedulesService {
	const path = join(options.agentDir, "schedules.json");
	const now = options.now ?? (() => Date.now());
	const tickMs = options.tickMs ?? SCHEDULE_DEFAULT_TICK_MS;
	const state = createState({ revision: 1, path, tickMs, schedules: [] });
	let schedules: ScheduleRecord[] = [];
	let timer: NodeJS.Timeout | undefined;
	let ticking = false;
	let stopped = false;
	let stopPromise: Promise<void> | undefined;
	const running = new Map<string, { controller: AbortController; done: Promise<ScheduleResult> }>();
	let mutationTail: Promise<unknown> = Promise.resolve();

	/** Serialize admission and file changes; model work never holds this queue. */
	const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = mutationTail.then(operation, operation);
		mutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const publish = (context: Context): void => {
		state.change(context, (draft) => {
			draft.revision += 1;
			draft.path = path;
			draft.tickMs = tickMs;
			draft.schedules = schedules;
		});
	};

	const commit = async (next: ScheduleRecord[], context: Context): Promise<void> => {
		const body: SchedulesFile = { version: 1, schedules: next };
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(body, null, "\t")}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
		schedules = next;
		publish(context);
	};

	const load = (context: Context): Promise<void> =>
		mutate(async () => {
			if (stopped) throw new Error("Schedules are stopped.");
			if (running.size > 0) throw new Error("Wait for running schedules before reloading the file.");
			context.abortSignal?.throwIfAborted();
			let parsed: unknown;
			try {
				parsed = JSON.parse(await readFile(path, "utf8"));
			} catch {
				schedules = [];
				publish(context);
				return;
			}
			const list =
				typeof parsed === "object" && parsed !== null ? (parsed as { schedules?: unknown }).schedules : undefined;
			schedules = (Array.isArray(list) ? list : []).flatMap((entry) => {
				const record = parseSchedule(entry);
				return record === undefined ? [] : [record];
			});
			publish(context);
		});

	const find = (id: string): ScheduleRecord | undefined => schedules.find((record) => record.id === id);

	const due = (): ScheduleRecord[] => schedules.filter((record) => record.enabled && record.nextRunAt <= now());

	/**
	 * Run one schedule and record what it produced; the returned result is shown to the reader.
	 * A due run moves the cadence on from the moment it finished; a manual run leaves it where it was.
	 */
	const run = async (record: ScheduleRecord, context: Context, advance: boolean): Promise<ScheduleResult> => {
		const at = now();
		let outcome: string;
		let result: ScheduleResult;
		try {
			context.abortSignal?.throwIfAborted();
			const note = await options.run(record.sessionId, record.prompt, context);
			outcome = note;
			result = { ok: true, note };
		} catch (error) {
			outcome = `failed: ${describe(error)}`;
			result = { ok: false, problem: outcome };
		}
		await mutate(async () => {
			const current = find(record.id);
			if (current === undefined) return;
			const updated: ScheduleRecord = {
				...current,
				lastRunAt: at,
				lastOutcome: outcome,
				nextRunAt: advance && current.enabled ? now() + current.everyMs : current.nextRunAt,
			};
			await commit(
				schedules.map((candidate) => (candidate.id === record.id ? updated : candidate)),
				withoutAbortSignal(context),
			);
		});
		return result;
	};

	const execute = async (id: string, context: Context, advance: boolean): Promise<ScheduleResult> => {
		const accepted = await mutate<{ refusal: string } | { done: Promise<ScheduleResult> }>(async () => {
			if (stopped) return { refusal: "Schedules are stopped." };
			context.abortSignal?.throwIfAborted();
			const record = find(id);
			if (record === undefined) return { refusal: "That schedule is gone." };
			if (running.has(id)) return { refusal: "That schedule is already running." };
			if (advance && (!record.enabled || record.nextRunAt > now())) return { refusal: "That schedule is not due." };
			const controller = new AbortController();
			const { promise: done, resolve, reject } = Promise.withResolvers<ScheduleResult>();
			running.set(id, { controller, done });
			void run(record, withAbortSignal(controller.signal, context), advance).then(
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
		});
		return "refusal" in accepted ? { ok: false, problem: accepted.refusal } : accepted.done;
	};

	const tick = async (context: Context): Promise<void> => {
		// One pass at a time: a real run takes longer than the gap between checks.
		if (stopped || ticking) return;
		ticking = true;
		try {
			for (const record of due()) {
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
			async add(input: ScheduleInput, context: Context): Promise<ScheduleResult> {
				const prompt = input.prompt.trim();
				if (input.sessionId.length === 0) return { ok: false, problem: "A schedule needs a session." };
				if (prompt.length === 0) return { ok: false, problem: "A schedule needs a prompt." };
				if (prompt.length > SCHEDULE_MAX_PROMPT) {
					return { ok: false, problem: `A prompt may hold at most ${SCHEDULE_MAX_PROMPT} characters.` };
				}
				if (!Number.isFinite(input.everyMinutes) || input.everyMinutes < SCHEDULE_MIN_MINUTES) {
					return { ok: false, problem: `The gap must be at least ${SCHEDULE_MIN_MINUTES} minute.` };
				}
				const everyMs = Math.round(input.everyMinutes * 60_000);
				const at = now();
				const record: ScheduleRecord = {
					id: randomUUID(),
					sessionId: input.sessionId,
					prompt,
					everyMs,
					enabled: true,
					createdAt: at,
					lastRunAt: null,
					lastOutcome: null,
					nextRunAt: at + everyMs,
				};
				return mutate(async () => {
					if (stopped) return { ok: false, problem: "Schedules are stopped." };
					context.abortSignal?.throwIfAborted();
					await commit([...schedules, record], context);
					return { ok: true, note: "Added. It runs on its own from now on." };
				});
			},
			async remove(id: string, context: Context): Promise<void> {
				const active = await mutate(async () => {
					if (stopped) throw new Error("Schedules are stopped.");
					context.abortSignal?.throwIfAborted();
					const next = schedules.filter((record) => record.id !== id);
					if (next.length !== schedules.length) await commit(next, context);
					return running.get(id);
				});
				active?.controller.abort(new Error("Schedule was removed."));
				await active?.done;
			},
			async setEnabled(id: string, enabled: boolean, context: Context): Promise<ScheduleResult> {
				return mutate(async () => {
					if (stopped) return { ok: false, problem: "Schedules are stopped." };
					context.abortSignal?.throwIfAborted();
					const record = find(id);
					if (record === undefined) return { ok: false, problem: "That schedule is gone." };
					const updated = {
						...record,
						enabled,
						nextRunAt: enabled ? now() + record.everyMs : record.nextRunAt,
					};
					await commit(
						schedules.map((candidate) => (candidate.id === id ? updated : candidate)),
						context,
					);
					return { ok: true, note: enabled ? "Running again." : "Paused." };
				});
			},
			async runNow(id: string, context: Context): Promise<ScheduleResult> {
				// A manual run does not move the cadence, so a paused schedule stays paused.
				return execute(id, context, false);
			},
			reload: (context: Context) => load(context),
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
			timer = undefined;
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			stopPromise = promise;
			for (const entry of running.values()) entry.controller.abort(new Error("Schedules are stopped."));
			void (async () => {
				const results = await Promise.allSettled([...running.values()].map((entry) => entry.done));
				await mutationTail;
				const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
				if (errors.length > 0) throw new AggregateError(errors, "Failed to stop schedules");
			})().then(resolve, reject);
			return promise;
		},
		activate: (context: Context) => load(context),
	};
}

/** The schedule service as a facet: it owns the file's state, reads it once, and runs the timer. */
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
