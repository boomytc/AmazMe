import type { Context } from "@amazme/chord";
import { withoutAbortSignal } from "@amazme/chord/context";
import type { FileSystem, FileWriteIntent } from "../env/index.ts";
import { FileError, getOrThrow } from "../env/index.ts";
import { generateDiffString, generateUnifiedPatch } from "./edit-diff.ts";

export type WriteToolDetails = {
	diff?: string;
	patch?: string;
	firstChangedLine?: number;
	diffOmitted?: "size" | "binary" | "complexity";
};

const MAX_DIFF_BYTES = 1024 * 1024;
const DIFF_LIMITS = { timeout: 100 };

/** Read the exact observed version before publication. This never records an applied change. */
export async function prepareWriteDiff(
	files: FileSystem,
	absolutePath: string,
	displayPath: string,
	content: string,
	intent: FileWriteIntent,
	context: Context,
): Promise<WriteToolDetails> {
	const revision = intent.kind === "replaceIfVersion" ? { ...intent.revision } : undefined;
	if (content.length > MAX_DIFF_BYTES) return { diffOmitted: "size" };
	const afterBytes = new TextEncoder().encode(content);
	if (afterBytes.length > MAX_DIFF_BYTES) return { diffOmitted: "size" };
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const after = decoder.decode(afterBytes);
	if (after.includes("\0")) return { diffOmitted: "binary" };
	let before: string | null = null;
	if (revision !== undefined) {
		const reader = getOrThrow(await files.openBinaryReader(absolutePath, undefined, context));
		try {
			const changed = () =>
				new FileError("stale_version", `${displayPath} changed since it was read; read it again`, absolutePath);
			if (getOrThrow(await reader.revision(context)) !== revision.version) throw changed();
			const { size } = getOrThrow(await reader.info(context));
			if (!Number.isSafeInteger(size) || size < 0) throw new FileError("invalid", "Invalid file size", absolutePath);
			if (size > MAX_DIFF_BYTES) return { diffOmitted: "size" };
			const bytes = new Uint8Array(size);
			for (let offset = 0; offset < size; ) {
				context.abortSignal?.throwIfAborted();
				const chunk = getOrThrow(await reader.read(offset, Math.min(64 * 1024, size - offset), context));
				if (chunk.length === 0) throw changed();
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			if (getOrThrow(await reader.revision(context)) !== revision.version) throw changed();
			const current = getOrThrow(await files.fileRevision(absolutePath, context));
			if (current.path !== revision.path || current.version !== revision.version) throw changed();
			try {
				before = decoder.decode(bytes);
			} catch {
				return { diffOmitted: "binary" };
			}
			if (before.includes("\0")) return { diffOmitted: "binary" };
		} finally {
			await reader.close(withoutAbortSignal(context));
		}
	}
	context.abortSignal?.throwIfAborted();
	const diff = generateDiffString(before ?? "", after, 4, DIFF_LIMITS);
	if (diff === undefined) return { diffOmitted: "complexity" };
	const patch = generateUnifiedPatch(displayPath, before, after, 4, DIFF_LIMITS);
	if (patch === undefined) return { diffOmitted: "complexity" };
	return {
		diff: diff.diff,
		patch,
		...(diff.firstChangedLine === undefined ? {} : { firstChangedLine: diff.firstChangedLine }),
	};
}

/** A missing diff is explicit while the actual write result remains successful. */
export function writeDiffNote(details: WriteToolDetails): string {
	const reason = details.diffOmitted;
	if (reason === undefined) return "";
	const message =
		reason === "size"
			? "the before or after content exceeds 1MB"
			: reason === "binary"
				? "the content is binary or is not valid UTF-8"
				: "the changes exceed the diff computation budget";
	return `\n[Diff unavailable: ${message}.]`;
}
