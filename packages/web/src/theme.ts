/// <reference lib="dom" />
/**
 * Palette selector. DSH keys its dark overrides off `body[data-ds-dark-theme]` and resolves that
 * attribute from the theme preference (ui-theme boot-theme.ts); the preference it reads first is
 * `system`, so with no host-backed preference the system is the page's only source and later
 * changes to it have to be followed.
 */
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function followSystemTheme(): void {
	const query = window.matchMedia(DARK_QUERY);
	const apply = (): void => {
		document.body.toggleAttribute("data-ds-dark-theme", query.matches);
	};
	apply();
	query.addEventListener("change", apply);
}
