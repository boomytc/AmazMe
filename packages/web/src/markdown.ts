/**
 * Assistant formatting: an answer's text into the structure the renderer turns into DOM. The unit
 * stays small on purpose — headings, lists, emphasis, links, fenced code — and it never parses
 * HTML, so model-produced markup stays text. A construct that does not parse stays literal text:
 * the answer is always shown, never dropped.
 */

export type InlineNode =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "code"; readonly text: string }
	| { readonly kind: "strong"; readonly children: readonly InlineNode[] }
	| { readonly kind: "em"; readonly children: readonly InlineNode[] }
	| { readonly kind: "link"; readonly href: string; readonly children: readonly InlineNode[] };

export interface ParagraphNode {
	readonly kind: "paragraph";
	readonly children: readonly InlineNode[];
}

export interface HeadingNode {
	readonly kind: "heading";
	readonly level: number;
	readonly children: readonly InlineNode[];
}

export interface ListNode {
	readonly kind: "list";
	readonly ordered: boolean;
	readonly start: number;
	readonly items: readonly (readonly InlineNode[])[];
}

export interface CodeNode {
	readonly kind: "code";
	readonly language: string | undefined;
	readonly text: string;
}

export type MarkdownNode = ParagraphNode | HeadingNode | ListNode | CodeNode;

