/**
 * View model for the conversation scrollback.
 *
 * Components still render themselves, but navigation state lives here: which rows can be
 * navigated, which conversation turn they belong to, and what the current selection is.
 * Keeping that separate from the components lets the transcript add turn jumps, bulk
 * fold and search without teaching every component about focus.
 *
 * This module is intentionally dependency-free so the model can be tested without a TUI.
 */

export type TranscriptRowKind = "entry" | "child-agent" | "process";

/**
 * A component opts into transcript navigation by declaring `transcriptRowId`, or by
 * keeping the older `setExpanded` / `open` capability. Components that do not opt in
 * (spacers, borders, hints) stay out of the row list.
 */
export interface TranscriptRowSource {
	/** Stable identity for the row. Without one, derivation falls back to the child index. */
	readonly transcriptRowId?: string;
	/** Short text used by search and status hints, never rendered. */
	readonly transcriptRowLabel?: string;
	/** Returns the copyable content of the row. Omit for rows that own no text. */
	readonly transcriptRowText?: () => string | undefined;
	/** Command or path that identifies the row, without the body. */
	readonly transcriptRowMeta?: () => string | undefined;
	/** Marks the row as the first row of a new conversation turn (user prompt). */
	readonly transcriptTurnStart?: boolean;
	setExpanded?(expanded: boolean): void;
	open?(): void;
	/** Renders the row as the one arrow keys act on. */
	setSelected?(selected: boolean): void;
	/** Current fold state, when the row can report it, so a toggle can invert it. */
	transcriptRowExpanded?: () => boolean;
}

export interface TranscriptRow {
	readonly id: string;
	readonly kind: TranscriptRowKind;
	/** 0 covers content before the first prompt; each turn start increments it. */
	readonly turnIndex: number;
	readonly turnStart: boolean;
	readonly expandable: boolean;
	readonly openable: boolean;
	/** Set on child-agent rows so the transcript can highlight the open child. */
	readonly childId?: string;
	/** Position in the chat container, for scrolling a row into view. Entry rows only. */
	readonly childIndex?: number;
	readonly label?: string;
	readonly text?: () => string | undefined;
	readonly meta?: () => string | undefined;
	readonly setExpanded?: (expanded: boolean) => void;
	readonly open?: () => void;
	readonly setSelected?: (selected: boolean) => void;
	readonly expanded?: () => boolean;
}

export interface TranscriptChildRecord {
	readonly id: string;
	/** Description shown as the row label. */
	readonly description?: string;
	/** Copyable transcript lines; the row owns no text when omitted. */
	readonly transcript?: readonly string[];
}

function isRowSource(value: object): value is TranscriptRowSource {
	const candidate = value as TranscriptRowSource;
	return (
		typeof candidate.transcriptRowId === "string" ||
		candidate.transcriptTurnStart === true ||
		typeof candidate.setExpanded === "function" ||
		typeof candidate.open === "function"
	);
}

/**
 * Build rows in paint order. Turn numbers advance on `transcriptTurnStart`, so every row
 * after a prompt belongs to that prompt's turn, including tool output and child agents.
 */
export function deriveTranscriptRows(
	children: readonly object[],
	records: readonly TranscriptChildRecord[],
	openChild: (id: string) => void,
	/** Background work that the work surface renders; appended after child agents. */
	extraSources: readonly TranscriptRowSource[] = [],
): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	let turn = 0;
	for (let index = 0; index < children.length; index++) {
		const child = children[index];
		if (child === undefined) continue;
		const source = child as TranscriptRowSource;
		const turnStart = source.transcriptTurnStart === true;
		if (turnStart) turn += 1;
		if (!isRowSource(child)) continue;
		rows.push({
			id: source.transcriptRowId ?? `entry-${index}`,
			kind: "entry",
			turnIndex: turn,
			turnStart,
			childIndex: index,
			expandable: typeof source.setExpanded === "function",
			openable: typeof source.open === "function",
			...(source.transcriptRowLabel === undefined ? {} : { label: source.transcriptRowLabel }),
			...(source.transcriptRowText === undefined ? {} : { text: source.transcriptRowText }),
			...(source.transcriptRowMeta === undefined ? {} : { meta: source.transcriptRowMeta }),
			...(source.setExpanded === undefined
				? {}
				: { setExpanded: (expanded: boolean) => source.setExpanded?.(expanded) }),
			...(source.open === undefined ? {} : { open: () => source.open?.() }),
			...(source.setSelected === undefined
				? {}
				: { setSelected: (selected: boolean) => source.setSelected?.(selected) }),
			...(source.transcriptRowExpanded === undefined
				? {}
				: { expanded: () => source.transcriptRowExpanded?.() ?? false }),
		});
	}
	for (const record of records) {
		rows.push({
			id: `child-${record.id}`,
			kind: "child-agent",
			turnIndex: turn,
			turnStart: false,
			expandable: false,
			openable: true,
			childId: record.id,
			...(record.description === undefined ? {} : { label: record.description }),
			...(record.transcript === undefined ? {} : { text: () => record.transcript?.join("\n") }),
			open: () => openChild(record.id),
		});
	}
	for (const [index, source] of extraSources.entries()) {
		rows.push({
			id: source.transcriptRowId ?? `extra-${index}`,
			kind: "process",
			turnIndex: turn,
			turnStart: false,
			expandable: typeof source.setExpanded === "function",
			openable: typeof source.open === "function",
			...(source.transcriptRowLabel === undefined ? {} : { label: source.transcriptRowLabel }),
			...(source.transcriptRowText === undefined ? {} : { text: source.transcriptRowText }),
			...(source.transcriptRowMeta === undefined ? {} : { meta: source.transcriptRowMeta }),
			...(source.open === undefined ? {} : { open: () => source.open?.() }),
		});
	}
	return rows;
}

