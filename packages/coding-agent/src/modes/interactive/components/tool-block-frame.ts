import { Container, type TuiMouseEvent } from "@amazme/tui";
import { markSelectedLines } from "./transcript-selection.ts";

/**
 * Shared shell for tool rows. The body is the whole row: no leading blank and no
 * horizontal rules. The body is a Container, so a renderer keeps owning its content
 * while the frame owns the transcript selection marker.
 */

export class ToolBlockFrame extends Container {
	readonly body = new Container();
	/** Lines rendered before the body. The row has no chrome above the content. */
	static readonly BODY_OFFSET = 0;
	private selected = false;

	constructor() {
		super();
		this.addChild(this.body);
	}

	setSelected(selected: boolean): void {
		this.selected = selected;
	}

	get bodyOffset(): number {
		return ToolBlockFrame.BODY_OFFSET;
	}

	/** Row hits land on the body. */
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.y < 0) return undefined;
		return this.body.handleMouse(event);
	}

	override render(width: number): string[] {
		const body = this.body.render(width);
		if (body.length === 0) return [];
		return this.selected ? markSelectedLines(body, width) : body;
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
