import { describe, expect, test } from "vitest";
import { collapsedToolArgs, expandedToolArgs } from "../src/tool-args.ts";

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
});
