import { type Context, defineService, type ReplicatedState } from "@amazme/chord";

/**
 * One command the session offers. A presentation renders the composer's command palette from these
 * names and descriptions, and runs one by name with its argument text, the way the TUI's own
 * registry does.
 */
export interface CommandSummary {
	name: string;
	description: string;
	/** The shape of the argument, for the palette's hint line. */
	argumentHint?: string;
}

/** One completion for a command's argument, such as a model id or a thinking level. */
export interface CommandCompletion {
	value: string;
	label: string;
	description?: string;
}

/**
 * What running a command produced. A failure is a value rather than a rejected call: the composer
 * shows it on the connection line, and an RPC-layer error would arrive as an opaque message.
 */
export type CommandResult =
	| { readonly ok: true; readonly note: string }
	| { readonly ok: false; readonly problem: string };

export interface CommandsState {
	revision: number;
	commands: CommandSummary[];
}

/** The session's command surface: what it offers, how to complete an argument, and how to run one. */
export interface Commands {
	readonly state: ReplicatedState<CommandsState>;
	run(name: string, args: string, context: Context): Promise<CommandResult>;
	complete(name: string, prefix: string, context: Context): Promise<readonly CommandCompletion[]>;
}

export const Commands = defineService<Commands>("amazme.commands");
