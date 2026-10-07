import { type Context, defineService, type ReplicatedState } from "@amazme/chord";

/**
 * Where a command comes from. The host's own four are `builtin`; the rest are resources the session
 * loaded — a prompt template, or a skill the reader may invoke as a command.
 */
export type CommandSource = "builtin" | "template" | "skill";

/**
 * One command the session offers. A presentation renders the composer's command palette from these
 * names and descriptions, runs a built-in by name with its argument text, and expands a resource
 * command into a prompt of its own.
 */
export interface CommandSummary {
	name: string;
	description: string;
	/** The shape of the argument, for the palette's hint line. */
	argumentHint?: string;
	/** What the command is, so the palette can say where it came from. */
	source: CommandSource;
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

/**
 * The prompt a resource command becomes, or why it cannot become one. Like a command's result, the
 * refusal is a value: the file may have been removed since the catalogue was read.
 */
export type CommandExpansion =
	| { readonly ok: true; readonly prompt: string }
	| { readonly ok: false; readonly problem: string };

export interface CommandsState {
	revision: number;
	commands: CommandSummary[];
}

/**
 * The session's command surface: what it offers, how to complete an argument, how to run the
 * host's own commands, and how to turn a resource command into the prompt it stands for.
 */
export interface Commands {
	readonly state: ReplicatedState<CommandsState>;
	/** Run a `builtin` command. A resource command goes through `expand`, since a presentation submits it. */
	run(name: string, args: string, context: Context): Promise<CommandResult>;
	complete(name: string, prefix: string, context: Context): Promise<readonly CommandCompletion[]>;
	/** The prompt a `template` or `skill` command stands for; the presentation sends it on its own path. */
	expand(name: string, args: string, context: Context): Promise<CommandExpansion>;
	/** Re-read the session's command resources after their files or settings changed. */
	refresh(context: Context): Promise<void>;
}

export const Commands = defineService<Commands>("amazme.commands");
