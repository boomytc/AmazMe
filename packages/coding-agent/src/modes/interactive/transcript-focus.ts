import { matchesKey } from "@amazme/tui";
import { matchesAppBinding } from "../../core/keybindings.ts";
import { type TranscriptRow, TranscriptModel } from "./transcript-model.ts";

export interface TranscriptFocusOptions {
	/** Names the child agent the selection rests on, so the work surface can highlight it. */
	onHighlight?(childId: string | undefined): void;
	/** Receives the selected row's copyable text for the configured copy binding. */
	onCopy?(text: string): void;
	/** Receives the selected row's chat-container position so the caller can scroll it into view. */
	onRowSelected?(childIndex: number): void;
	/** Opens the selected row's text in the caller's viewer when the row has no open action. */
	onViewText?(text: string): void;
	/** Vim-style single-letter navigation; off by default. */
	vimMode?: () => boolean;
	/** Receives the whole selected row, for surfaces that highlight rows they render themselves. */
	onHighlightRow?(row: TranscriptRow | undefined): void;
}

/**
 * Keyboard navigation for the conversation transcript.
 *
 * Rows come from {@link TranscriptModel}; this class only maps input to navigation and
 * fold actions. Tab moves between the prompt and the transcript, arrows select rows,
 * left and right fold, and the prompt/next-prompt bindings jump between turns.
 */
export class TranscriptFocus {
	focus: "prompt" | "scrollback" = "prompt";
	private readonly model = new TranscriptModel();
	private readonly scrollBy: (lines: number) => void;
	private readonly rows: () => readonly TranscriptRow[];
	private readonly pageSize: number;
	private readonly options: TranscriptFocusOptions;
	private allExpanded = false;
	private selectedRow: TranscriptRow | undefined;
	private searchQueryValue: string | undefined;

	constructor(
		scrollBy: (lines: number) => void,
		rows: () => readonly TranscriptRow[],
		pageSize = 10,
		options: TranscriptFocusOptions = {},
	) {
		this.scrollBy = scrollBy;
		this.rows = rows;
		this.pageSize = pageSize;
		this.options = options;
	}

	/** Index of the selected row, kept for callers that only need the position. */
	get selected(): number {
		return this.model.selectedIndex;
	}

	/** True while a query from {@link search} can still be cycled. */
	get hasSearch(): boolean {
		return this.searchQueryValue !== undefined;
	}

	/**
	 * Selects the first row matching `query` (case-insensitive, label and copyable text).
	 * Returns the one-based match number and the total, so a caller can show progress.
	 */
	search(query: string): { index: number; total: number } {
		this.focus = "scrollback";
		this.sync();
		this.searchQueryValue = query;
		const matches = this.model.search(query);
		const first = matches[0];
		if (first !== undefined) {
			this.model.select(first);
			this.applySelection();
			this.reveal();
		}
		return { index: matches.length === 0 ? 0 : 1, total: matches.length };
	}

	/** Cycles through the current query's matches, recomputed against the current rows. */
	searchNext(delta: number): boolean {
		const query = this.searchQueryValue;
		if (query === undefined) return false;
		this.sync();
		const matches = this.model.search(query);
		if (matches.length === 0) return false;
		const current = matches.indexOf(this.model.selectedIndex);
		const next = current === -1 ? (delta > 0 ? 0 : matches.length - 1) : (current + delta + matches.length) % matches.length;
		const row = matches[next];
		if (row === undefined) return false;
		this.model.select(row);
		this.applySelection();
		this.reveal();
		return true;
	}

	clearSearch(): void {
		this.searchQueryValue = undefined;
	}

	pinnedChildIndexes(): number[] {
		this.sync();
		return this.model.pinnedChildIndexes();
	}

