import { describe, expect, test } from "vitest";
import { chatRowLineRange, turnStartLines } from "../src/modes/interactive/transcript-geometry.ts";

function block(lines: number, name: string) {
	return {
		name,
		render: () => Array.from({ length: lines }, (_unused, index) => `${name}-${index}`),
	};
}

describe("chatRowLineRange", () => {
	test("adds the document sections painted before the chat container", () => {
		const header = block(2, "header");
		const resources = block(3, "resources");
		const chat = block(0, "chat");
		const rows = [block(4, "a"), block(6, "b"), block(2, "c")];

		expect(chatRowLineRange([header, resources, chat], chat, rows, 0, 80)).toEqual({ start: 5, height: 4 });
		expect(chatRowLineRange([header, resources, chat], chat, rows, 1, 80)).toEqual({ start: 9, height: 6 });
		expect(chatRowLineRange([header, resources, chat], chat, rows, 2, 80)).toEqual({ start: 15, height: 2 });
	});

	test("rejects out-of-range rows and empty widths", () => {
		const chat = block(0, "chat");
		const rows = [block(1, "a")];

		expect(chatRowLineRange([chat], chat, rows, -1, 80)).toBeUndefined();
		expect(chatRowLineRange([chat], chat, rows, 1, 80)).toBeUndefined();
		expect(chatRowLineRange([chat], chat, rows, 0, 0)).toBeUndefined();
	});

	test("returns undefined when the chat container is not in the document", () => {
		const chat = block(0, "chat");
		expect(chatRowLineRange([block(1, "other")], chat, [block(1, "a")], 0, 80)).toBeUndefined();
	});
});

describe("turnStartLines", () => {
	test("returns one offset per prompt in document order", () => {
		const header = block(2, "header");
		const chat = block(0, "chat");
		const first = { render: () => ["a", "b"], transcriptTurnStart: true };
		const answer = block(3, "answer");
		const second = { render: () => ["c"], transcriptTurnStart: true };
		const after = block(2, "after");

		expect(turnStartLines([header, chat], chat, [first, answer, second, after], 80)).toEqual([2, 7]);
	});

	test("ignores width zero and returns no turns for a document without the chat", () => {
		const chat = block(0, "chat");
		const rows = [{ render: () => ["a"], transcriptTurnStart: true }];

		expect(turnStartLines([chat], chat, rows, 0)).toEqual([]);
		expect(turnStartLines([block(1, "other")], chat, rows, 80)).toEqual([]);
	});
});
