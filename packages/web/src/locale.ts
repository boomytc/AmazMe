/**
 * The page's language: the shipped locales, the stored preference, and how a browser's own
 * languages fill in for the preference. The dictionary itself lives in `strings.ts`; the host
 * persists the preference in the agent's settings, so the same choice reaches every presentation.
 */

/** The languages the page ships, in the order the picker lists them. */
export type Locale = "zh" | "en";

export const LOCALES: readonly Locale[] = ["zh", "en"];

/** What the agent's settings store for `locale`: a shipped language, or `auto` for the browser. */
export type LocalePreference = "auto" | Locale;

/** The document's `lang` attribute per shipped language. */
const DOCUMENT_LANGUAGES: Readonly<Record<Locale, string>> = { zh: "zh-Hans", en: "en" };

/** The language a browser gets when it asks for nothing the product ships. */
export const FALLBACK_LOCALE: Locale = "en";

export function isLocale(value: string): value is Locale {
	return (LOCALES as readonly string[]).includes(value);
}

/**
 * The first shipped language a browser asks for, matched by full tag and then primary subtag the
 * way DSH matches `navigator.languages`; a browser asking for neither language gets English.
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
 * The language to render: the stored preference when it names one, and the browser's own languages
 * while it is `auto`, unset, or unrecognized.
 */
export function resolveLocale(preference: string | undefined, languages: readonly string[]): Locale {
	return preference !== undefined && isLocale(preference) ? preference : matchLocale(languages);
}

export function documentLanguage(locale: Locale): string {
	return DOCUMENT_LANGUAGES[locale];
}
