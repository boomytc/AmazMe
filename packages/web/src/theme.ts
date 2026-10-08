/// <reference lib="dom" />
/**
 * Palette preference. The served document's boot script sets `data-theme` on `<html>` from the stored
 * preference before the first paint, and this module re-applies it on every render, so a switch in
 * the settings lands without a reload. `tokens.css` keys its dark palette off `:root[data-theme="dark"]`.
 * `system` is the default, so a page with no host preference still follows the operating system live.
 */

/** What the agent's settings store: the system's palette, or one fixed choice. */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The palette this page last applied; the media listener repaints with it when the system flips. */
let preference: ThemePreference = "system";
let installed = false;
let media: MediaQueryList | undefined;

export function isThemePreference(value: string): value is ThemePreference {
	return (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** The stored value as a preference: an unset or unknown value follows the system. */
export function resolveThemePreference(value: string | undefined): ThemePreference {
	return value !== undefined && isThemePreference(value) ? value : "system";
}

/** Whether a preference paints dark given what the system reports. */
export function isDarkTheme(chosen: ThemePreference, systemDark: boolean): boolean {
	return chosen === "dark" || (chosen === "system" && systemDark);
}

function paint(): void {
	const dark = isDarkTheme(preference, media?.matches ?? false);
	document.documentElement.dataset.theme = dark ? "dark" : "light";
	// Native controls and scrollbars follow the same choice as the palette.
	document.documentElement.style.colorScheme = preference === "system" ? "light dark" : preference;
}

/** Apply a preference now; every render calls this, so a switch lands without a reload. */
export function applyTheme(next: ThemePreference): void {
	preference = next;
	paint();
}

/**
 * Follow the system's palette changes for the lifetime of the page. Called once at boot, before the
 * first paint the document's own script already made.
 */
export function followSystemTheme(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;
	media = window.matchMedia(DARK_QUERY);
	media.addEventListener("change", paint);
	paint();
}
