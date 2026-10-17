import { matchesKey } from "@amazme/tui";
import type { InteractiveComposer } from "./composer-contract.ts";
import type { TranscriptFocus } from "./transcript-focus.ts";
import type { WorkSurface } from "./work-surface.ts";

/**
 * Order in which the prompt offers one key to the surfaces that share it. The list is
 * the contract: a surface that wants a key must be listed here, and moving an entry
 * changes who wins without touching the call sites.
 *
 * Extension dialogs and the dashboard replace the editor slot, so they receive keys
 * before this router runs at all.
 */
export const INPUT_PRIORITY = ["child", "transcript", "composer"] as const;

export type InputTarget = (typeof INPUT_PRIORITY)[number];

export interface InputHandlers {
	child?: { handleInput(data: string): boolean };
	transcript: { handleInput(data: string): boolean };
	composer: { handleInput(data: string): boolean };
}

/** Tab, arrows, Enter, and Esc belong to the open completion menu, not the scrollback. */
export function promptOwnsKey(data: string, autocompleteOpen: boolean): boolean {
	if (!autocompleteOpen) return false;
	return (
		matchesKey(data, "tab") ||
		matchesKey(data, "shift+tab") ||
		matchesKey(data, "up") ||
		matchesKey(data, "down") ||
		matchesKey(data, "enter") ||
		matchesKey(data, "escape")
	);
}

/** The interactive editor's first input stop: child view, then transcript, then composer. */
export function routeInteractiveInput(data: string, handlers: InputHandlers): boolean {
	for (const target of INPUT_PRIORITY) {
		if (handlers[target]?.handleInput(data)) return true;
	}
	return false;
}

export type { InteractiveComposer, TranscriptFocus, WorkSurface };
