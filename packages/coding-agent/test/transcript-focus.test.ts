import { describe, expect, test } from "vitest";
import { TranscriptFocus } from "../src/modes/interactive/transcript-focus.ts";
import { deriveTranscriptRows, type TranscriptRowSource } from "../src/modes/interactive/transcript-model.ts";

class Row implements TranscriptRowSource {
	readonly transcriptRowId: string;
	readonly transcriptTurnStart?: boolean;
	readonly transcriptRowText?: () => string | undefined;
	expanded = false;
	opened = 0;
	selected = false;
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
	setSelected(selected: boolean): void {
		this.selected = selected;
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
	const revealed: number[] = [];
	const viewed: string[] = [];
	let openChild = 0;
	const focus = new TranscriptFocus(
		(lines) => scrolls.push(lines),
		() => deriveTranscriptRows([first, answer, second], [{ id: "child" }], () => openChild++),
		10,
		{
			onHighlight: (childId) => highlights.push(childId),
			onCopy: (text) => copies.push(text),
			onRowSelected: (childIndex) => revealed.push(childIndex),
			onViewText: (text) => viewed.push(text),
		},
	);
	return { first, answer, second, focus, scrolls, highlights, copies, revealed, viewed, opened: () => openChild };
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

	test("marks exactly one row while the transcript owns the keyboard", () => {
		const { focus, first, answer } = harness();

		focus.handleInput("\t");
		expect([first.selected, answer.selected]).toEqual([true, false]);

		focus.handleInput(DOWN);
		expect([first.selected, answer.selected]).toEqual([false, true]);

		focus.handleInput("\t");
		expect([first.selected, answer.selected]).toEqual([false, false]);

		focus.handleInput("\t");
		expect([first.selected, answer.selected]).toEqual([false, true]);
		focus.handleInput("\x1b");
		expect([first.selected, answer.selected]).toEqual([false, false]);
	});

	test("opens a selected block's text, but prefers the child-agent action", () => {
		const viewed: string[] = [];
		let opened = 0;
		const plain = { transcriptRowId: "p1", transcriptTurnStart: true, transcriptRowText: () => "first prompt" };
		const focus = new TranscriptFocus(
			() => {},
			() => deriveTranscriptRows([plain], [{ id: "child" }], () => opened++),
			10,
			{ onViewText: (text) => viewed.push(text) },
		);
		focus.handleInput("\t");

		expect(focus.handleInput("\r")).toBe(true);
		expect(viewed).toEqual(["first prompt"]);

		focus.handleInput("\x1b[B");
		expect(focus.handleInput("\r")).toBe(true);
		expect(opened).toBe(1);
		expect(viewed).toEqual(["first prompt"]);
	});

	test("searches rows and cycles through matches", () => {
		const { focus, revealed } = harness();

		expect(focus.search("prompt")).toEqual({ index: 1, total: 2 });
		expect(focus.selected).toBe(0);
		expect(revealed.at(-1)).toBe(0);

		expect(focus.searchNext(1)).toBe(true);
		expect(focus.searchProgress()).toEqual({ query: "prompt", index: 2, total: 2 });
		expect(revealed.at(-1)).toBe(2);

		expect(focus.searchNext(1)).toBe(true);
		expect(focus.selected).toBe(0);
		expect(focus.searchNext(-1)).toBe(true);
		expect(focus.selected).toBe(2);
	});

	test("reports no matches without moving the selection", () => {
		const { focus, revealed } = harness();
		focus.handleInput("\t");
		const before = focus.selected;
		const reveals = revealed.length;

		expect(focus.search("missing")).toEqual({ index: 0, total: 0 });
		expect(focus.selected).toBe(before);
		expect(revealed.length).toBe(reveals);
		expect(focus.searchProgress()).toEqual({ query: "missing", index: 0, total: 0 });
		expect(focus.searchNext(1)).toBe(false);
	});

	test("cycles matches with the n and shift+n bindings", () => {
		const { focus } = harness();
		focus.search("prompt");

		expect(focus.handleInput("n")).toBe(true);
		expect(focus.selected).toBe(2);
		expect(focus.handleInput("N")).toBe(true);
		expect(focus.selected).toBe(0);
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

	test("Esc leaves the transcript for the prompt", () => {
		const { focus } = harness();
		focus.handleInput("\t");
		expect(focus.focus).toBe("scrollback");

		expect(focus.handleInput("\x1b")).toBe(true);
		expect(focus.focus).toBe("prompt");
	});

	test("scrolls pages in both focus states", () => {
		const { focus, scrolls } = harness();

		expect(focus.handleInput("\x1b[5~")).toBe(true);
		expect(focus.handleInput("\x1b[6~")).toBe(true);
		expect(scrolls).toEqual([-10, 10]);
	});
});
