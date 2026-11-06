/** The sidebar's requested width. CSS clamps it to the window; session state stays with the workspace. */

const WIDTH_KEY = "amazme.sidebar.width";

export function readSidebarWidth(): number | null {
	try {
		const width = Number(localStorage.getItem(WIDTH_KEY));
		return Number.isFinite(width) && width > 0 ? width : null;
	} catch {
		return null;
	}
}

export function storeSidebarWidth(width: number | null): void {
	try {
		if (width === null) localStorage.removeItem(WIDTH_KEY);
		else localStorage.setItem(WIDTH_KEY, String(width));
	} catch {
		// Refused storage leaves this window's in-memory preference usable.
	}
}
