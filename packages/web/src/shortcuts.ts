/**
 * Keyboard shortcuts, following the convention DSH uses for its web runtime: the product keys are
 * `primary` (Meta on macOS, Control elsewhere) plus Alt, because the browser keeps the plain
 * `primary` combinations for itself. `/` focuses the composer. Stopping a turn is one chord,
 * Ctrl+C; Escape only closes menus.
 *
 * One table serves both jobs: the reference the reader sees, and the matcher the renderer uses.
 * Each row's id is the action id it reports, so a shortcut never needs a private command name. A
 * gesture arrives with `primary` already normalized, so matching never depends on the platform.
 */
import {
	COMPOSER_FOCUS_ACTION,
	DOCK_FULLSCREEN_ACTION,
	DOCK_TOGGLE_ACTION,
	RUN_STOP_ACTION,
	SESSION_NEW_ACTION,
	TRANSCRIPT_NEXT_PROMPT_ACTION,
	TRANSCRIPT_PREVIOUS_PROMPT_ACTION,
} from "./actions.ts";
import type { Locale } from "./locale.ts";
import { type MessageKey, translate } from "./strings.ts";
import type { FontSizeAction } from "./typography.ts";

/** The action ids a shortcut can trigger; font sizing carries the adjustment after `font:`. */
export type ShortcutId =
	| typeof SESSION_NEW_ACTION
	| typeof DOCK_TOGGLE_ACTION
	| typeof DOCK_FULLSCREEN_ACTION
	| typeof COMPOSER_FOCUS_ACTION
	| typeof RUN_STOP_ACTION
	| typeof TRANSCRIPT_PREVIOUS_PROMPT_ACTION
	| typeof TRANSCRIPT_NEXT_PROMPT_ACTION
	| `font:${FontSizeAction}`;

/** The command id one font adjustment reports. */
export function fontCommand(action: FontSizeAction): `font:${FontSizeAction}` {
	return `font:${action}`;
}

export interface ShortcutGesture {
	/** The physical key, e.g. `KeyM`, `Slash`, `Escape`. */
	readonly code: string;
	/** Meta on macOS, Control elsewhere. */
	readonly primary: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
	/** Bare Control, the stop chord. Distinct from `primary`, which is Meta on macOS. */
	readonly control?: boolean;
}

export interface Shortcut {
	readonly id: ShortcutId;
	readonly gesture: ShortcutGesture;
	/** How the keys read on this platform, e.g. `⌘⌥M` or `Ctrl+Alt+M`. */
	readonly keys: string;
	readonly label: string;
}

const TABLE: readonly { readonly id: ShortcutId; readonly gesture: ShortcutGesture; readonly message: MessageKey }[] = [
	{ id: SESSION_NEW_ACTION, gesture: { code: "KeyN", primary: true, alt: true, shift: false }, message: "shortcut.newSession" },
	{ id: DOCK_TOGGLE_ACTION, gesture: { code: "KeyM", primary: true, alt: true, shift: false }, message: "shortcut.toggleDock" },
	{ id: DOCK_FULLSCREEN_ACTION, gesture: { code: "Enter", primary: true, alt: true, shift: false }, message: "shortcut.toggleFullscreen" },
	{
		id: COMPOSER_FOCUS_ACTION,
		gesture: { code: "Slash", primary: false, alt: false, shift: false },
		message: "shortcut.focusComposer",
	},
	{ id: RUN_STOP_ACTION, gesture: { code: "KeyC", primary: false, alt: false, shift: false, control: true }, message: "shortcut.stop" },
	{
		id: TRANSCRIPT_PREVIOUS_PROMPT_ACTION,
		gesture: { code: "ArrowUp", primary: false, alt: true, shift: false },
		message: "shortcut.previousPrompt",
	},
	{
		id: TRANSCRIPT_NEXT_PROMPT_ACTION,
		gesture: { code: "ArrowDown", primary: false, alt: true, shift: false },
		message: "shortcut.nextPrompt",
	},
];

/** Ctrl+C with nothing else held. A selection still copies; the caller checks that. */
export function isStopChord(input: { readonly code: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean }): boolean {
	return input.code === "KeyC" && input.ctrlKey && !input.metaKey && !input.altKey && !input.shiftKey;
}

/** Whether the platform's primary modifier is Meta, the way a browser reports its platform. */
export function isApplePlatform(platform: string): boolean {
	return platform.toLowerCase().includes("mac");
}

function keyLabel(code: string): string {
	if (code.startsWith("Key")) return code.slice(3);
	if (code === "Slash") return "/";
	if (code === "Escape") return "Esc";
	if (code === "Equal") return "+";
	if (code === "Minus") return "-";
	if (code === "Digit0") return "0";
	if (code === "ArrowUp") return "\u2191";
	if (code === "ArrowDown") return "\u2193";
	if (code === "ArrowLeft") return "\u2190";
	if (code === "ArrowRight") return "\u2192";
	return code;
}

/** How one gesture reads on a platform: Apple's symbols, or the spelled-out combinations. */
export function gestureKeys(gesture: ShortcutGesture, platform: string): string {
	if (gesture.control === true) return `Ctrl+${keyLabel(gesture.code)}`;
	const apple = isApplePlatform(platform);
	const parts: string[] = [];
	if (gesture.primary) parts.push(apple ? "\u2318" : "Ctrl");
	if (gesture.alt) parts.push(apple ? "\u2325" : "Alt");
	if (gesture.shift) parts.push(apple ? "\u21e7" : "Shift");
	const key = keyLabel(gesture.code);
	return apple ? `${parts.join("")}${key}` : [...parts, key].join("+");
}

/** The table in the reader's language, with the keys as this platform writes them. */
export function shortcuts(locale: Locale, platform: string, desktop = false): Shortcut[] {
	const fontRows = desktop ? [
		{ id: fontCommand("increase"), gesture: { code: "Equal", primary: true, alt: false, shift: false }, message: "shortcut.fontIncrease" as const },
		{ id: fontCommand("decrease"), gesture: { code: "Minus", primary: true, alt: false, shift: false }, message: "shortcut.fontDecrease" as const },
		{ id: fontCommand("reset"), gesture: { code: "Digit0", primary: true, alt: false, shift: false }, message: "shortcut.fontReset" as const },
	] : [];
	return [...TABLE, ...fontRows].map((row) => ({
		id: row.id,
		gesture: row.gesture,
		keys: gestureKeys(row.gesture, platform),
		label: translate(locale, row.message),
	}));
}

/** The desktop owns content zoom. A regular browser keeps its native page zoom gestures. */
export function fontSizeShortcut(
	event: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
	platform: string,
	desktop: boolean,
): FontSizeAction | undefined {
	if (!desktop || event.altKey || (isApplePlatform(platform) ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return undefined;
	if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") return "increase";
	if (!event.shiftKey && (event.key === "-" || event.code === "NumpadSubtract")) return "decrease";
	if (!event.shiftKey && (event.key === "0" || event.code === "Numpad0")) return "reset";
	return undefined;
}

/** The action one gesture means, or undefined. A gesture must match every modifier it declares. */
export function matchShortcut(gesture: ShortcutGesture): ShortcutId | undefined {
	const row = TABLE.find((candidate) => {
		if (candidate.gesture.code !== gesture.code) return false;
		if (candidate.gesture.control === true) return gesture.control === true && !gesture.primary && !gesture.alt && !gesture.shift;
		return candidate.gesture.primary === gesture.primary && candidate.gesture.alt === gesture.alt && candidate.gesture.shift === gesture.shift && gesture.control !== true;
	});
	return row?.id;
}
