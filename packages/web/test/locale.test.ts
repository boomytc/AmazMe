import { describe, expect, test } from "vitest";
import { documentLanguage, isLocale, LOCALES, matchLocale, resolveLocale } from "../src/locale.ts";

describe("locale resolution", () => {
	test("matches a browser's languages by full tag and then primary subtag", () => {
		expect(matchLocale(["zh-CN"])).toBe("zh");
		expect(matchLocale(["zh-Hans", "en"])).toBe("zh");
		expect(matchLocale(["en-US"])).toBe("en");
		// A browser asking for neither shipped language gets the fallback, as DSH does.
		expect(matchLocale(["fr-FR", "de"])).toBe("en");
		expect(matchLocale([])).toBe("en");
	});

	test("prefers the stored preference over the browser and follows the browser for auto", () => {
		expect(resolveLocale("zh", ["en-US"])).toBe("zh");
		expect(resolveLocale("en", ["zh-CN"])).toBe("en");
		expect(resolveLocale("auto", ["zh-CN"])).toBe("zh");
		expect(resolveLocale(undefined, ["zh-CN"])).toBe("zh");
		// A stored value this build does not ship is ignored rather than half-applied.
		expect(resolveLocale("ja", ["en-US"])).toBe("en");
	});

	test("lists the shipped languages and recognizes one", () => {
		expect(LOCALES).toEqual(["zh", "en"]);
		expect(isLocale("zh")).toBe(true);
		expect(isLocale("en")).toBe(true);
		// `auto` is the stored preference, not a shipped language.
		expect(isLocale("auto")).toBe(false);
		expect(isLocale("ja")).toBe(false);
	});

	test("names the document language per shipped language", () => {
		expect(documentLanguage("zh")).toBe("zh-Hans");
		expect(documentLanguage("en")).toBe("en");
	});
});
