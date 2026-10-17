import { matchesKey } from "@amazme/tui";
import { matchesAppBinding } from "../../core/keybindings.ts";
import { type TranscriptRow, TranscriptModel } from "./transcript-model.ts";

export interface TranscriptFocusOptions {
	/** Names the child agent the selection rests on, so the work surface can highlight it. */
	onHighlight?(childId: string | undefined): void;
	/** Receives the selected row's copyable text for the configured copy binding. */
	onCopy?(text: string): void;
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

	handleInput(data: string): boolean {
		if (matchesKey(data, "tab")) {
			this.focus = this.focus === "prompt" ? "scrollback" : "prompt";
			if (this.focus === "scrollback") {
				this.sync();
				this.highlight();
			}
			return true;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			this.scrollBy((matchesKey(data, "pageUp") ? -1 : 1) * this.pageSize);
			return true;
		}
		if (this.focus !== "scrollback") return false;
		this.sync();

		if (matchesAppBinding(data, "tui.altScreen.nextPrompt")) return this.jumpTurn(1);
		if (matchesAppBinding(data, "tui.altScreen.previousPrompt")) return this.jumpTurn(-1);
		if (matchesAppBinding(data, "app.transcript.toggleAll")) {
			this.allExpanded = !this.allExpanded;
			this.model.expandAll(this.allExpanded);
			return true;
		}
		if (matchesAppBinding(data, "app.message.copy")) {
			const text = this.model.selectedText();
			if (text === undefined || this.options.onCopy === undefined) return false;
			this.options.onCopy(text);
			return true;
		}
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.model.move(matchesKey(data, "up") ? -1 : 1);
			this.highlight();
			return true;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			this.model.setSelectedExpanded(matchesKey(data, "right"));
			return true;
		}
		if (matchesKey(data, "enter")) {
			this.model.openSelected();
			return true;
		}
		return false;
	}

	private sync(): void {
		this.model.setRows(this.rows());
	}

	private highlight(): void {
		this.options.onHighlight?.(this.model.selected?.childId);
	}

	private jumpTurn(delta: number): boolean {
		this.model.moveTurn(delta);
		this.highlight();
		return true;
	}
}
