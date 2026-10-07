/**
 * Short tool-call arguments, ported from the TUI's `formatToolCallWithArgs` (`render-utils.ts`)
 * without terminal colour. Collapsed, arguments are `key=value` pairs cut to
 * {@link COLLAPSED_ARGS_CHARS} so a row cannot become a JSON wall. Expanded, each argument is a
 * `key: value` line: strings raw, other values pretty-printed, continuation lines indented.
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

/** One line for the collapsed tool row. Empty when the call has no arguments. */
export function collapsedToolArgs(args: unknown): string {
	const entries = entriesOf(args);
	if (entries.length === 0) return "";
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	return pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
}

/** `key: value` lines for the open tool card. Empty when the call has no arguments. */
export function expandedToolArgs(args: unknown): string {
	const entries = entriesOf(args);
	if (entries.length === 0) return "";
	return entries
		.map(([key, value]) => {
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			const body = replaceTabs(text).replace(/\r/g, "").split("\n").join("\n  ");
			return `${key}: ${body}`;
		})
		.join("\n");
}
