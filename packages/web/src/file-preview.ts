import type { FileContent } from "./generated/contracts.ts";

type FilePreview =
	| { readonly kind: "changed" }
	| { readonly kind: "text"; readonly text: string; readonly startLine: number; readonly truncated: boolean };

/** Read a bounded, single-version prefix and retain the context around a requested source line. */
export async function readFilePreview(options: {
	readonly read: (page: { readonly offset: number; readonly limit: number }) => Promise<FileContent>;
	readonly active: () => boolean;
	readonly line?: number;
}): Promise<FilePreview | undefined> {
	const limit = 1024 * 1024;
	let offset = 0, content = "", digest: string | undefined, newlines = 0, more = false;
	while (options.active()) {
		const page = await options.read({ offset, limit: Math.min(32000, limit - offset) });
		if (!options.active()) return undefined;
		if (digest !== undefined && digest !== page.digest) return { kind: "changed" };
		digest = page.digest;
		content += page.content;
		for (const char of page.content) if (char === "\n") newlines += 1;
		more = page.has_more ?? page.truncated ?? false;
		if (options.line === undefined || newlines >= options.line || !more) break;
		const next = page.next_offset;
		if (next === undefined || !Number.isSafeInteger(next) || next <= offset || next > limit - 4) break;
		offset = next;
	}
	if (!options.active()) return undefined;
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const startLine = options.line !== undefined && options.line <= lines.length ? Math.max(1, options.line - 40) : 1;
	const end = Math.min(lines.length, startLine - 1 + 2000);
	const text = lines.slice(startLine - 1, end).join("\n") + (end < lines.length || content.endsWith("\n") ? "\n" : "");
	return { kind: "text", text, startLine, truncated: more || startLine > 1 || end < lines.length };
}
