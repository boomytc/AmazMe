import { describe, expect, test, vi } from "vitest";
import { desktopUpdateAsset, githubReleaseResponse, isNewerRelease, parseUpdateManifest } from "../src/update-manifest.ts";

const asset = { name: "AmazMe-8.6.0-macos-arm64.dmg", url: "https://github.com/boomytc/AmazMe/releases/download/v8.6.0/AmazMe-8.6.0-macos-arm64.dmg", sha256: "c".repeat(64), size: 3, platform: "darwin", arch: "arm64" };
const manifest = { version: "8.6.0", tag: "v8.6.0", assets: [asset] };
describe("shared release contract", () => {
	test("GUI requires explicit platform, architecture and size", () => {
		expect(desktopUpdateAsset(parseUpdateManifest(manifest), "8.5.0", "stable", "darwin", "arm64")).toEqual(asset);
		expect(() => desktopUpdateAsset(parseUpdateManifest({ ...manifest, assets: [{ name: asset.name, url: asset.url, sha256: asset.sha256 }] }), "8.5.0", "stable", "darwin", "arm64")).toThrow("unsupported");
		expect(() => desktopUpdateAsset(parseUpdateManifest(manifest), "8.5.0", "stable", "darwin", "x64")).toThrow("unsupported");
	});
	test("version reset never weakens downgrade or equal-version protection", () => {
		expect(isNewerRelease("8.0.0", "8.5.0")).toBe(false); expect(isNewerRelease("8.0.0", "8.0.0")).toBe(false);
		expect(isNewerRelease("8.0.1", "8.0.0")).toBe(true); expect(isNewerRelease("8.0.0-rc.2", "8.0.0-rc.1")).toBe(true);
		expect(desktopUpdateAsset(parseUpdateManifest(manifest), "8.6.0", "stable", "darwin", "arm64")).toBeUndefined();
	});
	test.each([{ ...asset, url: "http://github.com/download" }, { ...asset, url: asset.url + "?token=x" }, { ...asset, size: -1 }, { ...asset, sha256: "garbage" }, { ...asset, arch: "intel" }])("rejects malformed metadata", bad => { expect(() => parseUpdateManifest({ ...manifest, assets: [bad] })).toThrow("manifest"); });
	test("rejects duplicate names and mismatched tag/version", () => {
		expect(() => parseUpdateManifest({ ...manifest, assets: [asset, asset] })).toThrow("manifest");
		expect(() => parseUpdateManifest({ ...manifest, tag: "v8.5.0" })).toThrow("manifest");
	});
});
describe("HTTPS redirect boundaries", () => {
	test.each(["http://github.com/asset", "https://127.0.0.1/file", "https://example.com/file", "https://github.com:444/file", "https://user@github.com/file", "file:///tmp/update"])("rejects redirect to %s before a second request", async target => {
		const get = vi.fn(async () => new Response(null, { status: 302, headers: { location: target } })) as unknown as typeof fetch;
		await expect(githubReleaseResponse(asset.url, new AbortController().signal, get)).rejects.toThrow("source"); expect(get).toHaveBeenCalledTimes(1);
	});
	test("allows the real release CDN and bounds redirect loops", async () => {
		const get = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/asset?signature=private" } })).mockResolvedValueOnce(new Response("dmg")) as unknown as typeof fetch;
		expect(await (await githubReleaseResponse(asset.url, new AbortController().signal, get)).text()).toBe("dmg");
		const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: asset.url } })) as unknown as typeof fetch;
		await expect(githubReleaseResponse(asset.url, new AbortController().signal, loop)).rejects.toThrow("source"); expect(loop).toHaveBeenCalledTimes(6);
	});
});
