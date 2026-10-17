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
