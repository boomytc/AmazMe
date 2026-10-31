/** http(s) URL the shell may hand to the system browser. */
export function isExternalUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/** Whether a navigation stays on the host origin the window was opened with. */
export function hasOrigin(raw: string, expected: string): boolean {
	try {
		return new URL(raw).origin === expected;
	} catch {
		return false;
	}
}

/**
 * Top-level navigations the window may follow. `about:blank` is Electron's initial document;
 * blocking it keeps `loadURL` from painting the host.
 */
export function isAllowedNavigation(raw: string, origin: string): boolean {
	return raw === "about:blank" || hasOrigin(raw, origin);
}

/** The host page keeps its document identity while session navigation changes query/hash. */
export function isHostPageDocument(raw: string, expected: string): boolean {
	try {
		const current = new URL(raw), page = new URL(expected);
		return current.origin === page.origin && current.pathname === page.pathname
			&& current.username === "" && current.password === "";
	} catch {
		return false;
	}
}
