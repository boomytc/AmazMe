/**
 * The composer's command palette, as a projection: a draft line parsed into a command and its
 * argument, the host's catalogue filtered by it, the argument completions, and the `/skill:<name>`
 * commands the loaded skills offer. The expansion of a skill command mirrors the CLI's
 * `_expandSkillCommand`, so a skill invoked from the page reaches the model in the same shape it
 * would from the terminal.
 */
import type { Locale } from "./locale.ts";
import { translate } from "./strings.ts";

/** One command the host offers, as the page reads it from the session's catalogue. */
export interface CommandLike {
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
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

/**
 * The palette for one draft. While the draft is still a bare name, the rows are the host's commands
 * (and the skill commands) that start with it; once a space follows a known command, the rows are
 * that command's argument completions. `selected` marks the row the renderer highlights.
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
		.map((command, index) => ({
			value: command.name,
			label: `/${command.name}`,
			description: command.description,
			...(command.argumentHint === undefined ? {} : { hint: command.argumentHint }),
			selected: index === selected,
		}));
	return {
		open: true,
		title,
		rows,
		...(rows.length === 0 ? { empty: translate(locale, "palette.noCommands") } : {}),
	};
}

/** The `/skill:<name>` commands the loaded skills offer, once the agent registers them. */
export function skillCommands(skills: readonly { readonly name: string; readonly description: string }[]): CommandLike[] {
	return skills.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, argumentHint: "[args]" }));
}

/** The file's frontmatter removed, the way the CLI's skill expansion strips it. */
export function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return content;
	const after = content.indexOf("\n", end + 1);
	return after === -1 ? "" : content.slice(after + 1);
}

/**
 * The prompt one skill command expands to: the skill's own body in a `<skill>` block, then the
 * reader's arguments. This is the CLI's shape, so the model sees the same thing either way.
 */
export function expandSkillCommand(
	skill: { readonly name: string; readonly filePath: string; readonly content: string },
	args: string,
): string {
	const baseDir = skill.filePath.slice(0, Math.max(0, skill.filePath.lastIndexOf("/")));
	const body = stripFrontmatter(skill.content).trim();
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
	const trimmed = args.trim();
	return trimmed.length === 0 ? block : `${block}\n\n${trimmed}`;
}
