/**
 * Keyboard shortcuts, following the convention DSH uses for its web runtime: the product keys are
 * `primary` (Meta on macOS, Control elsewhere) plus Alt, because the browser keeps the plain
 * `primary` combinations for itself. Two keys need no modifier: `/` focuses the composer, and a
 * second `Escape` within the stop window stops the running turn — the double-escape the TUI and DSH
 * both use.
 *
 * One table serves both jobs: the reference the reader sees, and the matcher the renderer uses. A
 * gesture arrives with `primary` already normalized, so matching never depends on the platform.
 */
import type { Locale } from "./locale.ts";
import { type MessageKey, translate } from "./strings.ts";

/** How long a first `Escape` stays armed for the second one that stops the turn. */
export const STOP_SEQUENCE_MS = 500;

/** The actions a shortcut can trigger. */
export type ShortcutId = "session.new" | "view.cycle" | "composer.focus" | "run.stop";

export interface ShortcutGesture {
	/** The physical key, e.g. `KeyM`, `Slash`, `Escape`. */
	readonly code: string;
	/** Meta on macOS, Control elsewhere. */
	readonly primary: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

export interface Shortcut {
	readonly id: ShortcutId;
	readonly gesture: ShortcutGesture;
	/** How the keys read on this platform, e.g. `⌘⌥M` or `Ctrl+Alt+M`. */
	readonly keys: string;
	readonly label: string;
}

const TABLE: readonly { readonly id: ShortcutId; readonly gesture: ShortcutGesture; readonly message: MessageKey }[] = [
	{ id: "session.new", gesture: { code: "KeyN", primary: true, alt: true, shift: false }, message: "shortcut.newSession" },
	{ id: "view.cycle", gesture: { code: "KeyM", primary: true, alt: true, shift: false }, message: "shortcut.cycleView" },
	{
		id: "composer.focus",
		gesture: { code: "Slash", primary: false, alt: false, shift: false },
		message: "shortcut.focusComposer",
	},
	{ id: "run.stop", gesture: { code: "Escape", primary: false, alt: false, shift: false }, message: "shortcut.stop" },
];

/** Whether the platform's primary modifier is Meta, the way a browser reports its platform. */
export function isApplePlatform(platform: string): boolean {
	return platform.toLowerCase().includes("mac");
}

function keyLabel(code: string): string {
	if (code.startsWith("Key")) return code.slice(3);
	if (code === "Slash") return "/";
	if (code === "Escape") return "Esc";
	return code;
}

/** How one gesture reads on a platform: Apple's symbols, or the spelled-out combinations. */
export function gestureKeys(gesture: ShortcutGesture, platform: string): string {
	const apple = isApplePlatform(platform);
	const parts: string[] = [];
	if (gesture.primary) parts.push(apple ? "\u2318" : "Ctrl");
	if (gesture.alt) parts.push(apple ? "\u2325" : "Alt");
	if (gesture.shift) parts.push(apple ? "\u21e7" : "Shift");
	const key = keyLabel(gesture.code);
	return apple ? `${parts.join("")}${key}` : [...parts, key].join("+");
}

/** The table in the reader's language, with the keys as this platform writes them. */
export function shortcuts(locale: Locale, platform: string): Shortcut[] {
	return TABLE.map((row) => ({
		id: row.id,
		gesture: row.gesture,
		keys: gestureKeys(row.gesture, platform),
		label: translate(locale, row.message),
	}));
}

/** The action one gesture means, or undefined. A gesture must match every modifier it declares. */
export function matchShortcut(gesture: ShortcutGesture): ShortcutId | undefined {
	const row = TABLE.find(
		(candidate) =>
			candidate.gesture.code === gesture.code &&
			candidate.gesture.primary === gesture.primary &&
			candidate.gesture.alt === gesture.alt &&
			candidate.gesture.shift === gesture.shift,
	);
	return row?.id;
}
