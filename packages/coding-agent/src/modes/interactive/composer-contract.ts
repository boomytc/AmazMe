import { formatKeyText } from "../../core/keybinding-labels.ts";

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

/**
 * Chord that cancels a running turn. Every surface that advertises the cancel
 * action spells it through this helper.
 */
export function turnCancelKey(): string {
	return formatKeyText("ctrl+c", { capitalize: true });
}

/** Compact prompt hints for non-obvious entry points and state-specific actions. */
export function promptShortcutLine(
	state: ComposerState & { terminalClass: TerminalClass; autocompleteOpen: boolean },
): string {
	const trimmed = state.draft.trim();
	const top = state.queue[0]?.replace(/\s+/g, " ").trim();
	const chip = (key: string, action: string) => `\x1b[1m${formatKeyText(key, { capitalize: true })}\x1b[22m:${action}`;
	const parts: string[] = [];
	const enter = decideComposerAction(state, "enter");
	if (enter.type === "insert-newline") parts.push(chip("Enter", "newline"));
	else if (enter.type === "queue") parts.push(chip("Enter", "queue"));
	else if (enter.type === "send-queued") parts.push(chip("Enter", "send"));
	if (state.multiline && trimmed.length > 0) parts.push(chip("Shift+Enter/Alt+Enter", "send"));
	if (state.turnRunning && (trimmed.length > 0 || top !== undefined)) {
		const sendNow =
			state.terminalClass === "apple-terminal" ? "Ctrl+O" : state.terminalClass === "vscode" ? "Ctrl+L" : "Ctrl+Enter";
		parts.push(chip(sendNow, "now"));
	}
	if (state.autocompleteOpen) parts.push(chip("Tab", "complete"));
	if (trimmed.length === 0 && state.turnRunning) parts.push(chip(turnCancelKey(), "cancel"));
	if (top !== undefined) {
		const extra = state.queue.length > 1 ? ` +${state.queue.length - 1}` : "";
		parts.push(`Queued: ${top}${extra}`);
	}
	return parts.join(" │ ");
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
