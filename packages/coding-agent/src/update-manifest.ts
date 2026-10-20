import { gt, prerelease, valid } from "semver";

export const RELEASE_DOWNLOAD_PREFIX = "https://github.com/boomytc/AmazMe/releases/download/";
export const UPDATE_MANIFEST_URL = "https://github.com/boomytc/AmazMe/releases/latest/download/latest.json";
export type UpdateChannel = "stable" | "preview";
export interface UpdateAsset {
	readonly name: string;
	readonly url: string;
	readonly sha256: string;
	readonly size?: number;
	readonly platform?: "darwin";
	readonly arch?: "arm64" | "x64";
}
export interface UpdateManifest { readonly version: string; readonly tag: string; readonly assets: readonly UpdateAsset[] }
export function isNewerRelease(version: string, current: string): boolean { return valid(version) === version && valid(current) === current && gt(version, current); }

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
/** The manifest is a locator, never the authority for the app's signing identity. */
export function parseUpdateManifest(value: unknown): UpdateManifest {
	if (!record(value) || typeof value.version !== "string" || valid(value.version) !== value.version
		|| value.tag !== `v${value.version}` || !Array.isArray(value.assets) || value.assets.length === 0 || value.assets.length > 16) throw new Error("manifest");
	const names = new Set<string>();
	const assets: UpdateAsset[] = value.assets.map((asset: unknown) => {
		if (!record(asset) || typeof asset.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(asset.name)
			|| names.has(asset.name) || asset.url !== `${RELEASE_DOWNLOAD_PREFIX}${String(value.tag)}/${asset.name}`
			|| typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error("manifest");
		names.add(asset.name);
		if (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || Number(asset.size) <= 0 || Number(asset.size) > 2_000_000_000)) throw new Error("manifest");
		if (asset.platform !== undefined && asset.platform !== "darwin") throw new Error("manifest");
		if (asset.arch !== undefined && asset.arch !== "arm64" && asset.arch !== "x64") throw new Error("manifest");
		return { name: asset.name, url: String(asset.url), sha256: asset.sha256,
			...(asset.size === undefined ? {} : { size: Number(asset.size) }),
			...(asset.platform === undefined ? {} : { platform: asset.platform }),
			...(asset.arch === undefined ? {} : { arch: asset.arch }) };
	});
	return { version: value.version, tag: String(value.tag), assets };
}

export function desktopUpdateAsset(manifest: UpdateManifest, current: string, channel: UpdateChannel, platform: string, arch: string): UpdateAsset | undefined {
	if (!isNewerRelease(manifest.version, current) || (channel === "stable" && prerelease(manifest.version) !== null)) return undefined;
	if (platform !== "darwin" || (arch !== "arm64" && arch !== "x64")) throw new Error("unsupported");
	const name = `AmazMe-${manifest.version}-macos-${arch === "x64" ? "x86_64" : arch}.dmg`;
	const asset = manifest.assets.find((candidate) => candidate.name === name);
	if (!asset || asset.platform !== platform || asset.arch !== arch || asset.size === undefined) throw new Error("unsupported");
	return asset;
}

/** Bound redirects to GitHub's release CDN. Never send credentials or accept a downgrade to HTTP. */
export async function githubReleaseResponse(url: string, signal: AbortSignal, get: typeof fetch = fetch): Promise<Response> {
	let current = url;
	for (let redirect = 0; redirect <= 5; redirect++) {
		const parsed = new URL(current);
		if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
			|| !["github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(parsed.hostname)) throw new Error("source");
		const response = await get(current, { signal, redirect: "manual", credentials: "omit", headers: { "Accept-Encoding": "identity" } });
		if (![301, 302, 303, 307, 308].includes(response.status)) {
			if (!response.ok) { await response.body?.cancel(); throw new Error("network"); }
			return response;
		}
		const location = response.headers.get("location");
		await response.body?.cancel();
		if (!location) throw new Error("source");
		current = new URL(location, current).href;
	}
	throw new Error("source");
}

export async function boundedJson(response: Response, limit = 65_536): Promise<unknown> {
	if (!response.body) throw new Error("manifest");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for await (const chunk of response.body) {
			size += chunk.byteLength;
			if (size > limit) throw new Error("manifest");
			chunks.push(chunk);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch { throw new Error("manifest"); }
}

export async function fetchDesktopManifest(channel: UpdateChannel, signal: AbortSignal, get: typeof fetch = fetch): Promise<UpdateManifest> {
	let url = UPDATE_MANIFEST_URL;
	if (channel === "preview") {
		const releases = await boundedJson(await githubReleaseResponse("https://api.github.com/repos/boomytc/AmazMe/releases?per_page=20", signal, get), 1_048_576);
		if (!Array.isArray(releases)) throw new Error("manifest");
		let selected: string | undefined;
		for (const release of releases) {
			if (!record(release) || release.draft !== false || typeof release.tag_name !== "string") continue;
			const version = release.tag_name.slice(1);
			if (release.tag_name !== `v${version}` || valid(version) !== version) continue;
			if (selected === undefined || gt(version, selected)) selected = version;
		}
		if (!selected) throw new Error("manifest");
		url = `${RELEASE_DOWNLOAD_PREFIX}v${selected}/latest.json`;
	}
	return parseUpdateManifest(await boundedJson(await githubReleaseResponse(url, signal, get)));
}
