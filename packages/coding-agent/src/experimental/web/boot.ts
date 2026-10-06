import { PROTOCOL_VERSION } from "@amazme/protocol";
import { BOOT_GLOBAL, BOOT_PLACEHOLDER, type WebBootManifest, type WebMode } from "./contract.ts";

export interface WebBootOptions {
	/** Product name shown by the page. Defaults to AmazMe. */
	readonly appName?: string;
	readonly version: string;
	readonly serverId: string;
	readonly transportUrl: string;
	readonly transportPath: string;
	readonly mode?: WebMode;
}

export function buildBootManifest(options: WebBootOptions): WebBootManifest {
	return {
		app: { name: options.appName ?? "AmazMe", version: options.version },
		mode: options.mode ?? "source",
		protocolVersion: PROTOCOL_VERSION,
		server: { id: options.serverId },
		transport: { url: options.transportUrl, path: options.transportPath },
	};
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
