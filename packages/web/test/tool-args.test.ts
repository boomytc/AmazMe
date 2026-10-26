import { describe, expect, test } from "vitest";
import { collapsedToolArgs, expandedToolArgs, toolArguments } from "../src/tool-args.ts";

describe("tool args digest", () => {
	test("is empty when there is nothing to show", () => {
		expect(collapsedToolArgs(undefined)).toBe("");
		expect(collapsedToolArgs(null)).toBe("");
		expect(collapsedToolArgs({})).toBe("");
		expect(expandedToolArgs({})).toBe("");
	});

	test("collapses to key=value and expands strings raw", () => {
		const args = { command: "ls", cwd: "/tmp", count: 2 };
		expect(collapsedToolArgs(args)).toBe('command="ls" cwd="/tmp" count=2');
		expect(expandedToolArgs(args)).toBe("command: ls\ncwd: /tmp\ncount: 2");
	});

	test("cuts a collapsed line instead of dumping the value", () => {
		const command = "x".repeat(400);
		const digest = collapsedToolArgs({ command, path: "/tmp/a" });
		expect(digest).toHaveLength(100);
		expect(digest.endsWith("...")).toBe(true);
		expect(digest).not.toContain(command);
		expect(digest).not.toContain("path=");
		expect(digest.includes("\n")).toBe(false);
	});

	test("pretty-prints a non-string and keeps a tabbed string readable when expanded", () => {
		expect(expandedToolArgs({ meta: { a: 1 } })).toBe('meta: {\n    "a": 1\n  }');
		expect(expandedToolArgs({ command: "a\tb\r\nc" })).toBe("command: a   b\n  c");
		expect(collapsedToolArgs(["x"])).toBe('args=["x"]');
	});

	test("the bounded entry preserves ordinary JSON, empty arguments and malformed source", () => {
		const source = '{"command":"ls","meta":{"a":1}}';
		const result = toolArguments("en", source);
		expect(result.args).toEqual({ command: "ls", meta: { a: 1 } });
		expect(result.view).toEqual({ source, collapsed: 'command="ls" meta={"a":1}', expanded: 'command: ls\nmeta: {\n    "a": 1\n  }' });
		expect(toolArguments("en", "{}").view.expanded).toBe("");
		expect(toolArguments("en", "not JSON").view.expanded).toBe("args: not JSON");
	});

	test("formatting amplification is capped and truncation preserves a complete Unicode character", () => {
		const source = JSON.stringify({ command: "\t".repeat(45_000) });
		const result = toolArguments("en", source);
		expect(source.length).toBeLessThan(100_000);
		expect(result.view.expanded.length).toBeLessThan(100_200);
		expect(result.view.expanded.endsWith("Copy parameters for the complete source.")).toBe(true);
		expect(result.view.source).toBe(source);
		const character = "\u{20000}";
		const unicode = toolArguments("zh", "x" + character.repeat(60_000)).view.expanded.split("\n\n")[0];
		expect(unicode.length).toBe(99_999);
		expect(unicode.endsWith(character)).toBe(true);
	});
});
