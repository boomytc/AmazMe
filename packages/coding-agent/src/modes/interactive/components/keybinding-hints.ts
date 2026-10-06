/**
 * Utilities for formatting keybinding hints in the UI.
 */

import type { Keybinding, KeybindingsManager, KeyId } from "@amazme/tui";
import { getKeybindings } from "@amazme/tui";
import type { KeyTextFormatOptions } from "../../../core/keybinding-labels.ts";
import { formatKeyText } from "../../../core/keybinding-labels.ts";
import { getClipboardPasteKeys } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";

export type { KeyTextFormatOptions };
export { formatKeyText };

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function clipboardPasteFallbackText(
	keybindings: KeybindingsManager = getKeybindings(),
	options: KeyTextFormatOptions = {},
): string | undefined {
	const [primary, fallback] = getClipboardPasteKeys(options.platform, options.env);
	const keys = keybindings.getKeys("app.clipboard.pasteImage");
	if (!keys.includes(primary) || !keys.includes(fallback)) return undefined;
	const displayOptions = { ...options, capitalize: true };
	return `${formatKeyText(primary, displayOptions)} supports terminal image paste; ${formatKeyText(fallback, displayOptions)} also reads the clipboard directly.`;
}

export function keyHint(keybinding: Keybinding, description: string): string {
	const text = keyText(keybinding);
	if (!text) return "";
	return theme.fg("dim", text) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}
