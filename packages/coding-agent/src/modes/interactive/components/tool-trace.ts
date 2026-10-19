import { Container, type TuiMouseEvent } from "@amazme/tui";
import { countDiffLines } from "../../../core/tools/render-utils.ts";
import { theme } from "../theme/theme.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

type TraceKind = "explore" | "edit" | "command";

interface TraceSegment {
	readonly lines: string[];
	readonly cards: readonly ToolExecutionComponent[];
	readonly summary: boolean;
}

/** Consecutive settled calls of one kind fold into a summary row. */
function toolTraceKind(name: string): TraceKind | undefined {
	if (name === "read" || name === "grep" || name === "find" || name === "ls") return "explore";
	if (name === "edit" || name === "write") return "edit";
	if (name === "bash" || name === "powershell") return "command";
	return undefined;
}

/**
 * One run of tool cards in the transcript. Consecutive settled successes of the
 * same kind draw as one summary line. A pending or failed card stays its own
 * row, and so does a single call. Expanding the summary, or the expand key,
 * lists each card's own body.
 */
export class ToolTraceRun extends Container {
	readonly cards: ToolExecutionComponent[] = [];
	#segments: TraceSegment[] = [];

	add(card: ToolExecutionComponent): void {
		if (!this.cards.includes(card)) this.cards.push(card);
	}

	override render(width: number): string[] {
		this.#segments = layoutTrace(this.cards, width);
		return this.#segments.flatMap((segment) => segment.lines);
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (this.#segments.length === 0) this.#segments = layoutTrace(this.cards, event.width);
		let top = 0;
		for (const segment of this.#segments) {
			const height = segment.lines.length;
			if (event.y >= top && event.y < top + height) {
				if (segment.summary && event.y === top) {
					if (event.type !== "click" || event.button !== "left") return undefined;
					const open = segment.cards.every((card) => card.transcriptRowExpanded());
					for (const card of segment.cards) card.setExpanded(!open);
					return {
						handled: true,
						target: {
							component: this,
							originX: event.screenX - event.x,
							originY: event.screenY - event.y + top,
							width: event.width,
							height,
						},
					};
				}
				const card = segment.cards[0];
				if (card === undefined) return undefined;
				return card.handleMouse({ ...event, y: event.y - top, height });
			}
			top += height;
		}
		return undefined;
	}
}

/** Places tool cards into runs, closing a run when a non-tool row begins. */
export class ToolTracePlacement {
	#run: ToolTraceRun | undefined;
	readonly #chat: Container;

	constructor(chat: Container) {
		this.#chat = chat;
	}

	reset(): void {
		this.#run = undefined;
	}

	close(): void {
		this.#run = undefined;
	}