/**
 * Navigation state over a derived row list. The model never renders and never mutates
 * components beyond the fold calls their row sources expose.
 */
export class TranscriptModel {
	private items: TranscriptRow[] = [];
	private selectedIndexValue = 0;
	private selectedIdValue: string | undefined;
	/** Rows the user folded or unfolded by hand; bulk actions leave them alone. */
	private readonly pinned = new Set<string>();

	get rows(): readonly TranscriptRow[] {
		return this.items;
	}

	get selectedIndex(): number {
		return this.selectedIndexValue;
	}

	get selected(): TranscriptRow | undefined {
		return this.items[this.selectedIndexValue];
	}

	/** Row indices that start a conversation turn, in order. */
	get turnStarts(): readonly number[] {
		return this.items.flatMap((row, index) => (row.turnStart ? [index] : []));
	}

	/**
	 * Replace the rows after a re-render of the conversation. The selection keeps its
	 * identity when that row still exists, otherwise it stays within range.
	 */
	setRows(rows: readonly TranscriptRow[]): void {
		this.items = [...rows];
		const live = new Set(this.items.map((row) => row.id));
		for (const id of this.pinned) {
			if (!live.has(id)) this.pinned.delete(id);
		}
		if (this.items.length === 0) {
			this.selectedIndexValue = 0;
			this.selectedIdValue = undefined;
			return;
		}
		const previousId = this.selectedIdValue ?? this.items[this.selectedIndexValue]?.id;
		const match = previousId === undefined ? -1 : this.items.findIndex((row) => row.id === previousId);
		this.selectedIndexValue = match >= 0 ? match : Math.min(this.selectedIndexValue, this.items.length - 1);
		this.selectedIdValue = this.items[this.selectedIndexValue]?.id;
	}

	select(index: number): TranscriptRow | undefined {
		if (this.items.length === 0) return undefined;
		const clamped = Math.max(0, Math.min(this.items.length - 1, index));
		this.selectedIndexValue = clamped;
		this.selectedIdValue = this.items[clamped]?.id;
		return this.selected;
	}

	/** Move the selection by whole rows. Returns the new row, or undefined when nothing moved. */
	move(delta: number): TranscriptRow | undefined {
		if (this.items.length === 0) return undefined;
		const next = Math.max(0, Math.min(this.items.length - 1, this.selectedIndexValue + delta));
		if (next === this.selectedIndexValue) return undefined;
		return this.select(next);
	}

	/**
	 * Jump to the next or previous turn start. From a row inside a turn, a positive delta
	 * goes to the following turn start, not the current one.
	 */
	moveTurn(delta: number): TranscriptRow | undefined {
		const starts = this.turnStarts;
		if (starts.length === 0) return undefined;
		const current = this.selectedIndexValue;
		if (delta > 0) {
			for (const index of starts) {
				if (index > current) return this.select(index);
			}
			return undefined;
		}
		for (let position = starts.length - 1; position >= 0; position--) {
			const index = starts[position];
			if (index !== undefined && index < current) return this.select(index);
		}
		return undefined;
	}

	/**
	 * Fold or unfold every expandable row. This is the bulk action, so it clears the
	 * manual pins first: a hand-folded row follows the bulk state again.
	 */
	expandAll(expanded: boolean): number {
		this.pinned.clear();
		let changed = 0;
		for (const row of this.items) {
			if (!row.expandable || row.setExpanded === undefined) continue;
			row.setExpanded(expanded);
			changed++;
		}
		return changed;
	}

	setSelectedExpanded(expanded: boolean): boolean {
		const row = this.selected;
		if (!row?.expandable || row.setExpanded === undefined) return false;
		row.setExpanded(expanded);
		this.pinned.add(row.id);
		return true;
	}

	/** Inverts the selected row's fold state, without a caller needing to know it. */
	toggleSelected(): boolean {
		const row = this.selected;
		if (!row?.expandable) return false;
		return this.setSelectedExpanded(!(row.expanded?.() ?? false));
	}

	/** Chat-container positions of hand-folded rows, for callers that apply a global default. */
	pinnedChildIndexes(): number[] {
		return this.items.flatMap((row) =>
			this.pinned.has(row.id) && row.childIndex !== undefined ? [row.childIndex] : [],
		);
	}

	openSelected(): boolean {
		const row = this.selected;
		if (!row?.openable || row.open === undefined) return false;
		row.open();
		return true;
	}

	/** Case-insensitive match over the row label and its copyable text. */
	search(query: string): number[] {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return [];
		const matches: number[] = [];
		for (let index = 0; index < this.items.length; index++) {
			const row = this.items[index];
			if (row === undefined) continue;
			const haystack = `${row.label ?? ""}\n${row.text?.() ?? ""}`.toLowerCase();
			if (haystack.includes(needle)) matches.push(index);
		}
		return matches;
	}

	selectedText(): string | undefined {
		const text = this.selected?.text?.();
		return text === undefined || text.length === 0 ? undefined : text;
	}
}
