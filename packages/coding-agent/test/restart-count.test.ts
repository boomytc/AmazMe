import { describe, expect, it } from "vitest";
import {
	finiteRestartLimit,
	formatRestartCount,
} from "../src/durable/restart-count.ts";

describe("restart count", () => {
	it("pairs the count with a finite bound", () => {
		expect(finiteRestartLimit(5)).toBe(5);
		expect(formatRestartCount(3, 5)).toBe("3/5");
	});

	it("reads Infinity, null, and an absent bound as off", () => {
		for (const limit of [Number.POSITIVE_INFINITY, null, undefined]) {
			expect(finiteRestartLimit(limit)).toBeUndefined();
			expect(formatRestartCount(3, limit)).toBe("3");
		}
	});
});
