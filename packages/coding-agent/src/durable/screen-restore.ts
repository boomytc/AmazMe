import { type TUI, TuiAltScreen } from "@amazme/tui";

const restored = new WeakSet<TUI>();

/**
 * Give the shell its screen back by calling the same `TUI.stop` a graceful exit uses.
 *
 * Fullscreen is the alternate screen. `preserveScreen` leaves that screen and
 * does not reprint the last frame. The shared restore sequence ends with a
 * newline so the prompt, or the force-exit line, is not written on the shell's
 * saved row.
 *
 * Regular mode draws on the main screen. Its stop parks the cursor under the
 * conversation and leaves that text where it is.
 *
 * There is no second sequence. Force exit calls this function, and so does
 * `DurableTui.stop`.
 */
export function restoreDurableScreen(ui: TUI, options: { deferInputRestore?: boolean; onDeferredInput?: (data: string) => void } = {}): void {
	if (restored.has(ui)) return;
	restored.add(ui);
	if (ui instanceof TuiAltScreen) {
		ui.stop({ preserveScreen: true, ...options });
		return;
	}
	ui.stop(options);
}

/** Restore cooked input after the exit transaction finished. Idempotent. */
export function restoreDurableInput(ui: TUI): void {
	ui.restoreInput();
}
