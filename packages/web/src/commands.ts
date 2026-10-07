/**
 * The composer's command palette, as a projection: a draft line parsed into a command and its
 * argument, the host's catalogue filtered by it, and the argument completions the host offers. The
 * catalogue carries where each command came from, so a row can say whether it is the host's own
 * command, a prompt template, or a skill — the same three sources the terminal lists.
 */
import type { Locale } from "./locale.ts";
import { translate } from "./strings.ts";

/** Where a command comes from, as the host reports it. */
export type CommandSource = "builtin" | "template" | "skill";

/** One command the host offers, as the page reads it from the session's catalogue. */
export interface CommandLike {
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly source?: CommandSource;
}

/** One completion the host offers for a command's argument. */
export interface CommandCompletionLike {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

/** A draft that starts with `/`, split into the command's name and the rest of the line. */
export interface CommandLine {
	readonly name: string;
	readonly args: string;
}

/**
 * A draft parsed as a command line: `/name` or `/name args`. An empty name is not a command, so a
 * lone `/` stays the focus shortcut's business and a plain prompt is never mistaken for one.
 */
export function parseCommandLine(draft: string): CommandLine | undefined {
	const line = paletteLine(draft);
	return line === undefined || line.name.length === 0 ? undefined : line;
}

/**
 * The draft as a palette line. A bare `/` is the empty name, which matches every command — that is
 * how typing the slash alone lists what the session offers — while a name that is not a command
 * shape at all (a capital, punctuation) closes the palette entirely.
 */
function paletteLine(draft: string): CommandLine | undefined {
	if (!draft.startsWith("/")) return undefined;
	const space = draft.indexOf(" ");
	const name = space === -1 ? draft.slice(1) : draft.slice(1, space);
	if (!/^[a-z0-9:-]*$/.test(name)) return undefined;
	return { name, args: space === -1 ? "" : draft.slice(space + 1) };
}

/** One palette row: a command to pick, or an argument value to complete. */
export interface CommandRow {
	/** The text the row stands for: a command name or an argument value. */
	readonly value: string;
	readonly label: string;
	readonly description: string;
	/** The command's argument shape, shown beside a command row. */
	readonly hint?: string;
	/** Where the command came from, when the host said. */
	readonly tag?: string;
	readonly selected: boolean;
}

export interface CommandPalette {
	readonly open: boolean;
	readonly title: string;
	/** The rows, narrowest first: a filter narrows them as the reader types. */
	readonly rows: readonly CommandRow[];
	/** The line shown when a filter matches nothing. */
	readonly empty?: string;
}

const CLOSED: (locale: Locale) => CommandPalette = (locale) => ({
	open: false,
	title: translate(locale, "palette.title"),
	rows: [],
});

/** The row tag for one source. The host's own commands carry none. */
function sourceTag(locale: Locale, source: CommandSource | undefined): string | undefined {
	if (source === "template") return translate(locale, "palette.tagTemplate");
	if (source === "skill") return translate(locale, "palette.tagSkill");
	return undefined;
}

/**
 * The palette for one draft. While the draft is still a bare name, the rows are the host's commands
 * that start with it; once a space follows a known command, the rows are that command's argument
 * completions. `selected` marks the row the renderer highlights.
 */
export function commandPalette(
	locale: Locale,
	options: {
		readonly draft: string;
		readonly commands: readonly CommandLike[];
		readonly completions?: readonly CommandCompletionLike[];
		readonly selected?: number;
	},
): CommandPalette {
	const line = paletteLine(options.draft);
	if (line === undefined) return CLOSED(locale);
	const selected = options.selected ?? 0;
	const title = translate(locale, "palette.title");
	if (options.draft.includes(" ")) {
		const completions = options.completions ?? [];
		return {
			open: true,
			title,
			rows: completions.map((completion, index) => ({
				value: completion.value,
				label: completion.label,
				description: completion.description ?? "",
				selected: index === selected,
			})),
			...(completions.length === 0 ? { empty: translate(locale, "palette.noCompletions") } : {}),
		};
	}
	const rows = options.commands
		.filter((command) => command.name.startsWith(line.name))
		.map((command, index) => {
			const tag = sourceTag(locale, command.source);
			return {
				value: command.name,
				label: `/${command.name}`,
				description: command.description,
				...(command.argumentHint === undefined ? {} : { hint: command.argumentHint }),
				...(tag === undefined ? {} : { tag }),
				selected: index === selected,
			};
		});
	return {
		open: true,
		title,
		rows,
		...(rows.length === 0 ? { empty: translate(locale, "palette.noCommands") } : {}),
	};
}
