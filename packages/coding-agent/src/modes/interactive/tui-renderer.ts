import type { Terminal, WheelScrollLines } from "@amazme/tui";
import { ProcessTerminal, TuiAltScreen, TuiMainScreen } from "@amazme/tui";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { keyDisplayText } from "./components/keybinding-hints.ts";
import { theme } from "./theme/theme.ts";

export interface InteractiveTuiOptions {
	readonly tuiMode: "regular" | "fullscreen";
	readonly showHardwareCursor: boolean;
	readonly logDirectory: string;
	readonly terminal?: Terminal;
	readonly onRightClickPaste?: () => void;
	readonly onCopySuccess?: () => void;
	readonly fullscreenCopyOnSelect?: boolean;
	readonly fullscreenWheelScrollLines?: WheelScrollLines;
	readonly renderIntervalMs?: number;
}

/** Composition root shared by coding-agent presentations. */
export function createInteractiveTui(options: InteractiveTuiOptions & { readonly tuiMode: "fullscreen" }): TuiAltScreen;
export function createInteractiveTui(options: InteractiveTuiOptions & { readonly tuiMode: "regular" }): TuiMainScreen;
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen;
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen {
	const terminal = options.terminal ?? new ProcessTerminal();
	const tui = createRenderer(terminal, options);
	if (options.renderIntervalMs !== undefined) tui.setMinRenderIntervalMs(options.renderIntervalMs);
	return tui;
}

function createRenderer(terminal: Terminal, options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen {
	if (options.tuiMode === "fullscreen") {
		const styleSearchMatch = (text: string) => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
		return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
			searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
			searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
			searchNavigationButtonStyle: (text, hovered) => (hovered ? theme.underline(text) : text),
			scrollToEndIndicator: () => {
				const shortcut = keyDisplayText("tui.altScreen.bottom");
				const label = ` ↓ Jump to latest message${shortcut ? ` · ${shortcut}` : ""} `;
				return theme.bg("selectedBg", theme.fg("text", label));
			},
			openUrl: openBrowser,
			onRightClickPaste: options.onRightClickPaste,
			onCopySuccess: options.onCopySuccess,
			copyOnSelect: options.fullscreenCopyOnSelect,
			wheelScrollLines: options.fullscreenWheelScrollLines ?? "auto",
			copySelection: async (text) => {
				try {
					await copyToClipboard(text);
					return true;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			},
		});
	}
	return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
}
