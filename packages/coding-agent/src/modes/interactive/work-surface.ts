import { matchesKey, type Component, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth } from "@amazme/tui";
import { childFrameLines, childLifecycleLine, type ChildAgentBook } from "../../core/child-session.ts";
import { type ForegroundCommands, type ForegroundTask } from "../../core/foreground-commands.ts";

const OPEN_BADGE = "[open]";
const CLOSE_BADGE = "[close]";

export interface WorkSurfaceActions {
	openProcess(id: string): void;
	closeProcess(id: string): void;
}

interface ProcessHit {
	id: string;
	line: number;
	openStart: number;
	openEnd: number;
	closeStart: number;
	closeEnd: number;
}

/** Live sticky row for a command that is still in the foreground. */
function commandLines(task: ForegroundTask): string[] {
	const lines = [`Command running: ${task.command}`];
	const output = task.output.trimEnd();
	if (output) lines.push(output);
	return lines;
}

/** One row for a background process. The output stays behind [open]. */
function backgroundRow(task: ForegroundTask, width: number): Omit<ProcessHit, "id" | "line"> & { body: string } {
	const tail = `${OPEN_BADGE} ${CLOSE_BADGE}`;
	const tailWidth = visibleWidth(tail);
	const room = Math.max(1, width - tailWidth - 1);
	const left = truncateToWidth(task.command, room, "…");
	const gap = Math.max(1, width - visibleWidth(left) - tailWidth);
	const openStart = visibleWidth(left) + gap;
	const closeStart = openStart + visibleWidth(OPEN_BADGE) + 1;
	return {
		body: `${left}${" ".repeat(gap)}${tail}`,
		openStart,
		openEnd: openStart + visibleWidth(OPEN_BADGE),
		closeStart,
		closeEnd: closeStart + visibleWidth(CLOSE_BADGE),
	};
}

/**
 * Scrollback rows for child agents and background commands, plus the tasks list.
 * Opening a child replaces those rows with the child's transcript.
 */
export class WorkSurface implements Component {
	readonly book: ChildAgentBook;
	private readonly commands: ForegroundCommands;
	private readonly actions: WorkSurfaceActions | undefined;
	private processHits: ProcessHit[] = [];

	constructor(book: ChildAgentBook, commands: ForegroundCommands, actions?: WorkSurfaceActions) {
		this.book = book;
		this.commands = commands;
		this.actions = actions;
	}

	get composerHidden(): boolean {
		return this.book.openId !== undefined;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const hits: ProcessHit[] = [];
		const push = (text: string): void => {
			for (const part of text.split("\n")) {
				lines.push(part.length > width ? part.slice(0, width) : part);
			}
		};
		const open = this.book.records.find((record) => record.id === this.book.openId);
		if (open) {
			for (const line of childFrameLines(open)) push(line);
		} else {
			for (const record of this.book.records) {
				const marker = record.id === this.book.highlightId ? "> " : "";
				push(`${marker}${childLifecycleLine(record)}`);
			}
			for (const task of this.commands.list()) {
				if (task.status !== "running") continue;
				if (task.detached) {
					const row = backgroundRow(task, width);
					hits.push({
						id: task.id,
						line: lines.length,
						openStart: row.openStart,
						openEnd: row.openEnd,
						closeStart: row.closeStart,
						closeEnd: row.closeEnd,
					});
					push(row.body);
				} else {
					for (const line of commandLines(task)) push(line);
				}
			}
		}
		if (this.book.tasksOpen) {
			push("Tasks");
			for (const record of this.book.records) {
				const marker = record.id === this.book.highlightId ? ">" : " ";
				push(`${marker} subagent ${record.status} ${record.description}`);
			}
			for (const task of this.commands.list()) push(`  command ${task.status} ${task.command}`);
		}
		this.processHits = hits;
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const hit = this.processHits.find((item) => item.line === event.y);
		if (!hit || !this.actions) return undefined;
		if (event.x >= hit.closeStart && event.x < hit.closeEnd) {
			this.actions.closeProcess(hit.id);
			return { handled: true };
		}
		if (event.x >= hit.openStart && event.x < hit.openEnd) {
			this.actions.openProcess(hit.id);
			return { handled: true };
		}
		return undefined;
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, "ctrl+g")) {
			this.book.tasksOpen = !this.book.tasksOpen;
			this.book.touch();
			return true;
		}
		if (!this.book.openId) return false;
		if (matchesKey(data, "ctrl+c")) {
			this.book.records.find((record) => record.id === this.book.openId)?.cancel();
			return true;
		}
		if (matchesKey(data, "escape") || data === "q") {
			this.book.close();
			return true;
		}
		return true;
	}
}

type ChatList = {
	children: Component[];
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
};

/**
 * The parent scrollback. The chat container is only a projection:
 * the child frame alone while a child is open, otherwise the entries plus that frame.
 */
