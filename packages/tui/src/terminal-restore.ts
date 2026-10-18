/**
 * Every terminal mode the TUI turns on, and the bytes that turn it off.
 * `TUI.stop` and `ProcessTerminal.stop` both write {@link terminalRestoreSequence}.
 * Force exit calls the same `TUI.stop`, so it cannot carry a second copy.
 */

export const ALT_SCREEN_ON = "\x1b[?1049h";
export const ALT_SCREEN_OFF = "\x1b[?1049l";
export const AUTOWRAP_OFF = "\x1b[?7l";
export const AUTOWRAP_ON = "\x1b[?7h";
export const CURSOR_HIDE = "\x1b[?25l";
export const CURSOR_SHOW = "\x1b[?25h";
export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";
/** Pop the Kitty keyboard protocol pushed with `CSI > flags u` (flags 7 on start). */
export const KITTY_KEYBOARD_POP = "\x1b[<u";
export const MODIFY_OTHER_KEYS_ON = "\x1b[>4;2m";
export const MODIFY_OTHER_KEYS_OFF = "\x1b[>4;0m";
export const COLOR_SCHEME_NOTIFICATIONS_ON = "\x1b[?2031h";
export const COLOR_SCHEME_NOTIFICATIONS_OFF = "\x1b[?2031l";
export const MOUSE_BUTTON_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
export const MOUSE_ALL_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
export const SYNCHRONIZED_OUTPUT_ON = "\x1b[?2026h";
export const SYNCHRONIZED_OUTPUT_OFF = "\x1b[?2026l";

/** Modes owned by {@link ProcessTerminal}. Screen state is added by the TUI. */
export interface TerminalModeRestore {
	readonly progressClear: string;
	readonly programStatusClear: string;
	readonly bracketedPaste: boolean;
	readonly kittyKeyboard: boolean;
	readonly modifyOtherKeys: boolean;
}

export interface MainScreenPark {
	readonly targetRow: number;
	readonly hardwareCursorRow: number;
}

export interface TerminalRestoreState extends TerminalModeRestore {
	readonly colorSchemeOff: string;
	readonly kittyImageDelete: string;
	readonly altScreen: boolean;
	readonly mouse: boolean;
	/**
	 * Leave the alternate screen without reprinting it.
	 * The trailing CR LF parks the cursor under the shell's saved row so the
	 * next line — the prompt, or the force-exit message — stands alone.
	 */
	readonly preserveScreen: boolean;
	readonly reprintLines: readonly string[];
	readonly showCursor: boolean;
	readonly mainScreenPark?: MainScreenPark;
}

export function terminalRestoreDefaults(): TerminalRestoreState {
	return {
		colorSchemeOff: "",
		kittyImageDelete: "",
		altScreen: false,
		mouse: false,
		preserveScreen: false,
		reprintLines: [],
		showCursor: false,
		progressClear: "",
		programStatusClear: "",
		bracketedPaste: false,
		kittyKeyboard: false,
		modifyOtherKeys: false,
	};
}

export interface TerminalRestoreParts {
	/** Mouse, autowrap, cursor, and main-screen park. Written before keyboard modes. */
	readonly beforeModes: string;
	/** Bracketed paste, Kitty keyboard, modifyOtherKeys, progress, program status. */
	readonly modes: string;
	/** Leave the alternate screen after keyboard modes are off. */
	readonly afterModes: string;
}

/**
 * Bytes that put the terminal back.
 * `beforeModes` is written, then `modes`, then the terminal detaches, then `afterModes`.
 * Keyboard modes are off before the alternate screen is left. Both stop paths use these parts.
 */
export function terminalRestoreParts(state: TerminalRestoreState): TerminalRestoreParts {
	let beforeModes = state.colorSchemeOff;
	if (state.altScreen) {
		beforeModes += SYNCHRONIZED_OUTPUT_ON;
		beforeModes += state.kittyImageDelete;
		if (state.mouse) beforeModes += MOUSE_OFF;
		beforeModes += AUTOWRAP_ON;
		beforeModes += SYNCHRONIZED_OUTPUT_OFF;
	}
	const park = state.mainScreenPark;
	if (park) {
		beforeModes += " ";
		const lineDiff = park.targetRow - park.hardwareCursorRow;
		if (lineDiff > 0) beforeModes += `\x1b[${lineDiff}B`;
		else if (lineDiff < 0) beforeModes += `\x1b[${-lineDiff}A`;
		beforeModes += "\r\n";
	}
	if (state.showCursor) beforeModes += CURSOR_SHOW;
	let modes = state.progressClear + state.programStatusClear;
	if (state.bracketedPaste) modes += BRACKETED_PASTE_OFF;
	if (state.kittyKeyboard) modes += KITTY_KEYBOARD_POP;
	if (state.modifyOtherKeys) modes += MODIFY_OTHER_KEYS_OFF;
	const afterModes = state.altScreen
		? state.preserveScreen
			? preservedAltScreenExit()
			: reprintedAltScreenExit(state.reprintLines)
		: "";
	return { beforeModes, modes, afterModes };
}

/** Bytes that put the terminal back. Both stop paths write this string and nothing else. */
export function terminalRestoreSequence(state: TerminalRestoreState): string {
	const parts = terminalRestoreParts(state);
	return parts.beforeModes + parts.modes + parts.afterModes;
}

function preservedAltScreenExit(): string {
	return `${SYNCHRONIZED_OUTPUT_ON}${ALT_SCREEN_OFF}${CURSOR_SHOW}${SYNCHRONIZED_OUTPUT_OFF}\r\n`;
}

function reprintedAltScreenExit(lines: readonly string[]): string {
	let buffer = `${SYNCHRONIZED_OUTPUT_ON}${ALT_SCREEN_OFF}${AUTOWRAP_OFF}`;
	for (let row = 0; row < lines.length; row++) {
		if (row > 0) buffer += "\r\n";
		buffer += `\r\x1b[2K${lines[row] ?? ""}`;
	}
	buffer += `\x1b[0m${AUTOWRAP_ON}\r\n${CURSOR_SHOW}${SYNCHRONIZED_OUTPUT_OFF}`;
	return buffer;
}
