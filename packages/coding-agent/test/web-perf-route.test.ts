/**
 * @vitest-environment happy-dom
 */
import { describe, expect, test } from "vitest";
import { perfCount, perfRequest } from "../src/host/web/perf.ts";

describe("perf route", () => {
	test("reads a positive block count and caps it", () => {
		expect(perfCount("http://127.0.0.1:5000/?perf=800")).toBe(800);
		expect(perfCount("http://127.0.0.1:5000/?perf=9999")).toBe(5000);
	});

	test("ignores missing and invalid counts", () => {
		expect(perfCount("http://127.0.0.1:5000/")).toBeUndefined();
		expect(perfCount("http://127.0.0.1:5000/?perf=0")).toBeUndefined();
		expect(perfCount("http://127.0.0.1:5000/?perf=-5")).toBeUndefined();
		expect(perfCount("http://127.0.0.1:5000/?perf=abc")).toBeUndefined();
		expect(perfCount("not a url")).toBeUndefined();
	});
});

describe("perf opt-in", () => {
	const storage = (value: string | null) => ({ getItem: () => value });

	test("requires the flag before honoring a count", () => {
		expect(perfRequest("http://127.0.0.1:5000/?perf=800", undefined)).toBeUndefined();
		expect(perfRequest("http://127.0.0.1:5000/?perf=800", storage(null))).toBeUndefined();
		expect(perfRequest("http://127.0.0.1:5000/?perf=800", storage("0"))).toBeUndefined();
		expect(perfRequest("http://127.0.0.1:5000/?perf=800", storage("1"))).toBe(800);
	});

	test("a throwing storage disables the route", () => {
		expect(perfRequest("http://127.0.0.1:5000/?perf=800", { getItem: () => { throw new Error("blocked"); } })).toBeUndefined();
	});
});
