import { describe, expect, it } from "vitest";
import { insertDraftText, quotedDraft } from "../src/quote.ts";

describe("quotedDraft", () => {
	it("prefixes every line and keeps a blank line as a bare marker", () => {
		expect(quotedDraft("first\n\nsecond")).toBe("> first\n>\n> second");
	});

	it("inserts at the caret with a blank line and leaves the caret after the quote", () => {
		expect(insertDraftText("Please explain:", 15, 15, "> answer")).toEqual({
			text: "Please explain:\n\n> answer",
			cursor: 25,
		});
	});

	it("does not duplicate blank lines or replace the surrounding draft", () => {
		expect(insertDraftText("Before\n\n", 8, 8, "> answer\n\nAfter")).toEqual({
			text: "Before\n\n> answer\n\nAfter",
			cursor: 23,
		});
	});

	it("replaces the remembered selection", () => {
		expect(insertDraftText("keep this", 5, 9, "> answer")).toEqual({
			text: "keep \n\n> answer",
			cursor: 15,
		});
	});

	it("normalizes CRLF and non-breaking spaces from rendered text", () => {
		expect(quotedDraft("first\r\nsecond\u00a0line")).toBe("> first\n> second line");
	});

	it("trims only the outside of the selection", () => {
		expect(quotedDraft("\n  indented  \n\n")).toBe(">   indented");
	});

	it("does not produce an empty quote", () => {
		expect(quotedDraft("")).toBeUndefined();
		expect(quotedDraft(" \r\n\t ")).toBeUndefined();
	});

	it("inserts into an empty draft without separators", () => {
		expect(insertDraftText("", 0, 0, "> answer")).toEqual({ text: "> answer", cursor: 8 });
	});
});