	add(card: ToolExecutionComponent): void {
		if (this.#run === undefined) {
			this.#run = new ToolTraceRun();
			this.#chat.addChild(this.#run);
		}
		this.#run.add(card);
	}
}

function layoutTrace(cards: readonly ToolExecutionComponent[], width: number): TraceSegment[] {
	const segments: TraceSegment[] = [];
	let index = 0;
	while (index < cards.length) {
		const kind = foldKind(cards[index]);
		if (kind === undefined) {
			const card = cards[index];
			if (card !== undefined) segments.push(cardSegment(card, width));
			index += 1;
			continue;
		}
		let end = index + 1;
		while (end < cards.length && foldKind(cards[end]) === kind) end += 1;
		const group = cards.slice(index, end);
		const lines = [summaryLine(kind, group)];
		if (group.some((card) => card.transcriptRowExpanded())) {
			for (const card of group) {
				card.setTraceBodyOnly(true);
				lines.push(...card.render(width));
			}
		} else {
			for (const card of group) card.setTraceBodyOnly(false);
		}
		segments.push({ lines, cards: group, summary: true });
		index = end;
	}
	return segments;
}

function cardSegment(card: ToolExecutionComponent, width: number): TraceSegment {
	return { lines: card.render(width), cards: [card], summary: false };
}

function foldKind(card: ToolExecutionComponent | undefined): TraceKind | undefined {
	if (card === undefined) return undefined;
	const state = card.traceState;
	if (state.pending || state.failed) return undefined;
	return toolTraceKind(state.name);
}

function summaryLine(kind: TraceKind, cards: readonly ToolExecutionComponent[]): string {
	const pad = cards[0]?.traceState.outputPad ?? 0;
	if (kind === "explore") return traceRow(pad, exploreLabel(cards));
	if (kind === "edit") {
		const edit = editLabel(cards);
		return traceRow(pad, edit.text, edit.stat);
	}
	return traceRow(pad, commandLabel(cards));
}

function exploreLabel(cards: readonly ToolExecutionComponent[]): string {
	const files: string[] = [];
	const directories: string[] = [];
	const searches: SearchFact[] = [];
	for (const card of cards) {
		const state = card.traceState;
		const path = displayPath(argPath(state.args));
		if (state.name === "read") {
			if (path !== undefined) files.push(path);
		} else if (state.name === "ls") directories.push(path ?? ".");
		else searches.push(searchFact(state));
	}
	const uniqueFiles = unique(files);
	const uniqueDirectories = unique(directories);
	const only = cards.length === 1 ? cards[0] : undefined;
	if (only?.traceState.name === "read" && uniqueFiles.length === 1) return `Read ${uniqueFiles[0]}`;
	if (only !== undefined && (only.traceState.name === "grep" || only.traceState.name === "find") && searches[0] !== undefined) {
		return searchLabel(searches[0]);
	}
	if (uniqueFiles.length === 1 && uniqueDirectories.length === 0 && searches.length > 0) {
		return `Explored ${uniqueFiles[0]}, ${countPhrase(searches.length, "search", "searches")}`;
	}
	if (uniqueFiles.length === 1 && uniqueDirectories.length === 0 && searches.length === 0) {
		return `Explored ${uniqueFiles[0]}`;
	}
	if (uniqueDirectories.length === 1 && uniqueFiles.length === 0 && searches.length === 0) {
		return `Explored ${uniqueDirectories[0]}`;
	}
	const parts: string[] = [];
	if (uniqueDirectories.length > 0) parts.push(countPhrase(uniqueDirectories.length, "directory", "directories"));
	if (uniqueFiles.length > 0) parts.push(countPhrase(uniqueFiles.length, "file", "files"));
	if (searches.length > 0) parts.push(countPhrase(searches.length, "search", "searches"));
	return `Explored ${parts.join(", ")}`;
}

function editLabel(cards: readonly ToolExecutionComponent[]): { text: string; stat: string } {
	const paths: string[] = [];
	let added = 0;
	let removed = 0;
	for (const card of cards) {
		const state = card.traceState;
		const path = displayPath(argPath(state.args));
		if (path !== undefined) paths.push(path);
		const stat = changeStat(state.name, state.args, state.details);
		added += stat.added;
		removed += stat.removed;
	}
	const uniquePaths = unique(paths);
	const stat = statText(added, removed, cards.length === 1);
	if (cards.length === 1) return { text: `Edit ${uniquePaths[0] ?? "file"}`, stat };
	if (uniquePaths.length === 1) return { text: `Edited ${uniquePaths[0]}`, stat };
	const count = uniquePaths.length > 0 ? uniquePaths.length : cards.length;
	return { text: `Edited ${countPhrase(count, "file", "files")}`, stat };
}

function commandLabel(cards: readonly ToolExecutionComponent[]): string {
	if (cards.length === 1) {
		const command = stringArg(cards[0]?.traceState.args, "command");
		return `Ran ${command ?? "command"}`;
	}
	return `Ran ${cards.length} commands`;
}

function traceRow(pad: number, text: string, stat = ""): string {
	return `${" ".repeat(pad)}${theme.fg("dim", "◆ ")}${theme.fg("toolTitle", text)}${stat}`;
}

function statText(added: number, removed: number, slash: boolean): string {
	const plus = added > 0 ? theme.fg("toolDiffAdded", `+${added}`) : "";
	const minus = removed > 0 ? theme.fg("toolDiffRemoved", `-${removed}`) : "";
	if (plus.length > 0 && minus.length > 0) return slash ? ` ${plus}/${minus}` : ` ${plus} ${minus}`;
	if (plus.length > 0) return ` ${plus}`;
	if (minus.length > 0) return ` ${minus}`;
	return "";
}

interface SearchFact {
	readonly pattern: string;
	readonly path: string | undefined;
	readonly matches: number;
	readonly files: number;
}

function searchFact(state: ToolExecutionComponent["traceState"]): SearchFact {
	const pattern = stringArg(state.args, "pattern") ?? "";
	const path = displayPath(argPath(state.args));
	const lines = state.output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !/^no matches\b/i.test(line));
	if (lines.length === 0) return { pattern, path, matches: 0, files: 0 };
	const files = new Set<string>();
	for (const line of lines) {
		const match = /^(.+):\d+:/.exec(line);
		if (match?.[1] !== undefined) files.add(match[1]);
	}
	return { pattern, path, matches: lines.length, files: files.size > 0 ? files.size : lines.length };
}

function searchLabel(fact: SearchFact): string {
	const where = fact.path !== undefined ? ` in ${fact.path}` : "";
	const count =
		fact.matches === 0
			? "no matches"
			: `${fact.matches} ${fact.matches === 1 ? "match" : "matches"} in ${countPhrase(fact.files, "file", "files")}`;
	return `Search "${fact.pattern}"${where} (${count})`;
}

function countPhrase(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function stringArg(args: unknown, key: string): string | undefined {
	if (args === null || typeof args !== "object" || !(key in args)) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function displayPath(path: string | undefined): string | undefined {
	if (path === undefined) return undefined;
	if (!path.startsWith("/") && !/^[A-Za-z]:\\/.test(path)) return path;
	const parts = path.split(/[/\\]/);
	return parts[parts.length - 1] || path;
}

function argPath(args: unknown): string | undefined {
	if (args === null || typeof args !== "object") return undefined;
	const record = args as { path?: unknown; file_path?: unknown };
	const path = record.path ?? record.file_path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

function changeStat(name: string, args: unknown, details: unknown): { added: number; removed: number } {
	if (details !== null && typeof details === "object" && "diff" in details) {
		const diff = (details as { diff?: unknown }).diff;
		if (typeof diff === "string") return countDiffLines(diff);
	}
	if (name === "write" && args !== null && typeof args === "object" && "content" in args) {
		const content = (args as { content?: unknown }).content;
		if (typeof content === "string" && content.length > 0) {
			const lines = content.split("\n");
			while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
			return { added: lines.length, removed: 0 };
		}
	}
	return { added: 0, removed: 0 };
}
