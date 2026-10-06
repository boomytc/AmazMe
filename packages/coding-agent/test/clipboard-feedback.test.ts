import { stripTerminalSequences, visibleWidth } from "@amazme/tui";
import { afterEach, expect, test, vi } from "vitest";
import { ClipboardFeedback } from "../src/modes/interactive/components/clipboard-feedback.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

afterEach(() => vi.useRealTimers());

test("copy feedback is a single right-aligned line in both themes and at narrow widths", () => {
	vi.useFakeTimers();
	const feedback = new ClipboardFeedback(() => {});
	expect(feedback.render(80)).toEqual([]);
	feedback.showCopied();
	for (const name of ["dark", "light"] as const) {
		initTheme(name, false);
		for (const width of [0, 1, 4, 8, 24, 40, 80]) {
			const lines = feedback.render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0]!)).toBe(width);
			if (width >= 7) expect(stripTerminalSequences(lines[0]!)).toBe(" ".repeat(width - 7) + "Copied!");
		}
	}
	feedback.dispose();
});

test("repeated copying refreshes the timeout and disposal prevents late feedback", () => {
	vi.useFakeTimers();
	initTheme("dark", false);
	const requestRender = vi.fn();
	const feedback = new ClipboardFeedback(requestRender);
	feedback.showCopied();
	vi.advanceTimersByTime(1000);
	feedback.showCopied();
	vi.advanceTimersByTime(1000);
	expect(feedback.render(80)).toHaveLength(1);
	vi.advanceTimersByTime(500);
	expect(feedback.render(80)).toEqual([]);
	expect(requestRender).toHaveBeenCalledTimes(3);
	feedback.showCopied();
	feedback.dispose();
	feedback.showCopied();
	vi.advanceTimersByTime(2000);
	expect(feedback.render(80)).toEqual([]);
	expect(requestRender).toHaveBeenCalledTimes(4);
});
