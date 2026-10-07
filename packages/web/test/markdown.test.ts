import { describe, expect, test } from "vitest";
import { formatMarkdown, safeHref, type InlineNode } from "../src/markdown.ts";

/** The text of an inline run, for assertions that only care about what a reader sees. */
function textOf(nodes: readonly InlineNode[]): string {
	return nodes
		.map((node) => {
			switch (node.kind) {
				case "text":
				case "code":
					return node.text;
				case "strong":
				case "em":
					return textOf(node.children);
				case "link":
					return textOf(node.children);
			}
		})
		.join("");
}

describe("assistant markdown", () => {
	test("turns headings into their level and keeps the inline run", () => {
		expect(formatMarkdown("# Title")).toEqual([
			{ kind: "heading", level: 1, children: [{ kind: "text", text: "Title" }] },
		]);
		expect(formatMarkdown("### Deeper")).toMatchObject([{ kind: "heading", level: 3 }]);
		expect(formatMarkdown("####### seven hashes")).toMatchObject([
			{ kind: "paragraph", children: [{ kind: "text", text: "####### seven hashes" }] },
		]);
		expect(formatMarkdown("#no space")).toMatchObject([{ kind: "paragraph" }]);
		const heading = formatMarkdown("## The **fast** path")[0];
		expect(heading).toMatchObject({
			kind: "heading",
			level: 2,
			children: [
				{ kind: "text", text: "The " },
				{ kind: "strong", children: [{ kind: "text", text: "fast" }] },
				{ kind: "text", text: " path" },
			],
		});
	});

	test("collects bullet and ordered runs into lists", () => {
		expect(formatMarkdown("- one\n- two\n* three")).toEqual([
			{
				kind: "list",
				ordered: false,
				start: 1,
				items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }], [{ kind: "text", text: "three" }]],
			},
		]);
		const ordered = formatMarkdown("3. third\n4. fourth\n\n- bullet")[0];
		expect(ordered).toMatchObject({ kind: "list", ordered: true, start: 3 });
		expect(formatMarkdown("1. first\n- bullet")[0]).toMatchObject({ kind: "list", ordered: true, start: 1 });
		expect(formatMarkdown("1. first\n- bullet")[1]).toMatchObject({ kind: "list", ordered: false });
		// A lazy continuation line belongs to the open item, not to a new paragraph.
		expect(formatMarkdown("- wrapped\n  continued here")).toMatchObject([
			{ kind: "list", items: [[{ kind: "text", text: "wrapped continued here" }]] },
		]);
	});

	test("fences code with its language, and keeps an unterminated fence as code", () => {
		expect(formatMarkdown("```ts\nconst x = 1\n```")).toEqual([
			{ kind: "code", language: "ts", text: "const x = 1" },
		]);
		expect(formatMarkdown("```\nplain\n```")).toEqual([{ kind: "code", language: undefined, text: "plain" }]);
		// Truncated answers end mid-fence; the rest is still code, and `**` in it stays literal.
		expect(formatMarkdown("text\n```sh\nrm **")).toMatchObject([
			{ kind: "paragraph" },
			{ kind: "code", language: "sh", text: "rm **" },
		]);
		// A fence inside a fence body does not reopen: the shorter marker cannot close the longer one.
		expect(formatMarkdown("````\n```\n````")).toEqual([{ kind: "code", language: undefined, text: "```" }]);
	});

	test("parses inline code, emphasis, and links", () => {
		expect(formatMarkdown("use `npm test` now")).toMatchObject([
			{
				kind: "paragraph",
				children: [
					{ kind: "text", text: "use " },
					{ kind: "code", text: "npm test" },
					{ kind: "text", text: " now" },
				],
			},
		]);
		expect(formatMarkdown("**bold** and *italic*")).toMatchObject([
			{
				kind: "paragraph",
				children: [
					{ kind: "strong", children: [{ kind: "text", text: "bold" }] },
					{ kind: "text", text: " and " },
					{ kind: "em", children: [{ kind: "text", text: "italic" }] },
				],
			},
		]);
		expect(formatMarkdown("[docs](https://example.com/a)")).toMatchObject([
			{
				kind: "paragraph",
				children: [
					{
						kind: "link",
						href: "https://example.com/a",
						children: [{ kind: "text", text: "docs" }],
					},
				],
			},
		]);
		// An identifier keeps its underscores: only `*` emphasises inside a word.
		expect(formatMarkdown("call read_file_now")).toMatchObject([
			{ kind: "paragraph", children: [{ kind: "text", text: "call read_file_now" }] },
		]);
		expect(formatMarkdown("keep \\*literal\\* stars")).toMatchObject([
			{ kind: "paragraph", children: [{ kind: "text", text: "keep *literal* stars" }] },
		]);
		// A link's visible text is the label, not the target.
		const linked = formatMarkdown("[the **docs**](https://example.com)")[0];
		expect(linked.kind === "paragraph" ? textOf(linked.children) : "").toBe("the docs");
	});

	test("refuses a link whose scheme a page must not follow", () => {
		expect(safeHref("https://example.com")).toBe("https://example.com");
		expect(safeHref("mailto:someone@example.com")).toBe("mailto:someone@example.com");
		expect(safeHref("docs/usage.md")).toBe("docs/usage.md");
		expect(safeHref("javascript:alert(1)")).toBeUndefined();
		expect(safeHref("JavaScript:alert(1)")).toBeUndefined();
		// A tab or newline is stripped by URL parsers, so `java\tscript:` must not pass.
		expect(safeHref("java\tscript:alert(1)")).toBeUndefined();
		expect(safeHref("data:text/html,<script>")).toBeUndefined();
		expect(safeHref("")).toBeUndefined();

		// The refused construct stays visible as text instead of becoming a live link.
		const refused = formatMarkdown("[click](javascript:alert(1))");
		expect(refused).toEqual([
			{ kind: "paragraph", children: [{ kind: "text", text: "[click](javascript:alert(1))" }] },
		]);
	});

	test("keeps model-produced markup as text", () => {
		expect(formatMarkdown('<b>bold</b> and <script>alert("x")</script>')).toEqual([
			{
				kind: "paragraph",
				children: [{ kind: "text", text: '<b>bold</b> and <script>alert("x")</script>' }],
			},
		]);
		// Markup inside a fence is code verbatim, and an <a> the model wrote is still text.
		expect(formatMarkdown("```html\n<a href=\"x\">link</a>\n```")).toEqual([
			{ kind: "code", language: "html", text: '<a href="x">link</a>' },
		]);
		expect(formatMarkdown("<a href=\"https://example.com\">link</a>")).toEqual([
			{ kind: "paragraph", children: [{ kind: "text", text: '<a href="https://example.com">link</a>' }] },
		]);
	});

	test("separates paragraphs on blank lines and keeps single newlines inside one", () => {
		expect(formatMarkdown("first line\nsecond line")).toEqual([
			{ kind: "paragraph", children: [{ kind: "text", text: "first line\nsecond line" }] },
		]);
		expect(formatMarkdown("one\n\ntwo")).toMatchObject([
			{ kind: "paragraph", children: [{ kind: "text", text: "one" }] },
			{ kind: "paragraph", children: [{ kind: "text", text: "two" }] },
		]);
		expect(formatMarkdown("")).toEqual([]);
		expect(formatMarkdown("   \n\n")).toEqual([]);
	});

	test("reads a pipe table into a header, its alignments, and its rows", () => {
		const table = formatMarkdown(
			["| 包 | 文件 | 用时 |", "| --- | :---: | ---: |", "| web | 12 | 1.5s |", "| ai | 3 | 0.25s |", "", "after"].join(
				"\n",
			),
		);
		expect(table[0]).toMatchObject({
			kind: "table",
			align: [undefined, "center", "right"],
			head: [[{ kind: "text", text: "包" }], [{ kind: "text", text: "文件" }], [{ kind: "text", text: "用时" }]],
			rows: [
				[
					[{ kind: "text", text: "web" }],
					[{ kind: "text", text: "12" }],
					[{ kind: "text", text: "1.5s" }],
				],
				[
					[{ kind: "text", text: "ai" }],
					[{ kind: "text", text: "3" }],
					[{ kind: "text", text: "0.25s" }],
				],
			],
		});
		expect(table[1]).toMatchObject({ kind: "paragraph" });
		// The outer pipes are optional, inline runs keep their markup, and `\|` is a literal pipe.
		const loose = formatMarkdown("a | b\n--- | ---\n**1** | a \\| b");
		expect(loose).toMatchObject([
			{
				kind: "table",
				align: [undefined, undefined],
				rows: [
					[[{ kind: "strong", children: [{ kind: "text", text: "1" }] }], [{ kind: "text", text: "a | b" }]],
				],
			},
		]);
	});

	test("leaves a pipe line that is not a table as prose", () => {
		// No delimiter row: a sentence with pipes stays one paragraph.
		expect(formatMarkdown("either | or")).toMatchObject([{ kind: "paragraph" }]);
		// A delimiter row with a different column count does not delimit the table, so the lines stay
		// one paragraph.
		expect(formatMarkdown("| a | b |\n| --- |\n| 1 | 2 |")).toMatchObject([
			{ kind: "paragraph", children: [{ kind: "text", text: "| a | b |\n| --- |\n| 1 | 2 |" }] },
		]);
		// A cell that is not dashes does not delimit one either.
		expect(formatMarkdown("| a | b |\n| --- | nope |\n")).toMatchObject([
			{ kind: "paragraph", children: [{ kind: "text", text: "| a | b |\n| --- | nope |" }] },
		]);
		// A body row with too few cells is padded with an empty cell, so every row has one entry per
		// column.
		expect(formatMarkdown("| a | b |\n| --- | --- |\n| 1 |")).toMatchObject([
			{ kind: "table", rows: [[[{ kind: "text", text: "1" }], []]] },
		]);
		// A heading and a list item outrank a table: their own construct wins when the line has pipes.
		expect(formatMarkdown("# 标题 | 说明\n--- | ---")[0]).toMatchObject({ kind: "heading", level: 1 });
		expect(formatMarkdown("- 一项 | 说明\n--- | ---")[0]).toMatchObject({ kind: "list", ordered: false });
	});
});
