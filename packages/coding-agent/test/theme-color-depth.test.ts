import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

type ThemeFile = {
	name: string;
	appearance?: "dark" | "light";
	requiresTruecolor?: boolean;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

/** Load a copy of the built-in dark theme with `edit` applied. */
function loadEditedTheme(edit: (theme: ThemeFile) => void) {
	const themeJson = JSON.parse(
		readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
	) as ThemeFile;
	edit(themeJson);
	const dir = mkdtempSync(join(tmpdir(), "pi-theme-depth-"));
	tempDirs.push(dir);
	const path = join(dir, `${themeJson.name}.json`);
	writeFileSync(path, JSON.stringify(themeJson));
	return loadThemeFromPath(path, "truecolor");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("theme color depth", () => {
	it("keeps neutral palettes available on indexed terminals", () => {
		expect(loadEditedTheme(() => {}).requiresTruecolor).toBe(false);
	});

	it("marks hue-heavy backgrounds as truecolor-only", () => {
		expect(
			loadEditedTheme((theme) => {
				theme.colors.userMessageBg = "#3a1a5e";
			}).requiresTruecolor,
		).toBe(true);
	});

	it("lets a theme override the inference", () => {
		expect(
			loadEditedTheme((theme) => {
				theme.colors.userMessageBg = "#3a1a5e";
				theme.requiresTruecolor = false;
			}).requiresTruecolor,
		).toBe(false);
		expect(
			loadEditedTheme((theme) => {
				theme.requiresTruecolor = true;
			}).requiresTruecolor,
		).toBe(true);
	});
});
