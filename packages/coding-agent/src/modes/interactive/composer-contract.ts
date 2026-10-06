import { matchesKey } from "@amazme/tui";
import { foregroundCommands } from "../../core/foreground-commands.ts";

export type TerminalClass = "default" | "apple-terminal" | "vscode";

export type ComposerKey = "enter" | "shift+enter" | "alt+enter" | "ctrl+c" | "escape" | "send-now" | "background";

export interface ComposerState {
	draft: string;
	queue: readonly string[];
	turnRunning: boolean;
	multiline: boolean;
}

export type ComposerDecision =
	| { type: "send"; text: string }
	| { type: "queue"; text: string }
	| { type: "send-queued"; text: string }
	| { type: "cancel-and-send"; text: string }
	| { type: "insert-newline" }
	| { type: "clear-draft" }
	| { type: "cancel-turn" }
	| { type: "esc-hint" }
	| { type: "background" }
	| { type: "noop" };

export interface ComposerEditor {
	getText(): string;
	setText(text: string): void;
	insertTextAtCursor(text: string): void;
}

/** Side effects the session performs after a composer decision. */
export interface ComposerEffects {
	isTurnRunning(): boolean;
	send(text: string): void;
	queue(text: string): void;
	sendQueued(text: string): void;
	cancelAndSend(text: string): void;
	cancelTurn(): void;
	showEscHint(): void;
}

const VS_CODE_TERMINALS = new Set(["vscode", "cursor", "windsurf", "zed"]);

export function detectTerminalClass(env: NodeJS.ProcessEnv = process.env): TerminalClass {
	const program = env.TERM_PROGRAM ?? "";
	if (program === "Apple_Terminal") return "apple-terminal";
	if (VS_CODE_TERMINALS.has(program)) return "vscode";
	return "default";
}

/** The footer line that says what Enter will do, plus any visible queued rows. */
export function composerFooterLine(state: Pick<ComposerState, "turnRunning" | "multiline" | "queue">): string {
	const enter = state.multiline ? "Enter: newline" : state.turnRunning ? "Enter: queue" : "Enter: send";
	const alternate = state.multiline ? "Shift+Enter or Alt+Enter: send" : "Newline: Shift+Enter or Alt+Enter";
	const queued = state.queue.length > 0 ? `Queued: ${state.queue.join(" | ")}` : "";
	return [enter, alternate, queued].filter((part) => part.length > 0).join("  ");
}

/**
 * Composer key contract. Idle Enter sends. Mid-turn Enter queues, and Enter on an
 * empty composer sends the top queued row. The terminal's send-now chord cancels
 * the turn and sends. Esc never cancels.
 */
export function decideComposerAction(state: ComposerState, key: ComposerKey): ComposerDecision {
	const trimmed = state.draft.trim();
	const top = state.queue[0];
	if (key === "escape") return state.turnRunning ? { type: "esc-hint" } : { type: "noop" };
	if (key === "ctrl+c") {
		if (trimmed.length > 0) return { type: "clear-draft" };
		if (state.turnRunning) return { type: "cancel-turn" };
		return { type: "noop" };
	}
	if (key === "background") return { type: "background" };
	if (key === "send-now") {
		if (!state.turnRunning) return { type: "noop" };
		if (trimmed.length > 0) return { type: "cancel-and-send", text: trimmed };
		if (top !== undefined) return { type: "cancel-and-send", text: top };
		return { type: "noop" };
	}
	const newlineKey = key === "shift+enter" || key === "alt+enter";
	if (state.multiline) {
		if (key === "enter") {
			if (trimmed.length === 0 && state.turnRunning && top !== undefined) return { type: "send-queued", text: top };
			return { type: "insert-newline" };
		}
		if (newlineKey) {
			if (trimmed.length === 0) return { type: "noop" };
			return { type: "send", text: trimmed };
		}
		return { type: "noop" };
	}
	if (newlineKey) return { type: "insert-newline" };
	if (key === "enter") {
		if (trimmed.length === 0 && state.turnRunning && top !== undefined) return { type: "send-queued", text: top };
		if (trimmed.length === 0) return { type: "noop" };
		if (state.turnRunning) return { type: "queue", text: trimmed };
		return { type: "send", text: trimmed };
	}
	return { type: "noop" };
}

function classifyComposerKey(data: string, terminalClass: TerminalClass): ComposerKey | undefined {
	if (matchesKey(data, "escape")) return "escape";
	if (matchesKey(data, "ctrl+c")) return "ctrl+c";
	if (matchesKey(data, "ctrl+b")) return "background";
	if (terminalClass === "apple-terminal" && matchesKey(data, "ctrl+o")) return "send-now";
	if (terminalClass === "vscode" && matchesKey(data, "ctrl+l")) return "send-now";
	if (terminalClass === "default" && matchesKey(data, "ctrl+enter")) return "send-now";
	if (matchesKey(data, "shift+enter")) return "shift+enter";
	if (matchesKey(data, "alt+enter")) return "alt+enter";
	if (matchesKey(data, "enter")) return "enter";
	return undefined;
}

/**
 * Input handler the interactive editor calls before its own key table.
 * The queue lives here so the footer and the turn-end flush see the same rows.
 */
export class InteractiveComposer {
	multiline = false;
	terminalClass: TerminalClass;
	readonly queue: string[] = [];
	private readonly editor: ComposerEditor;
	private readonly effects: ComposerEffects;

	constructor(editor: ComposerEditor, effects: ComposerEffects, terminalClass: TerminalClass = detectTerminalClass()) {
		this.editor = editor;
		this.effects = effects;
		this.terminalClass = terminalClass;
	}

	footerText(): string {
		return composerFooterLine({
			turnRunning: this.effects.isTurnRunning(),
			multiline: this.multiline,
			queue: this.queue,
		});
	}

	/** Send the oldest queued row after the current turn ends. Returns false when nothing is queued. */
	deliverAfterTurn(send: (text: string) => void): boolean {
		const next = this.queue.shift();
		if (next === undefined) return false;
		send(next);
		return true;
	}

	handleInput(data: string): boolean {
		const key = classifyComposerKey(data, this.terminalClass);
		if (!key) return false;
		const decision = decideComposerAction(
			{
				draft: this.editor.getText(),
				queue: this.queue,
				turnRunning: this.effects.isTurnRunning(),
				multiline: this.multiline,
			},
			key,
		);
		if (this.apply(decision)) return true;
		// Send-now and the newline chords are the composer's. A no-op must not fall through into submit or a newline.
		return key === "send-now" || key === "shift+enter" || key === "alt+enter";
	}

	private apply(decision: ComposerDecision): boolean {
		switch (decision.type) {
			case "noop":
				return false;
			case "insert-newline":
				this.editor.insertTextAtCursor("\n");
				return true;
			case "clear-draft":
				this.editor.setText("");
				return true;
			case "esc-hint":
				this.effects.showEscHint();
				return true;
			case "cancel-turn":
				this.effects.cancelTurn();
				return true;
			case "background":
				foregroundCommands.backgroundCurrent();
				return true;
			case "queue":
				this.queue.push(decision.text);
				this.editor.setText("");
				this.effects.queue(decision.text);
				return true;
			case "send":
				this.editor.setText("");
				this.effects.send(decision.text);
				return true;
			case "send-queued":
				this.queue.shift();
				this.effects.sendQueued(decision.text);
				return true;
			case "cancel-and-send": {
				const draft = this.editor.getText().trim();
				if (draft.length === 0) this.queue.shift();
				this.editor.setText("");
				this.effects.cancelAndSend(decision.text);
				return true;
			}
			default:
				return false;
		}
	}
}
