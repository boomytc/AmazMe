import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildManifest } from "../../../scripts/release-manifest.mjs";
import {
	checkForUpdate,
	formatUpdateNotice,
	isSourceCheckout,
	UPDATE_CHECK_INTERVAL_MS,
	UPDATE_MANIFEST_URL,
	type UpdateCheckOptions,
} from "../src/update-check.ts";
import { createTempDir } from "./temp-dir.ts";

const SHA = "a".repeat(64);
const DMG = "AmazMe-8.6.0-macos-arm64.dmg";
const DMG_URL = `https://github.com/boomytc/AmazMe/releases/download/v8.6.0/${DMG}`;
const manifest = { version: "8.6.0", tag: "v8.6.0", assets: [{ name: DMG, url: DMG_URL, sha256: SHA }] };

function server(body: unknown = manifest) {
	return vi.fn(async (input: string | URL | Request) =>
		String(input) === UPDATE_MANIFEST_URL ? Response.json(body) : new Response("missing", { status: 404 }),
	);
}

function options(fetchMock: ReturnType<typeof vi.fn>, extra: Partial<UpdateCheckOptions> = {}): UpdateCheckOptions {
	return {
		currentVersion: "8.5.0",
		statePath: join(createTempDir("amazme-update-"), "state", "update-check.json"),
		sourceCheckout: false,
		assetSuffix: "-macos-arm64.dmg",
		env: {},
		now: () => 1_000_000,
		fetch: fetchMock as unknown as typeof fetch,
		...extra,
	};
}

function withAsset(patch: Partial<(typeof manifest.assets)[number]>) {
	return { ...manifest, assets: [{ ...manifest.assets[0], ...patch }] };
}

describe("checkForUpdate", () => {
	it("offers the installer for a release install with one request", async () => {
		const fetchMock = server();
		const notice = await checkForUpdate(options(fetchMock));
		expect(notice).toEqual({ install: "release", version: "8.6.0", currentVersion: "8.5.0", download: manifest.assets[0] });
		expect(formatUpdateNotice(notice!)).toContain(DMG_URL);
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([UPDATE_MANIFEST_URL]);
	});

	it("sends no request at all when offline", async () => {
		const fetchMock = server();
		const opts = options(fetchMock, { env: { AMAZME_OFFLINE: "1" } });
		expect(await checkForUpdate(opts)).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(() => readFileSync(opts.statePath!)).toThrow();
	});

	it("notifies once and stays quiet for 24 hours", async () => {
		const fetchMock = server();
		let now = 1_000_000;
		const opts = options(fetchMock, { now: () => now });
		expect(await checkForUpdate(opts)).toBeDefined();
		now += UPDATE_CHECK_INTERVAL_MS - 1;
		expect(await checkForUpdate(opts)).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		now += 1;
		expect(await checkForUpdate(opts)).toBeDefined();
	});

	it("throttles failed checks too, so a missing manifest is not fetched on every start", async () => {
		const fetchMock = vi.fn(async () => new Response("missing", { status: 404 }));
		const opts = options(fetchMock);
		expect(await checkForUpdate(opts)).toBeUndefined();
		expect(await checkForUpdate(opts)).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("gives a source checkout a notice without any download URL", async () => {
		const notice = await checkForUpdate(options(server(), { sourceCheckout: true }));
		expect(notice).toEqual({ install: "source", version: "8.6.0", currentVersion: "8.5.0" });
		expect(formatUpdateNotice(notice!)).not.toMatch(/https?:/);
	});

	it("silently ignores a sha256 that is not 64 lowercase hex digits", async () => {
		for (const sha256 of ["A".repeat(64), "a".repeat(63), "g".repeat(64)])
			expect(await checkForUpdate(options(server(withAsset({ sha256 }))))).toBeUndefined();
	});

	it("silently ignores asset URLs outside this repository's v<version> release downloads", async () => {
		for (const url of [`https://example.com/${DMG}`, DMG_URL.replace("v8.6.0", "v8.5.9"), DMG_URL.replace("boomytc", "evil"), `${DMG_URL}?x`])
			expect(await checkForUpdate(options(server(withAsset({ url }))))).toBeUndefined();
		// A bad entry for another machine still drops the whole manifest.
		const other = { ...manifest, assets: [...manifest.assets, { name: "x.dmg", url: "https://example.com/x.dmg", sha256: SHA }] };
		expect(await checkForUpdate(options(server(other)))).toBeUndefined();
	});

	it("silently ignores invalid versions, mismatched tags and versions that are not newer", async () => {
		expect(await checkForUpdate(options(server({ version: "8.6.0" })))).toBeUndefined();
		expect(await checkForUpdate(options(server({ ...manifest, tag: "v9.9.9" })))).toBeUndefined();
		// Everything else consistent, so only the version itself is wrong.
		for (const version of ["8.6", "8.6.0.1", "latest", "08.6.0"]) {
			const url = `https://github.com/boomytc/AmazMe/releases/download/v${version}/${DMG}`;
			expect(await checkForUpdate(options(server({ version, tag: `v${version}`, assets: [{ name: DMG, url, sha256: SHA }] })))).toBeUndefined();
		}
		expect(await checkForUpdate(options(server(), { currentVersion: "8.6.0" }))).toBeUndefined();
	});

	it("notifies without a download when no installer matches this machine", async () => {
		const notice = await checkForUpdate(options(server(), { assetSuffix: undefined }));
		expect(notice).toEqual({ install: "release", version: "8.6.0", currentVersion: "8.5.0" });
	});

	it("accepts the manifest the release workflow writes", async () => {
		const written = buildManifest({ tag: "v8.6.0", repository: "boomytc/AmazMe", installers: [{ name: DMG, digest: SHA, published: `${SHA}  ${DMG}\n` }] });
		expect(written).toEqual(manifest);
		expect((await checkForUpdate(options(server(written))))?.install).toBe("release");
	});
});

describe("isSourceCheckout", () => {
	it("finds .git above the package directory", () => {
		const root = createTempDir("amazme-src-");
		const pkg = join(root, "packages", "coding-agent");
		mkdirSync(pkg, { recursive: true });
		expect(isSourceCheckout(pkg)).toBe(false);
		writeFileSync(join(root, ".git"), "gitdir: elsewhere\n");
		expect(isSourceCheckout(pkg)).toBe(true);
	});
});
