/**
 * @vitest-environment happy-dom
 */
import { describe, expect, test } from "vitest";
import { perfCount } from "../src/host/web/perf.ts";

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
