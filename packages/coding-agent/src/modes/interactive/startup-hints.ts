/**
 * Startup key hints.
 *
 * Every entry names the key that really handles it, spelled the same way as
 * `/hotkeys` and the prompt shortcut bar. Escape closes menus and overlays;
 * cancelling a running turn is the Ctrl+C chord.
 */

import type { KeybindingsManager } from "../../core/keybindings.ts";
import { getClipboardPasteDescription } from "../../core/keybindings.ts";
import { clipboardPasteFallbackText, keyHint, keyText } from "./components/keybinding-hints.ts";
import { theme } from "./theme/theme.ts";
import { rawKeyHint } from "./components/keybinding-hints.ts";

export interface StartupHintOptions {
	keybindings: KeybindingsManager;
	/** The header prints the loaded resources as well. */
	showDetails: boolean;
}

/** Full list, shown on the expanded startup header. */
export function expandedStartupHints(options: StartupHintOptions): string {
	return [
		keyHint("app.interrupt", "to close menus"),
		keyHint("app.clear", "to clear the draft or cancel"),
		rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
		keyHint("app.exit", "to exit (empty)"),
		keyHint("app.suspend", "to suspend"),
		keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
		keyHint("app.thinking.cycle", "to cycle thinking level"),
		rawKeyHint(
			`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`,
			"to cycle models",
		),
		keyHint("app.model.select", "to select model"),
		keyHint("app.tools.expand", "to expand tools"),
		keyHint("app.tasks.toggle", "to list tasks"),
		keyHint("app.thinking.toggle", "to expand thinking"),
		keyHint("app.editor.external", "for external editor"),
		rawKeyHint("/", "for commands"),
		rawKeyHint("!", "to run bash"),
		rawKeyHint("!!", "to run bash (no context)"),
		keyHint("app.message.followUp", "to queue follow-up"),
		keyHint("app.message.dequeue", "to edit all queued messages"),
		keyHint("app.clipboard.pasteImage", `to ${getClipboardPasteDescription().toLowerCase()}`),
		rawKeyHint("drop files", "to attach"),
		clipboardPasteFallbackText(options.keybindings),
	]
		.filter(Boolean)
		.join("\n");
}

/** One muted line, shown on the compact startup header. */
export function compactStartupHints(options: StartupHintOptions): string {
	return [
		keyHint("app.interrupt", "close menus"),
		rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/cancel/exit"),
		rawKeyHint("/", "commands"),
		rawKeyHint("!", "bash"),
		keyHint("app.clipboard.pasteImage", "paste image"),
		keyHint("app.tools.expand", "more"),
	]
		.filter(Boolean)
		.join(theme.fg("muted", " · "));
}

/** Hint that points at the key which reveals the full startup help. */
export function startupHelpHint(options: StartupHintOptions): string {
	return theme.fg(
		"dim",
		[
			`Press ${keyText("app.tools.expand")} to show full startup help${options.showDetails ? " and loaded resources" : ""}.`,
			clipboardPasteFallbackText(options.keybindings),
		]
			.filter(Boolean)
			.join("\n"),
	);
}
