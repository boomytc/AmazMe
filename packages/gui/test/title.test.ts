import { describe, expect, test } from "vitest";
import { pendingApprovalCount, shouldFlashFrame } from "../src/title.ts";

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
