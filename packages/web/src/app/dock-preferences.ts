/** Browser-local presentation preferences; session state remains with the workspace controller. */
export type DockPresentation = "push" | "fullscreen";

const PRESENTATION_KEY = "amazme.dock.presentation";
const WIDTH_KEY = "amazme.dock.width";

export function readDockPresentation(): DockPresentation {
	try {
		return localStorage.getItem(PRESENTATION_KEY) === "fullscreen" ? "fullscreen" : "push";
	} catch {
		return "push";
	}
}

export function storeDockPresentation(presentation: DockPresentation): void {
	storePreference(PRESENTATION_KEY, presentation === "push" ? null : presentation);
}

/** A requested width is independent of the current viewport; CSS owns the rendered bounds. */
export function readDockWidth(): number | null {
	try {
		const width = Number(localStorage.getItem(WIDTH_KEY));
		return Number.isFinite(width) && width > 0 ? width : null;
	} catch {
		return null;
	}
}

export function storeDockWidth(width: number | null): void {
	storePreference(WIDTH_KEY, width === null ? null : String(width));
}

function storePreference(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// Refused storage leaves this window's in-memory preference usable.
	}
}
