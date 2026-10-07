import { type Context, defineService, type ReplicatedState } from "@amazme/chord";

/** One planned prompt: what to send, to which session, and how often. */
export interface ScheduleRecord {
	id: string;
	/** The session the prompt goes to. */
	sessionId: string;
	prompt: string;
	/** The gap between runs. */
	everyMs: number;
	enabled: boolean;
	createdAt: number;
	/** When it last ran, and what that run produced. */
	lastRunAt: number | null;
	lastOutcome: string | null;
	/** When it runs next; a disabled schedule keeps the value it would have used. */
	nextRunAt: number;
}

export interface SchedulesState {
	revision: number;
	/** The file the schedules are stored in, so a reader can find it. */
	path: string;
	/** The gap between the host's checks for due schedules. */
	tickMs: number;
	/** In id order. */
	schedules: ScheduleRecord[];
}

/** What adding or running a schedule produced; a refused input is a value, not a thrown call. */
export type ScheduleResult =
	| { readonly ok: true; readonly note: string }
	| { readonly ok: false; readonly problem: string };

export interface ScheduleInput {
	readonly sessionId: string;
	readonly prompt: string;
	/** Minutes between runs, at least one. */
	readonly everyMinutes: number;
}

/** Planned prompts the host runs on their own, stored in one file. */
export interface Schedules {
	readonly state: ReplicatedState<SchedulesState>;
	add(input: ScheduleInput, context: Context): Promise<ScheduleResult>;
	remove(id: string, context: Context): Promise<void>;
	setEnabled(id: string, enabled: boolean, context: Context): Promise<ScheduleResult>;
	/** Run one schedule now, whether or not it is due, and record what it produced. */
	runNow(id: string, context: Context): Promise<ScheduleResult>;
	/** Re-read the file, discarding what another process changed. */
	reload(context: Context): Promise<void>;
}

export const Schedules = defineService<Schedules>("amazme.schedules");
