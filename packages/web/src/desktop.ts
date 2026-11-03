/**
 * The desktop shell's bridge, as the page sees it. The page also runs in a plain browser, so every
 * member is optional and every caller must work without the bridge.
 *
 * `platform` is the shell's `process.platform`. `data-desktop` on the document paints the native
 * window treatment — the in-page titlebar reserves the macOS traffic-light lane and doubles as the
 * window drag region — only when a shell is actually present, so a browser tab keeps the page
 * without window chrome.
 */

export interface DesktopBridge {
	/** The desktop shell's `process.platform`, e.g. `darwin` or `win32`. */
	readonly platform?: string;
	pickDirectories(): Promise<readonly string[]>;
	/** Desktop menu actions forwarded by the shell. */
	onMenuAction?(listener: (action: "new-session" | "settings") => void): () => void;
	/** Keep the native window backdrop on the page's canvas colour across resizes and theme flips. */
	setWindowBackground?(color: string): void;
}

declare global {
	interface Window {
		amazmeDesktop?: DesktopBridge;
	}
}

/** The shell bridge, or undefined on the plain browser page. */
export function desktopBridge(): DesktopBridge | undefined {
	const bridge: unknown = Reflect.get(globalThis, "amazmeDesktop");
	return typeof bridge === "object" && bridge !== null
		? (bridge as DesktopBridge)
		: undefined;
}

/** Mark the document as desktop-rendered before the first React paint. */
export function applyDesktopChrome(root: HTMLElement): void {
	const platform = desktopBridge()?.platform;
	if (typeof platform === "string" && platform.length > 0)
		root.dataset.desktop = platform;
}

/** Match the native window backdrop to the page canvas. The shell validates the value again. */
export function setWindowBackground(color: string): void {
	if (!/^#[0-9a-fA-F]{6}$/u.test(color)) return;
	desktopBridge()?.setWindowBackground?.(color);
}