/** Schemes a model-supplied link may carry; everything else stays text `safeHref` rejects. */
const allowedLinkSchemes = new Set(["http", "https", "mailto"]);
const fencePattern = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const headingPattern = /^ {0,3}(#{1,6})\s+(.*)$/;
const bulletPattern = /^ {0,3}[-*+]\s+(.*)$/;
const orderedPattern = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const escapable = /[\\`*_[\]()#!>-]/;

/**
 * A target the page may put in an `href`. URL parsers strip whitespace and control characters
 * before reading the scheme, so anything containing them is refused rather than normalised.
 */
export function safeHref(target: string): string | undefined {
	const candidate = target.trim();
	if (candidate.length === 0) return undefined;
	if (/[\u0000-\u0020\u007f]/.test(candidate)) return undefined;
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(candidate);
	if (scheme !== null && !allowedLinkSchemes.has((scheme[1] ?? "").toLowerCase())) return undefined;
	return candidate;
}

/** The fence's info string as a language name, or `undefined` when there is nothing usable. */
function languageOf(info: string): string | undefined {
	const name = info.trim().split(/\s+/)[0] ?? "";
	if (!/^[A-Za-z0-9_+#.-]+$/.test(name)) return undefined;
	return name.toLowerCase();
}

/** Whether a line closes the fence opened with `marker`: the same character, at least as long. */
function closesFence(line: string, marker: string): boolean {
	const character = marker[0] ?? "`";
	const trimmed = line.trim();
	if (trimmed.length < marker.length) return false;
	return [...trimmed].every((candidate) => candidate === character);
}

/** The index of the delimiter that closes an emphasis run, or -1. */
function findClosing(text: string, from: number, delimiter: string): number {
	let index = text.indexOf(delimiter, from);
	while (index !== -1) {
		const before = text[index - 1];
		const after = text[index + 1];
		// A closing delimiter does not end a run when it follows whitespace or runs into its own
		// character: `**` closes a strong run, `***` opens a different one.
		if (before !== undefined && !/\s/.test(before) && after !== delimiter) return index;
		index = text.indexOf(delimiter, index + 1);
	}
	return -1;
}

function inline(text: string): InlineNode[] {
	const nodes: InlineNode[] = [];
	let buffer = "";
	let index = 0;
	const flush = (): void => {
		if (buffer.length === 0) return;
		nodes.push({ kind: "text", text: buffer });
		buffer = "";
	};
	while (index < text.length) {
		const character = text[index] ?? "";
		const next = text[index + 1];
		if (character === "\\" && next !== undefined && escapable.test(next)) {
			buffer += next;
			index += 2;
			continue;
		}
		if (character === "`") {
			const run = /^`+/.exec(text.slice(index))?.[0] ?? "`";
			const close = text.indexOf(run, index + run.length);
			if (close !== -1) {
				flush();
				nodes.push({ kind: "code", text: text.slice(index + run.length, close) });
				index = close + run.length;
				continue;
			}
		}
		if (character === "*" || character === "_") {
			// `_` inside a word is part of the word: only `*` emphasises there.
			const inWord = character === "_" && /[A-Za-z0-9]/.test(text[index - 1] ?? "");
			const strong = text.startsWith(`${character}${character}`, index);
			const delimiter = strong ? `${character}${character}` : character;
			const close = inWord ? -1 : findClosing(text, index + delimiter.length, delimiter);
			if (close > index + delimiter.length) {
				flush();
				const children = inline(text.slice(index + delimiter.length, close));
				nodes.push(strong ? { kind: "strong", children } : { kind: "em", children });
				index = close + delimiter.length;
				continue;
			}
		}
		if (character === "[") {
			const labelEnd = text.indexOf("](", index + 1);
			const targetEnd = labelEnd === -1 ? -1 : text.indexOf(")", labelEnd + 2);
			if (labelEnd !== -1 && targetEnd !== -1) {
				const label = text.slice(index + 1, labelEnd);
				const href = safeHref(text.slice(labelEnd + 2, targetEnd));
				if (label.length > 0 && href !== undefined) {
					flush();
					nodes.push({ kind: "link", href, children: inline(label) });
					index = targetEnd + 1;
					continue;
				}
			}
		}
		buffer += character;
		index += 1;
	}
	flush();
	return nodes;
}

interface OpenList {
	ordered: boolean;
	start: number;
	items: string[];
}

export function formatMarkdown(text: string): MarkdownNode[] {
	const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	const nodes: MarkdownNode[] = [];
	let paragraph: string[] = [];
	let list: OpenList | undefined;

	const flushParagraph = (): void => {
		if (paragraph.length === 0) return;
		nodes.push({ kind: "paragraph", children: inline(paragraph.join("\n")) });
		paragraph = [];
	};
	const flushList = (): void => {
		if (list === undefined) return;
		nodes.push({
			kind: "list",
			ordered: list.ordered,
			start: list.start,
			items: list.items.map((item) => inline(item)),
		});
		list = undefined;
	};

	for (let index = 0; index < lines.length; ) {
		const line = lines[index] ?? "";
		const fence = fencePattern.exec(line);
		if (fence !== null) {
			flushParagraph();
			flushList();
			const marker = fence[1] ?? "```";
			const body: string[] = [];
			index += 1;
			// An unterminated fence — a truncated answer — keeps every remaining line as code.
			while (index < lines.length && !closesFence(lines[index] ?? "", marker)) {
				body.push(lines[index] ?? "");
				index += 1;
			}
			index += 1;
			nodes.push({ kind: "code", language: languageOf(fence[2] ?? ""), text: body.join("\n") });
			continue;
		}
		if (line.trim().length === 0) {
			flushParagraph();
			flushList();
			index += 1;
			continue;
		}
		const heading = headingPattern.exec(line);
		if (heading !== null) {
			flushParagraph();
			flushList();
			nodes.push({
				kind: "heading",
				level: (heading[1] ?? "#").length,
				children: inline((heading[2] ?? "").trim()),
			});
			index += 1;
			continue;
		}
		const bullet = bulletPattern.exec(line);
		const ordered = orderedPattern.exec(line);
		if (bullet !== null || ordered !== null) {
			flushParagraph();
			if (list === undefined || list.ordered !== (ordered !== null)) {
				flushList();
				list = { ordered: ordered !== null, start: ordered === null ? 1 : Number(ordered[1]), items: [] };
			}
			list.items.push((bullet?.[1] ?? ordered?.[2] ?? "").trim());
			index += 1;
			continue;
		}
		// A plain line continues the open item (markdown's lazy continuation), else the paragraph.
		if (list !== undefined) list.items[list.items.length - 1] = `${list.items[list.items.length - 1] ?? ""} ${line.trim()}`;
		else paragraph.push(line.trim());
		index += 1;
	}
	flushParagraph();
	flushList();
	return nodes;
}
