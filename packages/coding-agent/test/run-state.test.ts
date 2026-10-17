import { describe, expect, test } from "vitest";
import { deriveRunState, formatRunState } from "../src/modes/interactive/run-state.ts";

describe("deriveRunState", () => {
	test("maps program status to a phase and clamps counts", () => {
		expect(deriveRunState({ program: { state: "idle" }, queueDepth: 0, subagents: 0 })).toEqual({
			phase: "idle",
			queueDepth: 0,
			subagents: 0,
		});
		expect(deriveRunState({ program: { state: "working" }, queueDepth: 2, subagents: 1 }).phase).toBe("working");
		expect(deriveRunState({ program: { state: "idle" }, queueDepth: -3, subagents: Number.NaN })).toMatchObject({
			queueDepth: 0,
			subagents: 0,
		});
	});

	test("treats finished and cleared statuses as idle", () => {
		for (const state of ["done", "error", "clear"] as const) {
			expect(deriveRunState({ program: { state }, queueDepth: 0, subagents: 0 }).phase).toBe("idle");
		}
	});

	test("records what a blocked run waits for, defaulting to approval", () => {
		expect(deriveRunState({ program: { state: "blocked", kind: "question" }, queueDepth: 0, subagents: 0 })).toMatchObject({
			phase: "blocked",
			waitingFor: "question",
		});
		expect(deriveRunState({ program: { state: "blocked" }, queueDepth: 0, subagents: 0 })).toMatchObject({
			waitingFor: "permission",
		});
	});
});

describe("formatRunState", () => {
	test("joins the working line with queue and subagent counts", () => {
		expect(formatRunState({ phase: "working", queueDepth: 0, subagents: 0 })).toBe("working");
		expect(formatRunState({ phase: "working", queueDepth: 2, subagents: 1 })).toBe("working · 2 queued · 1 subagent");
		expect(formatRunState({ phase: "working", queueDepth: 1, subagents: 3 })).toBe("working · 1 queued · 3 subagents");
	});

	test("reports pending work while idle", () => {
		expect(formatRunState({ phase: "idle", queueDepth: 1, subagents: 0 })).toBe("1 queued");
		expect(formatRunState({ phase: "idle", queueDepth: 0, subagents: 2 })).toBe("2 subagents");
		expect(formatRunState({ phase: "idle", queueDepth: 0, subagents: 0 })).toBeUndefined();
	});

	test("names the blocked reason instead of the queue", () => {
		expect(formatRunState({ phase: "blocked", waitingFor: "permission", queueDepth: 3, subagents: 1 })).toBe(
			"waiting for approval",
		);
		expect(formatRunState({ phase: "blocked", waitingFor: "question", queueDepth: 0, subagents: 0 })).toBe(
			"waiting for your answer",
		);
		expect(formatRunState({ phase: "blocked", waitingFor: "auth", queueDepth: 0, subagents: 0 })).toBe(
			"waiting for sign-in",
		);
	});
});
