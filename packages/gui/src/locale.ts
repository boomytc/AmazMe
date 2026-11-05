import { matchLocale, resolveLocale } from "@amazme/web/locale";
import type { Locale } from "@amazme/web/locale";

/** Use the rendered page's language when available; saved preferences cover pre-readiness and crashed pages. */
export function desktopLocale(preference: string | undefined, languages: readonly string[], documentLanguage?: unknown): Locale {
	if (typeof documentLanguage === "string" && /^(en|zh)(-|$)/iu.test(documentLanguage)) {
		return matchLocale([documentLanguage]);
	}
	return resolveLocale(preference, languages);
}

/** A hung renderer must not prevent a native host-failure dialog or context menu. */
export async function readDesktopDocumentLanguage(read: () => Promise<unknown>, timeoutMs = 250): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			read(),
			new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
		]);
	} catch { return undefined; }
	finally { if (timer !== undefined) clearTimeout(timer); }
}
