import type { Component } from "@amazme/tui";

/**
 * Line range of one chat row inside the scroll document.
 *
 * The document also holds the header and loaded-resource sections above the chat
 * container, so a row's start offset depends on everything painted before it. The
 * range lets the transcript scroll the selected row into view without guessing.
 */
export function chatRowLineRange(
	documentChildren: readonly Component[],
	chatContainer: Component,
	chatChildren: readonly Component[],
	targetIndex: number,
	width: number,
): { start: number; height: number } | undefined {
	if (targetIndex < 0 || targetIndex >= chatChildren.length || width <= 0) return undefined;
	let offset = 0;
	for (const child of documentChildren) {
		if (child === chatContainer) {
			for (let index = 0; index < chatChildren.length; index++) {
				const height = chatChildren[index]?.render(width).length ?? 0;
				if (index === targetIndex) return { start: offset, height };
				offset += height;
			}
			return undefined;
		}
		offset += child.render(width).length;
	}
	return undefined;
}

/**
 * Content-line offsets that start a conversation turn, in one pass over the document.
 *
 * The caller paints one marker per offset in the scrollbar column, so folding or
 * streaming changes only shift the ticks instead of rebuilding a separate index.
 */
export function turnStartLines(
	documentChildren: readonly Component[],
	chatContainer: Component,
	chatChildren: readonly Component[],
	width: number,
): number[] {
	if (width <= 0) return [];
	const lines: number[] = [];
	let offset = 0;
	for (const child of documentChildren) {
		if (child === chatContainer) {
			for (let index = 0; index < chatChildren.length; index++) {
				const row = chatChildren[index];
				if (row === undefined) continue;
				if ((row as { transcriptTurnStart?: boolean }).transcriptTurnStart === true) lines.push(offset);
				offset += row.render(width).length;
			}
			continue;
		}
		offset += child.render(width).length;
	}
	return lines;
}
