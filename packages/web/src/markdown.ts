/**
 * Assistant formatting: an answer's text into the structure the renderer turns into DOM. The unit
 * stays small on purpose — headings, lists, emphasis, links, fenced code, tables — and it never
 * parses HTML, so model-produced markup stays text. A construct that does not parse stays literal
 * text: the answer is always shown, never dropped.
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

export type MarkdownNode = ParagraphNode | HeadingNode | ListNode | CodeNode | TableNode;

/** Where a table column's cells sit. Absent means the renderer decides (numbers go right). */
export type TableAlignment = "left" | "center" | "right";

export interface TableNode {
	readonly kind: "table";
	/** One entry per column, from the delimiter row. */
	readonly align: readonly (TableAlignment | undefined)[];
	readonly head: readonly (readonly InlineNode[])[];
	readonly rows: readonly (readonly (readonly InlineNode[])[])[];
}

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

/**
 * One table row's cells, or `undefined` when the line is not a table row. A cell boundary is an
 * unescaped `|`; the outer pipes are optional, and `\|` is a literal pipe inside a cell.
 */
function tableCells(line: string): string[] | undefined {
	const trimmed = line.trim();
	if (!trimmed.includes("|")) return undefined;
	const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let current = "";
	for (let index = 0; index < body.length; index += 1) {
		const character = body[index] ?? "";
		if (character === "\\" && body[index + 1] === "|") {
			current += "|";
			index += 1;
			continue;
		}
		if (character === "|") {
			cells.push(current.trim());
			current = "";
			continue;
		}
		current += character;
	}
	cells.push(current.trim());
	return cells;
}