export class ParentTranscript {
	private entries: Component[] = [];
	private surface: WorkSurface | undefined;
	private overlay: Component | undefined;
	private container: ChatList | undefined;
	private rawAdd: ((component: Component) => void) | undefined;
	private rawRemove: ((component: Component) => void) | undefined;
	private rawClear: (() => void) | undefined;

	bind(container: ChatList, surface: WorkSurface): void {
		this.container = container;
		this.surface = surface;
		this.rawAdd = container.addChild.bind(container);
		this.rawRemove = container.removeChild.bind(container);
		this.rawClear = container.clear.bind(container);
		this.entries = container.children.filter((child) => child !== surface);
		container.addChild = (component) => {
			if (component === surface) {
				this.project();
				return;
			}
			this.append(component);
		};
		container.removeChild = (component) => {
			this.remove(component);
		};
		container.clear = () => {
			this.replaceAll([]);
		};
		this.project();
	}

	append(component: Component): void {
		if (component === this.surface) return;
		if (!this.entries.includes(component)) this.entries.push(component);
		this.project();
	}

	remove(component: Component): void {
		const next = this.entries.filter((entry) => entry !== component);
		if (next.length === this.entries.length) {
			this.rawRemove?.(component);
			return;
		}
		this.entries = next;
		this.project();
	}

	replaceAll(entries: readonly Component[]): void {
		this.entries = entries.filter((entry) => entry !== this.surface);
		this.project();
	}

	isBound(): boolean {
		return this.rawAdd !== undefined;
	}

	/** Insert a row ahead of one already in the transcript, then project. */
	insertBefore(component: Component, before: Component): boolean {
		if (component === this.surface) return false;
		const index = this.entries.indexOf(before);
		if (index < 0) return false;
		if (!this.entries.includes(component)) this.entries.splice(index, 0, component);
		this.project();
		return true;
	}

	contains(component: Component): boolean {
		return this.entries.includes(component);
	}

	list(): readonly Component[] {
		return this.entries;
	}

	/** Cover the transcript with one component, or clear that cover. Entries stay put. */
	setOverlay(component: Component | undefined): void {
		this.overlay = component;
		this.project();
	}

	/** Show the frame alone, or the parent entries and then the frame. */
	project(): void {
		const surface = this.surface;
		const rawClear = this.rawClear;
		const rawAdd = this.rawAdd;
		if (!surface || !rawClear || !rawAdd) return;
		rawClear();
		const overlay = this.overlay;
		if (overlay) {
			rawAdd(overlay);
			return;
		}
		if (!surface.composerHidden) {
			for (const entry of this.entries) rawAdd(entry);
		}
		rawAdd(surface);
	}
}

/**
 * Blocks created by `handleBashCommand`. The oldest unsettled block for a command
 * owns that completion. If `replaceAll` already removed it, the caller appends a
 * new row and a later block of the same command is left alone.
 */
export class BashRunTable {
	private readonly runs: Array<{ component: BashBlock; settled: boolean }> = [];

	mount(component: BashBlock): void {
		this.runs.push({ component, settled: false });
	}

	settle(
		message: { command: string; output: string; exitCode: number | undefined },
		mounted: (component: object) => boolean,
	): "shown" | "append" {
		for (const entry of this.runs) {
			if (entry.settled || entry.component.getCommand() !== message.command) continue;
			entry.settled = true;
			if (!mounted(entry.component)) return "append";
			if (entry.component.isBackgrounded()) entry.component.finishBackground(message.output, message.exitCode);
			return "shown";
		}
		return "append";
	}
}

interface BashBlock {
	getCommand(): string;
	isBackgrounded(): boolean;
	finishBackground(output: string, exitCode: number | undefined): void;
}

/** Finish the live background block when the transcript still holds it. Returns false when a new row is required. */
export function finishAttachedBackgroundBash(
	live: { getCommand(): string; isBackgrounded(): boolean; finishBackground(output: string, exitCode: number | undefined): void } | undefined,
	hosts: Array<{ contains?(component: object): boolean; children?: readonly object[] }>,
	message: { command: string; output: string; exitCode: number | undefined },
): boolean {
	if (!live || !live.isBackgrounded() || live.getCommand() !== message.command) return false;
	const attached = hosts.some((host) => host.contains?.(live) || host.children?.includes(live));
	if (!attached) return false;
	live.finishBackground(message.output, message.exitCode);
	return true;
}

export function syncComposerVisibility(
	container: { clear(): void; addChild(component: Component): void; children: readonly Component[] },
	editor: Component & { hidden: boolean },
	hidden: boolean,
): void {
	editor.hidden = hidden;
	const present = container.children.includes(editor);
	if (hidden && present) container.clear();
	else if (!hidden && !present) container.addChild(editor);
}
