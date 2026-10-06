/**
 * Utilities for formatting keybinding hints in the UI.
 */

import type { Keybinding, KeybindingsManager, KeyId } from "@amazme/tui";
import { getKeybindings } from "@amazme/tui";
import type { KeyTextFormatOptions } from "../../../core/keybinding-labels.ts";
import { formatKeyText } from "../../../core/keybinding-labels.ts";
import { getClipboardPasteKeys, KEYBINDINGS } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";

export type { KeyTextFormatOptions };
export { formatKeyText };

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

/**
 * Resolved keys for a binding. Components can render before the application
 * keybinding table is installed, so the shipped default stands in until then.
 */
function resolvedKeys(keybinding: Keybinding): KeyId[] {
	const manager = getKeybindings();
	// A known binding reports what it resolved to, including a deliberate empty list.
	if (manager.getDefinition(keybinding) !== undefined) return manager.getKeys(keybinding);
	const defaults = (KEYBINDINGS as Record<string, { defaultKeys?: KeyId | KeyId[] } | undefined>)[keybinding]?.defaultKeys;
	if (defaults === undefined) return [];
	return Array.isArray(defaults) ? defaults : [defaults];
}

/** Key names are spelled the same way in every user-visible surface. */
export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(resolvedKeys(keybinding), { capitalize: true });
}

/** Same spelling; the shorter name stays for existing call sites. */
export function keyText(keybinding: Keybinding): string {
	return keyDisplayText(keybinding);
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
	return theme.fg("dim", formatKeyText(key, { capitalize: true })) + theme.fg("muted", ` ${description}`);
}
