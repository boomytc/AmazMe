import { describe, expect, test } from "vitest";
import { adjustedFontSizes, DEFAULT_TYPOGRAPHY, normalizeFontFamily, resolveTypography, typographyStyles, validateTypography } from "../src/typography.ts";

describe("graphical typography", () => {
	test("normalizes font lists without accepting CSS declarations", () => {
		expect(normalizeFontFamily(' "Fira Code",  PingFang SC, Fira Code ')).toBe("Fira Code, PingFang SC");
		expect(normalizeFontFamily("   ")).toBe("");
		for (const value of ["one; color: red", "url(https://outside.example/font)", "font\nname", "one,,two", "a".repeat(257)]) {
			expect(() => normalizeFontFamily(value)).toThrow();
		}
		expect(typographyStyles({ ...DEFAULT_TYPOGRAPHY, codeFont: "Fira Code, PingFang SC" })["--font-code"])
			.toBe('"Fira Code", "PingFang SC", var(--font-mono)');
	});

	test("validates writes while recovering hand-edited fields independently", () => {
		for (const patch of [{ textSize: 9 }, { codeSize: 17 }, { terminalSize: 21 }, { textSize: 15.5 }, { textSize: NaN }]) {
			expect(() => validateTypography(patch)).toThrow();
		}
		expect(resolveTypography({ textFont: "Fira Sans", codeSize: 17, terminalSize: 16 })).toEqual({
			...DEFAULT_TYPOGRAPHY, textFont: "Fira Sans", terminalSize: 16,
		});
	});

	test("adjusts each size within its own bounds and resets only sizes", () => {
		expect(adjustedFontSizes({ ...DEFAULT_TYPOGRAPHY, textSize: 22, codeSize: 15, terminalSize: 20 }, "increase"))
			.toEqual({ textSize: 22, codeSize: 16, terminalSize: 20 });
		expect(adjustedFontSizes({ ...DEFAULT_TYPOGRAPHY, textSize: 10, codeSize: 10, terminalSize: 10 }, "decrease"))
			.toEqual({ textSize: 10, codeSize: 10, terminalSize: 10 });
		expect(adjustedFontSizes({ ...DEFAULT_TYPOGRAPHY, textFont: "Fira Sans", textSize: 22 }, "reset"))
			.toEqual({ textSize: 15, codeSize: 13, terminalSize: 12 });
	});
});