/** The alignments a delimiter row declares, or `undefined` when the line does not delimit a table. */
function tableAlignments(line: string): (TableAlignment | undefined)[] | undefined {
	const cells = tableCells(line);
	if (cells === undefined) return undefined;
	const align: (TableAlignment | undefined)[] = [];
	for (const cell of cells) {
		if (!/^:?-+:?$/.test(cell)) return undefined;
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		align.push(left && right ? "center" : right ? "right" : left ? "left" : undefined);
	}
	return align;
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
		// A table: a header row whose next line delimits the same number of columns. Everything that
		// does not match stays text, so a stray `|` in prose is still prose.
		const headerCells = tableCells(line);
		const align = tableAlignments(lines[index + 1] ?? "");
		if (headerCells !== undefined && align !== undefined && align.length === headerCells.length) {
			flushParagraph();
			flushList();
			const rows: string[][] = [];
			let cursor = index + 2;
			while (cursor < lines.length) {
				const cells = tableCells(lines[cursor] ?? "");
				if (cells === undefined) break;
				rows.push(Array.from({ length: headerCells.length }, (_, column) => cells[column] ?? ""));
				cursor += 1;
			}
			nodes.push({
				kind: "table",
				align,
				head: headerCells.map((cell) => inline(cell)),
				rows: rows.map((row) => row.map((cell) => inline(cell))),
			});
			index = cursor;
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

export type CodeTokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "type" | "property";

export interface CodeToken {
	readonly kind: CodeTokenKind;
	readonly text: string;
}

const CODE_KEYWORDS = new Set([
	"abstract", "and", "as", "assert", "async", "await", "break", "case", "catch", "chan", "class",
	"const", "continue", "crate", "def", "default", "defer", "del", "delete", "do", "done", "elif",
	"else", "enum", "esac", "except", "export", "extends", "extern", "fallthrough", "fi", "finally",
	"fn", "for", "from", "func", "function", "global", "go", "if", "impl", "implements", "import",
	"in", "infer", "instanceof", "interface", "is", "keyof", "lambda", "let", "local", "loop", "match",
	"mod", "move", "mut", "namespace", "new", "nonlocal", "not", "of", "or", "override", "package",
	"pass", "private", "protected", "pub", "public", "raise", "range", "readonly", "ref", "return",
	"satisfies", "select", "self", "Self", "static", "struct", "super", "switch", "then", "this",
	"throw", "trait", "try", "type", "typeof", "unsafe", "use", "var", "void", "where", "while",
	"with", "yield", "SELECT", "FROM", "WHERE", "INSERT", "INTO", "UPDATE", "DELETE", "JOIN",
	"LEFT", "RIGHT", "INNER", "ON", "GROUP", "BY", "ORDER", "LIMIT",
]);

const CODE_LITERALS = new Set([
	"true", "false", "null", "undefined", "NaN", "Infinity", "None", "True", "False", "nil",
]);

const CODE_TYPES = new Set([
	"string", "number", "boolean", "bigint", "symbol", "unknown", "never", "object",
	"int", "float", "bool", "str", "bytes", "list", "dict", "tuple", "set",
	"usize", "isize", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "f32", "f64",
	"Option", "Result", "Vec", "String", "Box", "Arc", "Rc",
	"Promise", "Record", "Readonly", "Partial", "Array", "Map", "Set", "Error",
]);

const HASH_COMMENT_LANGUAGES = new Set([
	"py", "python", "sh", "bash", "zsh", "shell", "console", "yaml", "yml", "toml", "ini", "rb", "ruby", "r", "perl", "dockerfile", "makefile",
]);

/**
 * Pure, lossless line tokenizer for fenced code blocks. Every input character stays in the output
 * tokens in exact order, so DOM construction only creates text nodes and never parses markup.
 */
export function tokenizeCode(text: string, language?: string): readonly (readonly CodeToken[])[] {
	const lang = language?.toLowerCase() ?? "";
	const rawLines = text.split("\n");
	const result: CodeToken[][] = [];
	let blockComment: "*/" | "-->" | undefined;

	for (const line of rawLines) {
		if (lang === "diff" || lang === "patch") {
			if (line.startsWith("+")) {
				result.push([{ kind: "string", text: line }]);
				continue;
			}
			if (line.startsWith("-")) {
				result.push([{ kind: "keyword", text: line }]);
				continue;
			}
			if (line.startsWith("@@")) {
				result.push([{ kind: "type", text: line }]);
				continue;
			}
		}

		const tokens: CodeToken[] = [];
		const push = (kind: CodeTokenKind, slice: string): void => {
			if (slice.length === 0) return;
			const last = tokens.at(-1);
			if (last !== undefined && last.kind === kind) {
				tokens[tokens.length - 1] = { kind, text: last.text + slice };
			} else {
				tokens.push({ kind, text: slice });
			}
		};

		let index = 0;
		while (index < line.length) {
			if (blockComment !== undefined) {
				const close = line.indexOf(blockComment, index);
				if (close === -1) {
					push("comment", line.slice(index));
					index = line.length;
				} else {
					const end = close + blockComment.length;
					push("comment", line.slice(index, end));
					index = end;
					blockComment = undefined;
				}
				continue;
			}

			if (line.startsWith("/*", index)) {
				const close = line.indexOf("*/", index + 2);
				if (close === -1) {
					push("comment", line.slice(index));
					blockComment = "*/";
					break;
				}
				push("comment", line.slice(index, close + 2));
				index = close + 2;
				continue;
			}

			if (line.startsWith("<!--", index)) {
				const close = line.indexOf("-->", index + 4);
				if (close === -1) {
					push("comment", line.slice(index));
					blockComment = "-->";
					break;
				}
				push("comment", line.slice(index, close + 3));
				index = close + 3;
				continue;
			}

			if (line.startsWith("//", index) && lang !== "json") {
				push("comment", line.slice(index));
				break;
			}

			if (line[index] === "#" && (HASH_COMMENT_LANGUAGES.has(lang) || (index === 0 && line.startsWith("#!")))) {
				push("comment", line.slice(index));
				break;
			}

			if (line.startsWith("--", index) && lang === "sql") {
				push("comment", line.slice(index));
				break;
			}

			const quote = line[index];
			if (quote === '"' || quote === "'" || quote === "`") {
				let cursor = index + 1;
				while (cursor < line.length) {
					if (line[cursor] === "\\") {
						cursor += 2;
						continue;
					}
					if (line[cursor] === quote) {
						cursor += 1;
						break;
					}
					cursor += 1;
				}
				const slice = line.slice(index, cursor);
				const rest = line.slice(cursor);
				const isPropertyKey = quote === '"' && /^\s*:/.test(rest) && (lang === "json" || lang === "jsonc" || lang === "yaml" || lang === "yml");
				push(isPropertyKey ? "property" : "string", slice);
				index = cursor;
				continue;
			}

			const numberMatch = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+)?n?)\b/.exec(line.slice(index));
			if (numberMatch !== null && (index === 0 || !/[A-Za-z_$]/.test(line[index - 1] ?? ""))) {
				push("number", numberMatch[0]);
				index += numberMatch[0].length;
				continue;
			}

			const identMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(line.slice(index));
			if (identMatch !== null) {
				const word = identMatch[0];
				const prev = index > 0 ? line[index - 1] : "";
				const after = line.slice(index + word.length);
				if (prev === ".") {
					push("property", word);
				} else if (CODE_KEYWORDS.has(word)) {
					push("keyword", word);
				} else if (CODE_LITERALS.has(word)) {
					push("number", word);
				} else if (CODE_TYPES.has(word) || /^[A-Z][A-Za-z0-9_]*$/.test(word)) {
					push("type", word);
				} else if (/^\s*:/.test(after) && (lang === "yaml" || lang === "yml" || lang === "css" || lang === "scss")) {
					push("property", word);
				} else {
					push("plain", word);
				}
				index += word.length;
				continue;
			}

			push("plain", line[index] ?? "");
			index += 1;
		}

		result.push(tokens);
	}

	return result;
}
