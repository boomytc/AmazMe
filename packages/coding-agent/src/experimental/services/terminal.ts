import { type Context, defineService, type ReplicatedState } from "@amazme/chord";

/** What the terminal's buffer says about the last command. */
export type TerminalStatus = "idle" | "running" | "done" | "cancelled";

export interface TerminalState {
	revision: number;
	status: TerminalStatus;
	/** The command line the buffer belongs to, or null before the first one. */
	command: string | null;
	/** The exit code of a settled command; null while it runs or when it was cancelled. */
	exitCode: number | null;
	/** The tail of the combined output, in arrival order. */
	output: string;
	/** Whether the buffer dropped output it could not keep. */
	truncated: boolean;
	/** Why a command could not be started, when it could not; null when it started. */
	error: string | null;
}

/** What running one command produced; a command already running is a value, not a rejected call. */
export type TerminalRunResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly problem: string };

/** One shell at a time in the Session's working directory, with its output as replicated state. */
export interface Terminal {
	readonly state: ReplicatedState<TerminalState>;
	run(command: string, context: Context): Promise<TerminalRunResult>;
	/** Stop the running command; it settles as cancelled with the output it produced. */
	stop(context: Context): Promise<void>;
}

export const Terminal = defineService<Terminal>("amazme.terminal");
