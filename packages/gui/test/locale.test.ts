import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { isLocale, matchLocale, resolveLocale, shellLocale } from "../src/locale.ts";
import { translate } from "../src/strings.ts";

const sourceDir = fileURLToPath(new URL("../src/", import.meta.url));
const HAN = /\p{Script=Han}/u;

describe("shell locale", () => {
	test("matches an OS language list by full tag and then primary subtag", () => {
		expect(matchLocale(["zh-CN"])).toBe("zh");
		expect(matchLocale(["zh-Hans", "en"])).toBe("zh");
		expect(matchLocale(["en-US"])).toBe("en");
		expect(matchLocale(["fr-FR", "de"])).toBe("en");
		expect(matchLocale([])).toBe("en");
	});

	test("uses a shipped preference and otherwise the OS list", () => {
		expect(resolveLocale("zh", ["en-US"])).toBe("zh");
		expect(resolveLocale("en", ["zh-CN"])).toBe("en");
		expect(resolveLocale("auto", ["zh-CN"])).toBe("zh");
		expect(resolveLocale(undefined, ["zh-CN"])).toBe("zh");
		expect(resolveLocale("ja", ["en-US"])).toBe("en");
	});

	test("the shell has no stored preference, so it follows the OS list", () => {
		expect(shellLocale(["zh-CN", "en-US"])).toBe("zh");
		expect(shellLocale(["en-US"])).toBe("en");
		expect(shellLocale([])).toBe("en");
		expect(isLocale("zh")).toBe(true);
		expect(isLocale("auto")).toBe(false);
	});

	test("catalog lookup is the only place Chinese copy lives", () => {
		expect(translate("zh", "dialog.reload")).toBe("重新加载");
		expect(translate("en", "dialog.reload")).toBe("Reload");
		expect(translate("zh", "dialog.quit")).toBe("退出");
		expect(translate("en", "dialog.quit")).toBe("Quit");
		const files = readdirSync(sourceDir).filter((name) => name.endsWith(".ts") && name !== "strings.ts");
		expect(files.length).toBeGreaterThan(0);
		for (const name of files) {
			const text = readFileSync(join(sourceDir, name), "utf8");
			expect(HAN.test(text), name).toBe(false);
		}
	});
});
