import { matchesKey } from "@amazme/tui";
import type { InteractiveComposer } from "./composer-contract.ts";
import type { TranscriptFocus } from "./transcript-focus.ts";
import type { WorkSurface } from "./work-surface.ts";

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
export function routeInteractiveInput(
	data: string,
	route: {
		child?: { handleInput(data: string): boolean };
		transcript: { handleInput(data: string): boolean };
		composer: { handleInput(data: string): boolean };
	},
): boolean {
	if (route.child?.handleInput(data)) return true;
	if (route.transcript.handleInput(data)) return true;
	return route.composer.handleInput(data);
}

export type { InteractiveComposer, TranscriptFocus, WorkSurface };