	/** One-based match position for the active query, recomputed against the current rows. */
	searchProgress(): { query: string; index: number; total: number } | undefined {
		const query = this.searchQueryValue;
		if (query === undefined) return undefined;
		this.sync();
		const matches = this.model.search(query);
		const position = matches.indexOf(this.model.selectedIndex);
		return { query, index: position === -1 ? 0 : position + 1, total: matches.length };
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, "tab")) {
			this.focus = this.focus === "prompt" ? "scrollback" : "prompt";
			if (this.focus === "scrollback") {
				this.sync();
				this.applySelection();
				this.reveal();
				this.highlight();
			} else {
				this.applySelection();
			}
			return true;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			this.scrollBy((matchesKey(data, "pageUp") ? -1 : 1) * this.pageSize);
			return true;
		}
		if (this.focus !== "scrollback") return false;
		this.sync();

		if (matchesKey(data, "escape")) {
			this.focus = "prompt";
			this.applySelection();
			return true;
		}

		if (matchesAppBinding(data, "tui.altScreen.nextPrompt")) return this.jumpTurn(1);
		if (matchesAppBinding(data, "tui.altScreen.previousPrompt")) return this.jumpTurn(-1);
		if (matchesAppBinding(data, "app.transcript.searchNext")) return this.searchNext(1);
		if (matchesAppBinding(data, "app.transcript.searchPrevious")) return this.searchNext(-1);
		if (matchesAppBinding(data, "app.transcript.toggleAll")) {
			this.allExpanded = !this.allExpanded;
			this.model.expandAll(this.allExpanded);
			return true;
		}
		if (matchesAppBinding(data, "app.transcript.copyMeta")) {
			const meta = this.model.selected?.meta?.();
			if (meta === undefined || this.options.onCopy === undefined) return false;
			this.options.onCopy(meta);
			return true;
		}
		if (matchesAppBinding(data, "app.message.copy")) {
			const text = this.model.selectedText();
			if (text === undefined || this.options.onCopy === undefined) return false;
			this.options.onCopy(text);
			return true;
		}
		if (this.vimNavigation(data)) return true;
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.model.move(matchesKey(data, "up") ? -1 : 1);
			this.applySelection();
			this.reveal();
			this.highlight();
			return true;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			this.model.setSelectedExpanded(matchesKey(data, "right"));
			return true;
		}
		if (matchesKey(data, "enter")) {
			if (this.model.openSelected()) return true;
			const text = this.model.selectedText();
			if (text !== undefined && this.options.onViewText !== undefined) {
				this.options.onViewText(text);
			}
			return true;
		}
		return false;
	}

	private sync(): void {
		this.model.setRows(this.rows());
		if (this.selectedRow === undefined) return;
		// A component can leave the conversation (compaction, session switch) while selected.
		if (!this.model.rows.some((row) => row.id === this.selectedRow?.id)) {
			this.selectedRow.setSelected?.(false);
			this.selectedRow = undefined;
		}
	}

	private highlight(): void {
		const row = this.model.selected;
		this.options.onHighlight?.(row?.childId);
		this.options.onHighlightRow?.(row);
	}

	/** Keep exactly one row marked, and only while the transcript owns the keyboard. */
	/** j/k, H/L, g/G, e, and y in scrollback focus when vim mode is on. */
	private vimNavigation(data: string): boolean {
		if (this.options.vimMode?.() !== true) return false;
		if (matchesKey(data, "j") || matchesKey(data, "k")) {
			this.model.move(matchesKey(data, "j") ? 1 : -1);
			this.applySelection();
			this.reveal();
			this.highlight();
			return true;
		}
		if (matchesKey(data, "shift+h")) return this.jumpTurn(-1);
		if (matchesKey(data, "shift+l")) return this.jumpTurn(1);
		if (matchesKey(data, "g") || matchesKey(data, "shift+g")) {
			const last = this.model.rows.length - 1;
			if (last < 0) return false;
			this.model.select(matchesKey(data, "g") ? 0 : last);
			this.applySelection();
			this.reveal();
			this.highlight();
			return true;
		}
		if (matchesKey(data, "e")) {
			this.model.toggleSelected();
			return true;
		}
		if (matchesKey(data, "y")) {
			const text = this.model.selectedText();
			if (text === undefined || this.options.onCopy === undefined) return false;
			this.options.onCopy(text);
			return true;
		}
		return false;
	}

	/** Ask the owner to scroll the selected row into view. */
	private reveal(): void {
		const childIndex = this.model.selected?.childIndex;
		if (childIndex !== undefined) this.options.onRowSelected?.(childIndex);
	}

	private applySelection(): void {
		const next = this.focus === "scrollback" ? this.model.selected : undefined;
		if (next?.id === this.selectedRow?.id) return;
		this.selectedRow?.setSelected?.(false);
		this.selectedRow = next;
		next?.setSelected?.(true);
	}

	private jumpTurn(delta: number): boolean {
		this.model.moveTurn(delta);
		this.applySelection();
		this.reveal();
		this.highlight();
		return true;
	}
}
