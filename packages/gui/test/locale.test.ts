import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { desktopLocale, readDesktopDocumentLanguage, readDesktopLocalePreference } from "../src/locale.ts";
import { createTempDir } from "./temp-dir.ts";

describe("desktop application language", () => {
	test("uses saved choices before the page is ready and system languages for auto", () => {
		expect(desktopLocale("zh", ["en-US"])).toBe("zh");
		expect(desktopLocale("en", ["zh-CN"])).toBe("en");
		expect(desktopLocale("auto", ["zh-Hans", "en"])).toBe("zh");
		expect(desktopLocale("auto", ["en-US", "zh"])).toBe("en");
	});
	test("follows runtime page changes without changing system languages", () => {
		expect(desktopLocale("auto", ["en-US"], "zh-Hans")).toBe("zh");
		expect(desktopLocale("auto", ["zh-CN"], "en")).toBe("en");
		expect(desktopLocale("zh", ["en"], null)).toBe("zh");
		expect(desktopLocale("zh", ["en"], "unsupported")).toBe("zh");
	});
	test("falls back promptly when document reading fails or the renderer hangs", async () => {
		expect(await readDesktopDocumentLanguage(async () => "zh-Hans")).toBe("zh-Hans");
		expect(await readDesktopDocumentLanguage(async () => { throw new Error("renderer gone"); })).toBeUndefined();
		vi.useFakeTimers();
		try {
			const hung = readDesktopDocumentLanguage(() => new Promise<unknown>(() => {}));
			await vi.advanceTimersByTimeAsync(250);
			expect(await hung).toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});
	test("uses global-only interface locale and the shared profile path normalization", async () => {
		const root = createTempDir("desktop-locale-");
		try {
			const agent = join(root, "profile with spaces");
			const project = join(root, ".amazme");
			await Promise.all([mkdir(agent), mkdir(project)]);
			const env = { AMAZME_CODING_AGENT_DIR: "profile with spaces" };
			await writeFile(join(agent, "settings.json"), JSON.stringify({ locale: "zh" }));
			expect(await readDesktopLocalePreference(root, env)).toBe("zh");
			await writeFile(join(project, "settings.json"), JSON.stringify({ locale: "en" }));
			expect(await readDesktopLocalePreference(root, env)).toBe("zh");
			expect(await readDesktopLocalePreference(root, { AMAZME_CODING_AGENT_DIR: pathToFileURL(agent).href })).toBe("zh");
			await writeFile(join(agent, "settings.json"), JSON.stringify({ locale: "en" }));
			expect(await readDesktopLocalePreference(root, env)).toBe("en");
			await writeFile(join(agent, "settings.json"), JSON.stringify({ locale: "auto" }));
			expect(await readDesktopLocalePreference(root, env)).toBe("auto");
			await writeFile(join(agent, "settings.json"), JSON.stringify({ locale: 123 }));
			expect(await readDesktopLocalePreference(root, env)).toBe("auto");
			await writeFile(join(agent, "settings.json"), "broken");
			expect(await readDesktopLocalePreference(root, env)).toBeUndefined();
			await writeFile(join(agent, "settings.json"), "[]");
			expect(await readDesktopLocalePreference(root, env)).toBeUndefined();
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
