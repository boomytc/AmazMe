import { PROTOCOL_VERSION } from "@amazme/protocol";
import {
	BOOT_GLOBAL,
	BOOT_PLACEHOLDER,
	localizeDocument,
	resolveLocale,
	type Locale,
	type WebBootManifest,
	type WebBootPreferences,
	type WebMode,
} from "@amazme/web";

export interface WebBootOptions {
	/** Product name shown by the page. Defaults to AmazMe. */
	readonly appName?: string;
	readonly version: string;
	readonly serverId: string;
	readonly transportUrl: string;
	readonly transportPath: string;
	readonly mode?: WebMode;
	/** The stored interface preferences; the page starts from these instead of guessing. */
	readonly preferences?: WebBootPreferences;
}

/** Preferences a host with no stored choice serves: the browser's language, the system's palette. */
export const DEFAULT_BOOT_PREFERENCES: WebBootPreferences = { locale: "auto", appearance: "system" };

export function buildBootManifest(options: WebBootOptions): WebBootManifest {
	return {
		app: { name: options.appName ?? "AmazMe", version: options.version },
		mode: options.mode ?? "source",
		protocolVersion: PROTOCOL_VERSION,
		server: { id: options.serverId },
		transport: { url: options.transportUrl, path: options.transportPath },
		preferences: options.preferences ?? DEFAULT_BOOT_PREFERENCES,
	};
}

/**
 * The languages one request asks for, most preferred first: `zh-CN,zh;q=0.9,en;q=0.8` becomes
 * `["zh-CN", "zh", "en"]`. The page and the served document are resolved from the same header, so
 * the static shell and the bundle agree on the language before the page ever runs.
 */
export function requestLanguages(header: string | undefined): string[] {
	if (header === undefined) return [];
	return header
		.split(",")
		.map((entry) => entry.split(";")[0]?.trim() ?? "")
		.filter((entry) => entry.length > 0);
}

/** The language to serve a document in: the stored preference, or what the request asks for. */
export function documentLocale(
	preferences: WebBootPreferences | undefined,
	header: string | undefined,
): Locale {
	return resolveLocale(preferences?.locale, requestLanguages(header));
}

/** JSON that is safe inside a `<script>` element. */
function escapeForScript(json: string): string {
	return json.replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/**
 * Replace the document's boot placeholder. Without a manifest the placeholder stays, so the
 * page sees no manifest and reports that it cannot boot instead of rendering a blank shell.
 */
export function injectBootManifest(html: string, manifest: WebBootManifest | undefined): string {
	if (!html.includes(BOOT_PLACEHOLDER)) {
		throw new Error(`Page document is missing its ${BOOT_PLACEHOLDER} placeholder`);
	}
	const script =
		manifest === undefined
			? ""
			: `<script>globalThis.${BOOT_GLOBAL}=${escapeForScript(JSON.stringify(manifest))};</script>`;
	return html.replace(BOOT_PLACEHOLDER, script);
}

/**
 * The document the host answers with: its static shell in the reader's language, then the boot
 * manifest the page reads. The placeholder stays visible only in the raw `/index.html` case, which
 * is the unbootable document the page reports on.
 */
export function serveDocument(
	html: string,
	manifest: WebBootManifest | undefined,
	acceptLanguage: string | undefined,
): string {
	const locale = documentLocale(manifest?.preferences, acceptLanguage);
	return injectBootManifest(localizeDocument(html, locale), manifest);
}
