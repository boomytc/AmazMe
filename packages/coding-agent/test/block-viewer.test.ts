import { describe, expect, test, beforeAll } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { BlockViewer } from "../src/modes/interactive/components/block-viewer.ts";

describe("BlockViewer", () => {
	beforeAll(() => {
		initTheme("dark", false);
	});

	test("renders the block text with a title and position", () => {
		const viewer = new BlockViewer("Block", "first line\nsecond line", () => {});
		const rendered = stripAnsi(viewer.render(40).join("\n"));

		expect(rendered).toContain("Block");
		expect(rendered).toContain("first line");
		expect(rendered).toContain("second line");
		expect(rendered).toContain("1-2/2");
	});

	test("closes on Esc, Enter, and q", () => {
		for (const key of ["\x1b", "\r", "q"]) {
			let closed = 0;
			const viewer = new BlockViewer("Block", "text", () => closed++);
			expect(viewer.handleInput(key)).toBe(true);
			expect(closed).toBe(1);
		}
	});

	test("scrolls long text and clamps at both ends", () => {
		const lines = Array.from({ length: 40 }, (_unused, index) => `line-${index}`);
		const viewer = new BlockViewer("Block", lines.join("\n"), () => {});

		const first = stripAnsi(viewer.render(40).join("\n"));
		expect(first).toContain("line-0");
		expect(first).not.toContain("line-30");

		expect(viewer.handleInput("\x1b[B")).toBe(true);
		const second = stripAnsi(viewer.render(40).join("\n"));
		expect(second).not.toContain("line-0");
		expect(second).toContain("line-1");

		expect(viewer.handleInput("\x1b[A")).toBe(true);
		expect(stripAnsi(viewer.render(40).join("\n"))).toContain("line-0");

		expect(viewer.handleInput("\x1b[A")).toBe(false);
	});
});
