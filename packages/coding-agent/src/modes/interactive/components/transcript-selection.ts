import { truncateToWidth } from "@amazme/tui";
import { theme } from "../theme/theme.ts";

/** Left-edge cue for the transcript row that arrow keys act on. */
export const TRANSCRIPT_SELECTION_MARKER = "▌";

/**
 * Prefix every line with the marker and truncate the content to the remaining columns.
 * The row keeps its normal layout, so selecting it never reflows the conversation.
 */
export function markSelectedLines(lines: readonly string[], width: number): string[] {
	if (width <= 1) return [...lines];
	const marker = theme.fg("accent", TRANSCRIPT_SELECTION_MARKER);
	return lines.map((line) => marker + truncateToWidth(line, width - 1, "…"));
}
