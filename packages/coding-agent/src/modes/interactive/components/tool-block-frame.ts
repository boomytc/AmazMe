import { Container, type TuiMouseEvent } from "@amazme/tui";
import { theme, type ThemeColor } from "../theme/theme.ts";
import { markSelectedLines } from "./transcript-selection.ts";

/**
 * Shared shell for tool execution blocks: a blank line, a colored rule, the tool's own
 * body, and a closing rule. The rule carries the result state, so a finished, failed,
 * and still-running block read differently without each renderer inventing its own
 * status chrome.
 *
 * The body is a Container, so a renderer keeps owning its content while the frame owns
 * the border, spacing, and transcript selection marker.
 */

export type ToolBlockTone = "pending" | "success" | "error" | "neutral";

const TONE_COLOR: Record<ToolBlockTone, ThemeColor> = {
	pending: "borderMuted",
	success: "border",
	error: "error",
	neutral: "border",
};

export interface ToolBlockFrameOptions {
	/** Read on every frame, so the rule follows a streaming result without extra wiring. */
	readonly tone: () => ToolBlockTone;
	/** Overrides the tone color, for blocks that keep an existing border color. */
	readonly borderColor?: () => (text: string) => string;
}

export class ToolBlockFrame extends Container {
	readonly body = new Container();
	/** Lines rendered before the body: the leading blank line and the top rule. */
	static readonly BODY_OFFSET = 2;
	private selected = false;
	private readonly options: ToolBlockFrameOptions;

	constructor(options: ToolBlockFrameOptions) {
		super();
		this.options = options;
		this.addChild(this.body);
	}

	setSelected(selected: boolean): void {
		this.selected = selected;
	}

	get bodyOffset(): number {
		return ToolBlockFrame.BODY_OFFSET;
	}

	/** Row hits land on the body, never on the rule or the leading blank line. */
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const relative = event.y - ToolBlockFrame.BODY_OFFSET;
		if (relative < 0) return undefined;
		return this.body.handleMouse({
			...event,
			y: relative,
			height: Math.max(0, event.height - ToolBlockFrame.BODY_OFFSET),
		});
	}

	override render(width: number): string[] {
		const body = this.body.render(width);
		// An empty block takes no layout space, including its borders.
		if (body.length === 0) return [];
		const paint = this.options.borderColor?.() ?? ((text: string) => theme.fg(TONE_COLOR[this.options.tone()], text));
		const rule = paint("─".repeat(Math.max(1, width)));
		const lines = ["", rule, ...body, rule];
		return this.selected ? markSelectedLines(lines, width) : lines;
	}
}

/** Container that records the height of its last render, for mouse row mapping. */
export class MeasuredContainer extends Container {
	height = 0;

	override render(width: number): string[] {
		const lines = super.render(width);
		this.height = lines.length;
		return lines;
	}
}
