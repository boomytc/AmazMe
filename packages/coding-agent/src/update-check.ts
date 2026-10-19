import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { valid } from "semver";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { getAgentDir, getPackageDir, VERSION } from "./config.ts";
import { isNewerPackageVersion } from "./utils/version-check.ts";

/** Release assets are only trusted from this repository's GitHub Releases. */
export const RELEASE_DOWNLOAD_PREFIX = "https://github.com/boomytc/AmazMe/releases/download/";
export const UPDATE_MANIFEST_URL = "https://github.com/boomytc/AmazMe/releases/latest/download/latest.json";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const UpdateAssetSchema = Type.Object({ name: Type.String({ pattern: "^[A-Za-z0-9._-]+$" }), url: Type.String(), sha256: Sha256 });
/** `latest.json`, written by the release workflow's `manifest` job (scripts/release-manifest.mjs). */
const UpdateManifestSchema = Type.Object({
	version: Type.String(),
	tag: Type.String(),
	assets: Type.Array(UpdateAssetSchema),
});
const validateManifest = Compile(UpdateManifestSchema);
const UpdateCheckStateSchema = Type.Object({ checkedAt: Type.Number() });
const validateState = Compile(UpdateCheckStateSchema);

export type UpdateAsset = Static<typeof UpdateAssetSchema>;

/** A newer release. `download` is set only for a release install with an installer for this machine. */
export type UpdateNotice =
	| { readonly install: "source"; readonly version: string; readonly currentVersion: string }
	| { readonly install: "release"; readonly version: string; readonly currentVersion: string; readonly download?: UpdateAsset };

export interface UpdateCheckOptions {
	readonly currentVersion?: string;
	/** Throttle file; one check per {@link UPDATE_CHECK_INTERVAL_MS}. */
	readonly statePath?: string;
	readonly sourceCheckout?: boolean;
	/** Asset name suffix for this machine, e.g. `-macos-arm64.dmg`; undefined when no installer is published. */
	readonly assetSuffix?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly now?: () => number;
	readonly fetch?: typeof fetch;
}

/** True when this package runs from a git checkout (walks up from the package directory). */
export function isSourceCheckout(packageDir = getPackageDir()): boolean {
	for (let dir = packageDir; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return true;
		if (dirname(dir) === dir) return false;
	}
}

export function defaultAssetSuffix(platform = process.platform, arch = process.arch): string | undefined {
	if (platform !== "darwin") return undefined;
	return `-macos-${arch === "x64" ? "x86_64" : arch}.dmg`;
}

/**
 * Check GitHub Releases for a newer AmazMe. Returns undefined when offline, checked within the last
 * 24 hours, up to date, or when anything fails or does not verify. Shared by CLI, TUI and the GUI.
 */
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateNotice | undefined> {
	const env = options.env ?? process.env;
	if (env.AMAZME_OFFLINE || env.AMAZME_SKIP_VERSION_CHECK) return undefined;
	const statePath = options.statePath ?? join(getAgentDir(), "update-check.json");
	const now = (options.now ?? Date.now)();
	const last = await readState(statePath);
	if (last !== undefined && now - last.checkedAt >= 0 && now - last.checkedAt < UPDATE_CHECK_INTERVAL_MS) return undefined;
	// Recorded before the request so a failing or missing manifest is not retried on every start.
	await writeState(statePath, { checkedAt: now });
	try {
		return await fetchNotice(options);
	} catch {
		return undefined;
	}
}

async function fetchNotice(options: UpdateCheckOptions): Promise<UpdateNotice | undefined> {
	const get = options.fetch ?? fetch;
	const currentVersion = options.currentVersion ?? VERSION;
	const response = await get(UPDATE_MANIFEST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!response.ok) return undefined;
	const manifest: unknown = await response.json();
	if (!validateManifest.Check(manifest)) return undefined;
	// Any malformed field drops the whole manifest. Verifying the downloaded file's sha256 belongs to the U2 downloader.
	if (valid(manifest.version) !== manifest.version || manifest.tag !== `v${manifest.version}`) return undefined;
	const releaseDownloads = `${RELEASE_DOWNLOAD_PREFIX}${manifest.tag}/`;
	if (!manifest.assets.every((item) => item.url === `${releaseDownloads}${item.name}`)) return undefined;
	if (!isNewerPackageVersion(manifest.version, currentVersion)) return undefined;
	const base = { version: manifest.version, currentVersion };
	if (options.sourceCheckout ?? isSourceCheckout()) return { install: "source", ...base };
	const suffix = "assetSuffix" in options ? options.assetSuffix : defaultAssetSuffix();
	const asset = suffix === undefined ? undefined : manifest.assets.find((item) => item.name.endsWith(suffix));
	return asset === undefined ? { install: "release", ...base } : { install: "release", ...base, download: asset };
}

export function formatUpdateNotice(notice: UpdateNotice): string {
	const head = `AmazMe ${notice.version} 已发布（当前 ${notice.currentVersion}）。`;
	if (notice.install === "source") return `${head}源码安装请 git pull 后重新构建。`;
	if (notice.download === undefined) return head;
	return `${head}下载：${notice.download.url}（sha256 ${notice.download.sha256}）`;
}

async function readState(path: string): Promise<Static<typeof UpdateCheckStateSchema> | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return validateState.Check(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

async function writeState(path: string, state: Static<typeof UpdateCheckStateSchema>): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
		const temp = `${path}.${process.pid}.tmp`;
		await writeFile(temp, `${JSON.stringify(state)}\n`);
		await rename(temp, path);
	} catch {
		// A read-only agent directory only loses the throttle; the check itself stays optional.
	}
}
