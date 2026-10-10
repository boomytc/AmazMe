import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, expandTildePath } from "@amazme/coding-agent/config";
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

async function storedLocale(path: string): Promise<string | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof value !== "object" || value === null || !("locale" in value)) return undefined;
		return typeof value.locale === "string" ? value.locale : "auto";
	} catch { return undefined; }
}

/** Interface locale is global-only, just like SettingsManager.getLocalePreference. No credentials are loaded. */
export async function readDesktopLocalePreference(cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const configured = env[ENV_AGENT_DIR] || join(homedir(), CONFIG_DIR_NAME, "agent");
	const agent = resolve(cwd, expandTildePath(configured));
	return storedLocale(join(agent, "settings.json"));
}
