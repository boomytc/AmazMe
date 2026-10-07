import { describe, expect, test } from "vitest";
import { attentionOnTitle, pendingApprovalCount, shouldFlashFrame } from "../src/title.ts";

describe("pendingApprovalCount", () => {
	test("reads a leading canonical count and ignores the rest of the title", () => {
		expect(pendingApprovalCount("(1) Weekly report — AmazMe")).toBe(1);
		expect(pendingApprovalCount("(2) Plan (draft) — AmazMe")).toBe(2);
		expect(pendingApprovalCount("(12) Notes (3) left — AmazMe")).toBe(12);
		expect(pendingApprovalCount("(1000000) Quarterly (Q4) review — AmazMe")).toBe(1_000_000);
		expect(pendingApprovalCount(`(${Number.MAX_SAFE_INTEGER}) session — AmazMe`)).toBe(Number.MAX_SAFE_INTEGER);
	});

	test("treats a missing prefix as no pending approvals", () => {
		expect(pendingApprovalCount("Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("AmazMe 1.0.4")).toBe(0);
		expect(pendingApprovalCount("AmazMe")).toBe(0);
		expect(pendingApprovalCount("")).toBe(0);
		expect(pendingApprovalCount("Plan (draft) — AmazMe")).toBe(0);
		expect(pendingApprovalCount("Notes (1) — AmazMe")).toBe(0);
		expect(pendingApprovalCount(" (2) Weekly report — AmazMe")).toBe(0);
	});

	test("treats (0) as none", () => {
		expect(pendingApprovalCount("(0) Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("(0) Plan (draft) — AmazMe")).toBe(0);
	});

	test("rejects a prefix that is not a canonical count", () => {
		expect(pendingApprovalCount("(00) Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("(01) Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("(-1) Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("(+1) Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("(1.5) Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("( 2) Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("(2 ) Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("(2)Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("(n) Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("() Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("(2")).toBe(0);
		expect(pendingApprovalCount("((2)) Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount("(1e2) Weekly report — AmazMe")).toBe(0);
		expect(pendingApprovalCount(`(${Number.MAX_SAFE_INTEGER + 1}) Weekly report — AmazMe`)).toBe(0);
		expect(pendingApprovalCount(`(${"9".repeat(40)}) Weekly report — AmazMe`)).toBe(0);
		expect(pendingApprovalCount("(2)\u00A0Weekly report — AmazMe")).toBe(0);
	});
});

describe("shouldFlashFrame", () => {
	test("flashes only on the rise from none to some while the window is unfocused", () => {
		expect(shouldFlashFrame(0, 1, false)).toBe(true);
		expect(shouldFlashFrame(0, 40, false)).toBe(true);
		expect(shouldFlashFrame(0, 1, true)).toBe(false);
		expect(shouldFlashFrame(1, 2, false)).toBe(false);
		expect(shouldFlashFrame(2, 2, false)).toBe(false);
		expect(shouldFlashFrame(2, 0, false)).toBe(false);
		expect(shouldFlashFrame(0, 0, false)).toBe(false);
	});
});

describe("attentionOnTitle", () => {
	test("a session renamed to look like a count does not flash, and a later real approval does", () => {
		const renamed = "\uFF083\uFF09 x — AmazMe";
		expect(pendingApprovalCount(renamed)).toBe(0);
		expect(pendingApprovalCount("(3) x — AmazMe")).toBe(3);

		const idle = attentionOnTitle(0, renamed, false);
		expect(idle).toEqual({ pending: 0, flash: undefined });

		const waiting = attentionOnTitle(idle.pending, "(1) \uFF083\uFF09 x — AmazMe", false);
		expect(waiting).toEqual({ pending: 1, flash: true });
	});

	test("stops the flash when the count returns to 0 before focus", () => {
		const started = attentionOnTitle(0, "(2) Weekly report — AmazMe", false);
		expect(started).toEqual({ pending: 2, flash: true });

		const cleared = attentionOnTitle(started.pending, "Weekly report — AmazMe", false);
		expect(cleared).toEqual({ pending: 0, flash: false });

		const again = attentionOnTitle(cleared.pending, "(1) Weekly report — AmazMe", false);
		expect(again).toEqual({ pending: 1, flash: true });
	});
});
