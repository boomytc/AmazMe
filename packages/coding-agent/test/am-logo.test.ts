import { visibleWidth } from "@amazme/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { amLogoCellWidth, amLogoLines, AM_LOGO_ROWS, amWordmark } from "../src/modes/interactive/components/am-logo.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function plain(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("AM logo", () => {
	beforeAll(() => initTheme("dark"));

	test("the wordmark reads AM and the block mark is ten cells wide", () => {
		expect(plain(amWordmark())).toBe("AM");
		expect(amLogoCellWidth).toBe(10);
		expect(AM_LOGO_ROWS).toEqual([".cc..y...y", "c..c.yy.yy", "cccc.y.y.y", "c..c.y...y"]);
		const [top, bottom] = amLogoLines();
		expect(visibleWidth(top)).toBe(10);
		expect(visibleWidth(bottom)).toBe(10);
		expect(plain(top)).toContain("▀");
		expect(plain(bottom)).toContain("█");
	});
});
