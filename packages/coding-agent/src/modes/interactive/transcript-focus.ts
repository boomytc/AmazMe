import { matchesKey } from "@amazme/tui";

/** A scrollback row that can fold, or a child-agent row that can open. */
export interface ScrollbackRow {
	setExpanded?(expanded: boolean): void;
	open?(): void;
	childId?: string;
}

/**
 * Build the rows Tab lands on: expandable chat entries, then each child agent.
 * Status lines and the work surface itself are not rows.
 */
export function scrollbackRows(
	children: readonly object[],
	records: readonly { id: string }[],
	openChild: (id: string) => void,
): ScrollbackRow[] {
	const rows: ScrollbackRow[] = [];
	for (const child of children) {
		const expandable = child as { setExpanded?: (expanded: boolean) => void };
		if (typeof expandable.setExpanded === "function") rows.push(expandable);
	}
	for (const record of records) {
		rows.push({
			childId: record.id,
			open: () => openChild(record.id),
		});
	}
	return rows;
}

/**
 * Tab moves between the prompt and the scrollback. Page keys scroll the transcript
 * and do not reach the editor. Up and down move the selection onto a real row.
 * Left and right fold that row. Enter opens a child-agent row.
 */
export class TranscriptFocus {
	focus: "prompt" | "scrollback" = "prompt";
	selected = 0;
	private readonly scrollBy: (lines: number) => void;
	private readonly rows: () => readonly ScrollbackRow[];
	private readonly pageSize: number;
	private readonly onHighlight: ((childId: string | undefined) => void) | undefined;

	constructor(
		scrollBy: (lines: number) => void,
		rows: () => readonly ScrollbackRow[],
		pageSize = 10,
		onHighlight?: (childId: string | undefined) => void,
	) {
		this.scrollBy = scrollBy;
		this.rows = rows;
		this.pageSize = pageSize;
		this.onHighlight = onHighlight;
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, "tab")) {
			this.focus = this.focus === "prompt" ? "scrollback" : "prompt";
			if (this.focus === "scrollback") this.move(0);
			return true;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			this.scrollBy((matchesKey(data, "pageUp") ? -1 : 1) * this.pageSize);
			return true;
		}
		if (this.focus !== "scrollback") return false;
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.move(matchesKey(data, "up") ? -1 : 1);
			return true;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			this.currentRow()?.setExpanded?.(matchesKey(data, "right"));
			return true;
		}
		if (matchesKey(data, "enter")) {
			this.currentRow()?.open?.();
			return true;
		}
		return false;
	}

	private currentRow(): ScrollbackRow | undefined {
		const rows = this.rows();
		const indexes = rows
			.map((row, index) => (row.open || row.setExpanded ? index : -1))
			.filter((index) => index >= 0);
		if (indexes.length === 0) return undefined;
		if (!indexes.includes(this.selected)) this.selected = indexes[0] ?? 0;
		return rows[this.selected];
	}

	private move(delta: number): void {
		const rows = this.rows();
		const indexes = rows
			.map((row, index) => (row.open || row.setExpanded ? index : -1))
			.filter((index) => index >= 0);
		if (indexes.length === 0) return;
		const current = indexes.indexOf(this.selected);
		const start = current === -1 ? 0 : current;
		const next = indexes[Math.max(0, Math.min(indexes.length - 1, start + delta))] ?? indexes[0];
		this.selected = next ?? 0;
		this.onHighlight?.(rows[this.selected]?.childId);
	}
}
