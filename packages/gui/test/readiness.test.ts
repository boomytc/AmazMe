import { describe, expect, test } from "vitest";
import { createReadinessParser } from "../src/readiness.ts";
import { pythonReadyLine } from "./fake-host.ts";

describe("createReadinessParser", () => {
	test("does not accept the retired TS host launch protocol", () => {
		const parser = createReadinessParser();
		expect(parser.push("Web: http://127.0.0.1:4310/\n")).toBeUndefined();
		expect(parser.pythonReady()).toBeUndefined();
		expect(() => parser.finalize()).toThrow(/exited before/);
	});

	test("rescans a launch line split across chunks", () => {
		const parser = createReadinessParser();
		const line = pythonReadyLine(4310);
		expect(parser.push(`Mode: source\nWebSocket: ws://127.0.0.1:4310/amazme\n${line.slice(0, 25)}`)).toBeUndefined();
		expect(parser.push(`${line.slice(25)}\n`)).toBe("http://127.0.0.1:4310/");
		expect(parser.pythonReady()).toMatchObject({ pageUrl: "http://127.0.0.1:4310/", profileId: "fixture" });
	});

	test("accepts a launch line that never received a newline", () => {
		const parser = createReadinessParser();
		expect(parser.push(pythonReadyLine(9))).toBeUndefined();
		expect(parser.finalize()).toBe("http://127.0.0.1:9/");
	});

	test("rejects conflicting launch URLs and a stream with none", () => {
		const parser = createReadinessParser();
		parser.push(`${pythonReadyLine(1)}\n`);
		expect(() => parser.push(`${pythonReadyLine(2)}\n`)).toThrow(/conflicting/);
		expect(() => createReadinessParser().finalize()).toThrow(/exited before/);
	});
});
