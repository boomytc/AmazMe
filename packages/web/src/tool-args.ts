/** Tool summaries prioritize the requested command or file; unknown tools use bounded key=value pairs.
 * Expanded parameters retain the TUI's readable key: value layout, with raw JSON available for copying.
 */

const COLLAPSED_ARGS_CHARS = 100;

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function entriesOf(args: unknown): [string, unknown][] {
	if (args == null) return [];
	if (typeof args === "object" && !Array.isArray(args)) return Object.entries(args);
	return [["args", args]];
}

function shorten(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > COLLAPSED_ARGS_CHARS ? `${line.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : line;
}

/** An object-oriented digest, never a guessed interpretation of shell syntax. */
export function toolArgsSummary(name: string, args: unknown, label: (key: string) => string): string {
	const values = Object.fromEntries(entriesOf(args));
	if ((name === "bash" || name === "powershell") && typeof values.command === "string" && values.command.trim().length > 0) {
		const cwd = typeof values.cwd === "string" ? values.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) : undefined;
		return shorten(cwd ? `${values.command} · ${cwd}` : values.command);
	}
	if (["read", "write", "edit", "ls", "find", "grep"].includes(name) && typeof values.path === "string") {
		const path = values.path.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || values.path;
		const query = typeof values.pattern === "string" ? `${values.pattern} · ` : "";
		return shorten(query + path);
	}
	return collapsedToolArgs(args, label);
}

/** One line for unrecognized tools. Empty when the call has no arguments. */
export function collapsedToolArgs(args: unknown, label: (key: string) => string = (key) => key): string {
	const entries = entriesOf(args);
	if (entries.length === 0) return "";
	const pairs = entries.map(([key, value]) => `${label(key)}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	return pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
}

/** `key: value` lines for the open tool card. Empty when the call has no arguments. */
export function expandedToolArgs(args: unknown, label: (key: string) => string = (key) => key): string {
	const entries = entriesOf(args);
	if (entries.length === 0) return "";
	return entries
		.map(([key, value]) => {
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			const body = replaceTabs(text).replace(/\r/g, "").split("\n").join("\n  ");
			return `${label(key)}: ${body}`;
		})
		.join("\n");
}
