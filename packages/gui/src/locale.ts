/**
 * Shell language.
 *
 * The page resolves a shipped `zh` or `en` in `@amazme/web` (`locale.ts` plus `strings.ts`).
 * Those modules are not public exports, and this package does not depend on the page: the
 * window loads it over HTTP. The shell keeps the same match — full tag, then primary subtag,
 * otherwise English — and its own catalog in `strings.ts`.
 *
 * There is no preload, so the shell cannot read the locale stored in agent settings. It
 * resolves from the OS language list, which is the page's `auto` path.
 */

/** The languages the shell ships, in the order the page lists them. */
export type Locale = "zh" | "en";

export const LOCALES: readonly Locale[] = ["zh", "en"];

/** The language used when the OS asks for nothing this shell ships. */
export const FALLBACK_LOCALE: Locale = "en";

export function isLocale(value: string): value is Locale {
	return (LOCALES as readonly string[]).includes(value);
}

/**
 * The first shipped language in an OS language list, matched by full tag and then primary
 * subtag the way the page matches `navigator.languages`.
 */
export function matchLocale(languages: readonly string[]): Locale {
	for (const language of languages) {
		const normalized = language.toLowerCase();
		if (isLocale(normalized)) return normalized;
		const primary = normalized.split("-")[0] ?? "";
		if (isLocale(primary)) return primary;
	}
	return FALLBACK_LOCALE;
}

/**
 * A stored preference when it names a shipped language; otherwise the OS list. The shell
 * always passes an unset preference, because it has no settings channel.
 */
export function resolveLocale(preference: string | undefined, languages: readonly string[]): Locale {
	return preference !== undefined && isLocale(preference) ? preference : matchLocale(languages);
}

/** Locale for shell copy: OS languages, since the stored preference is not visible here. */
export function shellLocale(languages: readonly string[]): Locale {
	return resolveLocale(undefined, languages);
}
