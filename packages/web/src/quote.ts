/**
 * Turn a selected answer into a Markdown quote for the composer.
 *
 * The selection is display text, not a second transcript representation. Keeping it as a
 * blockquote lets the reader edit the draft, remove the quote, or add their own instruction
 * without introducing a new attachment or prompt contract.
 */
export function quotedDraft(text: string): string | undefined {
	const normalized = text
		.replace(/\r\n?/gu, "\n")
		.replace(/\u00a0/gu, " ")
		.replace(/^[ \t]*\n+/u, "")
		.replace(/\n+[ \t]*$/u, "")
		.replace(/[ \t]+$/gmu, "");
	if (normalized.trim().length === 0) return undefined;
	return normalized
		.split("\n")
		.map((line) => (line.length === 0 ? ">" : `> ${line}`))
		.join("\n");
}

/** Insert a quote at the remembered composer selection and leave the caret after it. */
export function insertDraftText(
	draft: string,
	start: number,
	end: number,
	text: string,
): { readonly text: string; readonly cursor: number } {
	const from = Math.min(Math.max(0, start), draft.length);
	const to = Math.min(Math.max(from, end), draft.length);
	const before = draft.slice(0, from);
	const after = draft.slice(to);
	const leading = before.length === 0 || /\n\s*$/u.test(before) ? "" : "\n\n";
	const trailing = after.length === 0 || /^\s*\n/u.test(after) ? "" : "\n\n";
	return {
		text: `${before}${leading}${text}${trailing}${after}`,
		cursor: before.length + leading.length + text.length,
	};
}
