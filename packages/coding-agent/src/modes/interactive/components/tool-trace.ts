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
				if (segment.summary) {
					if (event.type !== "click" || event.button !== "left") return undefined;
					for (const card of segment.cards) card.setExpanded(true);
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
		if (group.length >= 2 && group.every((card) => !card.transcriptRowExpanded())) {
			segments.push({ lines: [summaryLine(kind, group)], cards: group, summary: true });
		} else {
			for (const card of group) segments.push(cardSegment(card, width));
		}
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
	if (kind === "explore") return exploreSummary(cards, pad);
	if (kind === "edit") return editSummary(cards, pad);
	const count = cards.length;
	return styledSummary(`Ran ${count} command${count === 1 ? "" : "s"}`, pad);
}

function exploreSummary(cards: readonly ToolExecutionComponent[], pad: number): string {
	let files = 0;
	let searches = 0;
	for (const card of cards) {
		if (card.traceState.name === "read") files += 1;
		else searches += 1;
	}
	const parts: string[] = [];
	if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
	if (searches > 0) parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
	return styledSummary(`Explored ${parts.join(", ")}`, pad);
}

function editSummary(cards: readonly ToolExecutionComponent[], pad: number): string {
	const paths = new Set<string>();
	let added = 0;
	let removed = 0;
	for (const card of cards) {
		const state = card.traceState;
		const path = argPath(state.args);
		if (path !== undefined) paths.add(path);
		const stat = changeStat(state.name, state.args, state.details);
		added += stat.added;
		removed += stat.removed;
	}
	const count = paths.size > 0 ? paths.size : cards.length;
	return styledSummary(`Edited ${count} file${count === 1 ? "" : "s"} +${added} -${removed}`, pad);
}

function styledSummary(text: string, pad: number): string {
	return " ".repeat(pad) + theme.fg("toolTitle", theme.bold(text));
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
