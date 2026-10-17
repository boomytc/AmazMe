import { describe, expect, test } from "vitest";
import { TranscriptFocus } from "../src/modes/interactive/transcript-focus.ts";
import { deriveTranscriptRows, type TranscriptRowSource } from "../src/modes/interactive/transcript-model.ts";

class Row implements TranscriptRowSource {
	readonly transcriptRowId: string;
	readonly transcriptTurnStart?: boolean;
	readonly transcriptRowText?: () => string | undefined;
	expanded = false;
	opened = 0;
	constructor(id: string, options: { turnStart?: boolean; text?: string } = {}) {
		this.transcriptRowId = id;
		this.transcriptTurnStart = options.turnStart;
		this.transcriptRowText = () => options.text;
	}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	open(): void {
		this.opened++;
	}
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const RIGHT = "\x1b[C";
const CTRL_SHIFT_DOWN = "\x1b[1;6B";
const CTRL_SHIFT_UP = "\x1b[1;6A";
const CTRL_E = "\x05";
const CTRL_X = "\x18";

function harness() {
	const first = new Row("p1", { turnStart: true, text: "first prompt" });
	const answer = new Row("a1", { text: "first answer" });
	const second = new Row("p2", { turnStart: true, text: "second prompt" });
	const scrolls: number[] = [];
	const highlights: (string | undefined)[] = [];
	const copies: string[] = [];
	let openChild = 0;
	const focus = new TranscriptFocus(
		(lines) => scrolls.push(lines),
		() => deriveTranscriptRows([first, answer, second], [{ id: "child" }], () => openChild++),
		10,
		{ onHighlight: (childId) => highlights.push(childId), onCopy: (text) => copies.push(text) },
	);
	return { first, answer, second, focus, scrolls, highlights, copies, opened: () => openChild };
}

describe("TranscriptFocus", () => {
	test("Tab enters the transcript and highlights the selection", () => {
		const { focus, highlights } = harness();

		expect(focus.focus).toBe("prompt");
		expect(focus.handleInput("\t")).toBe(true);
		expect(focus.focus).toBe("scrollback");
		expect(focus.selected).toBe(0);
		expect(highlights).toEqual([undefined]);

		expect(focus.handleInput("\t")).toBe(true);
		expect(focus.focus).toBe("prompt");
	});

	test("ignores selection keys while the prompt has focus", () => {
		const { focus } = harness();

		expect(focus.handleInput(DOWN)).toBe(false);
		expect(focus.handleInput(CTRL_X)).toBe(false);
	});

	test("moves the selection and folds with left and right", () => {
		const { focus, first, answer } = harness();
		focus.handleInput("\t");

		expect(focus.handleInput(DOWN)).toBe(true);
		expect(focus.selected).toBe(1);

		expect(focus.handleInput(RIGHT)).toBe(true);
		expect(answer.expanded).toBe(true);
		expect(focus.handleInput("\x1b[D")).toBe(true);
		expect(answer.expanded).toBe(false);

		focus.handleInput(UP);
		expect(focus.selected).toBe(0);
		expect(first.expanded).toBe(false);
	});

	test("jumps between prompts with the prompt bindings", () => {
		const { focus } = harness();
		focus.handleInput("\t");

		expect(focus.handleInput(CTRL_SHIFT_DOWN)).toBe(true);
		expect(focus.selected).toBe(2);
		expect(focus.handleInput(CTRL_SHIFT_UP)).toBe(true);
		expect(focus.selected).toBe(0);
	});

	test("opens the selected child agent and highlights its id", () => {
		const { focus, highlights, opened } = harness();
		focus.handleInput("\t");
		focus.handleInput("\x1b[B");
		focus.handleInput("\x1b[B");
		focus.handleInput("\x1b[B");

		expect(focus.handleInput("\r")).toBe(true);
		expect(opened()).toBe(1);
		expect(highlights.at(-1)).toBe("child");
	});

	test("toggles every entry with the fold-all binding", () => {
		const { focus, first, answer, second } = harness();
		focus.handleInput("\t");

		expect(focus.handleInput(CTRL_E)).toBe(true);
		expect([first.expanded, answer.expanded, second.expanded]).toEqual([true, true, true]);
		expect(focus.handleInput(CTRL_E)).toBe(true);
		expect([first.expanded, answer.expanded, second.expanded]).toEqual([false, false, false]);
	});

	test("copies the selected row text", () => {
		const { focus, copies } = harness();
		focus.handleInput("\t");

		expect(focus.handleInput(CTRL_X)).toBe(true);
		expect(copies).toEqual(["first prompt"]);

		focus.handleInput(DOWN);
		focus.handleInput(CTRL_X);
		expect(copies).toEqual(["first prompt", "first answer"]);
	});

	test("scrolls pages in both focus states", () => {
		const { focus, scrolls } = harness();

		expect(focus.handleInput("\x1b[5~")).toBe(true);
		expect(focus.handleInput("\x1b[6~")).toBe(true);
		expect(scrolls).toEqual([-10, 10]);
	});
});
