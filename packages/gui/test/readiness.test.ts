import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createReadinessParser, extractWebUrl, WEB_READY_PREFIX } from "../src/readiness.ts";

describe("extractWebUrl", () => {
	test("reads the canonical launch line", () => {
		expect(extractWebUrl("Web: http://127.0.0.1:4310/")).toBe("http://127.0.0.1:4310/");
	});

	test("keeps the loopback URL when the line has a suffix", () => {
		expect(extractWebUrl("Web: http://127.0.0.1:4310/ lan=http://10.0.0.1:4310/")).toBe(
			"http://127.0.0.1:4310/",
		);
	});

	test("ignores unrelated host output", () => {
		expect(extractWebUrl("Mode: source")).toBeUndefined();
		expect(extractWebUrl("WebSocket: ws://127.0.0.1:4310/amazme")).toBeUndefined();
		expect(extractWebUrl("Server: abc (started)")).toBeUndefined();
	});

	test("ignores a second URL on the same line", () => {
		expect(extractWebUrl("Web: http://127.0.0.1:4310/ see http://example.com")).toBe(
			"http://127.0.0.1:4310/",
		);
	});

	test("rejects a launch line that is not the loopback page", () => {
		expect(() => extractWebUrl("Web: http://example.com/")).toThrow(/loopback/);
		expect(() => extractWebUrl("Web: not a url")).toThrow(/invalid/);
		expect(() => extractWebUrl("Web: ")).toThrow(/no URL/);
	});
});

describe("createReadinessParser", () => {
	test("rescans a launch line split across chunks", () => {
		const parser = createReadinessParser();
		expect(parser.push("Mode: source\nWeb: http://127.0.0.")).toBeUndefined();
		expect(parser.push("1:4310/\n")).toBe("http://127.0.0.1:4310/");
	});

	test("accepts a launch line that never received a newline", () => {
		const parser = createReadinessParser();
		expect(parser.push("Web: http://127.0.0.1:9/")).toBeUndefined();
		expect(parser.finalize()).toBe("http://127.0.0.1:9/");
	});

	test("rejects conflicting launch URLs and a stream with none", () => {
		const parser = createReadinessParser();
		parser.push("Web: http://127.0.0.1:1/\n");
		expect(() => parser.push("Web: http://127.0.0.1:2/\n")).toThrow(/conflicting/);
		expect(() => createReadinessParser().finalize()).toThrow(/exited before/);
	});

	test("uses the prefix the web host prints", () => {
		const source = readFileSync(
			new URL("../../coding-agent/src/experimental/commands.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain(`\`${WEB_READY_PREFIX}\${host.url}\``);
	});
});
