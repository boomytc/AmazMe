/** Tool summaries prioritize the requested command or file; unknown tools use bounded key=value pairs.
 * Expanded parameters retain the TUI's readable key: value layout, with raw JSON available for copying.
 */
import type { Locale } from "./locale.ts";
import { translate } from "./strings.ts";
import type { TranscriptBlock } from "./view.ts";

const COLLAPSED_ARGS_CHARS = 100;
const DISPLAY_CHARS = 100_000;
const DISPLAY_NODES = 2_000;
const DISPLAY_DEPTH = 100;

/** Check parsed JSON before pretty-printing can amplify its size or nesting. */
function withinDisplayBudget(value: unknown): boolean {
	let nodes = 0;
	const visit = (item: unknown, depth: number): boolean => {
		if (++nodes > DISPLAY_NODES || depth > DISPLAY_DEPTH) return false;
		if (Array.isArray(item)) {
			const children: readonly unknown[] = item;
			for (const child of children) if (!visit(child, depth + 1)) return false;
		} else if (item !== null && typeof item === "object") {
			for (const key in item) if (!visit(Reflect.get(item, key), depth + 1)) return false;
		}
		return true;
	};
	return visit(value, 0);
}

/** The display boundary keeps the lossless source separate from bounded formatting. */
export function toolArguments(locale: Locale, source: string): { readonly args: unknown; readonly view: NonNullable<TranscriptBlock["toolArgs"]> } {
	const notice = translate(locale, "tool.argsDisplayLimit");
	const clip = (text: string): string => text.length <= DISPLAY_CHARS ? text : `${text.slice(0, DISPLAY_CHARS).replace(/[\uD800-\uDBFF]$/u, "")}\n\n${notice}`;
	const limited = (expanded: string) => ({ args: undefined, view: { collapsed: shorten(notice), expanded, source } });
	if (source.length > DISPLAY_CHARS) return limited(clip(source));
	let args: unknown;
	try { args = JSON.parse(source); } catch { args = source; }
	if (!withinDisplayBudget(args)) return limited(notice);
	return { args, view: { collapsed: collapsedToolArgs(args), expanded: clip(expandedToolArgs(args)), source } };
}

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
