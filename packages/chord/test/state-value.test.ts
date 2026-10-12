import { describe, expect, it } from "vitest";
import { track } from "../src/delta/index.ts";

describe("immutable revision ownership", () => {
	it("commits transaction copies in place while sharing unchanged branches", () => {
		const tracker = track({ changed: { value: 1 }, retained: { value: 2 } });
		const base = tracker.value;
		const baseSnapshot = structuredClone(base);
		const change = tracker.beginChange();
		change.state.changed.value = 3;
		const prepared = change.prepare();
		expect(prepared.value.changed).not.toBe(base.changed);
		expect(prepared.value.retained).toBe(base.retained);
		expect(Object.isFrozen(prepared.value.changed)).toBe(false);
		tracker.adopt(prepared);
		expect(base).toEqual(baseSnapshot);
		expect(tracker.value).toBe(prepared.value);
	});
});
