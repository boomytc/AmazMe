import { matchesKey, type Component, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth } from "@amazme/tui";
import type { ForegroundTask } from "../../../core/foreground-commands.ts";
import { theme } from "../theme/theme.ts";

export const POPUP_CLOSE_BADGE = "[x]";

/** Regular mode has no pointer, so popups name the key that closes them instead of a badge. */
export const POPUP_CLOSE_KEY_LABEL = "Esc";

/** Columns of the close badge on the top border, excluding the corner. */
export function popupCloseRange(width: number): { start: number; end: number } {
	const end = Math.max(0, width - 1);
	const start = Math.max(0, end - POPUP_CLOSE_BADGE.length);
	return { start, end };
}

export function popupCloseClicked(event: TuiMouseEvent, width: number): boolean {
	if (event.type !== "click" || event.button !== "left" || event.y !== 0) return false;
	const hit = popupCloseRange(width);
	return event.x >= hit.start && event.x < hit.end;
}

export interface PopupFrameOptions {
	/** Render a clickable [x] badge; otherwise the border names the close key. */
	mouseEnabled?: boolean;
}

/** Rounded card. The top border keeps a title on the left and [x] on the right. */
export function popupFrame(
	title: string,
	body: readonly string[],
	width: number,
	options: PopupFrameOptions = {},
): string[] {
	const closeLabel = (options.mouseEnabled ?? true) ? POPUP_CLOSE_BADGE : POPUP_CLOSE_KEY_LABEL;
	const safe = Math.max(closeLabel.length + 2, width);
	const inner = Math.max(0, safe - 2);
	const titleRoom = Math.max(0, inner - closeLabel.length);
	const titled = truncateToWidth(` ${title} `, titleRoom, "…");
	const gap = Math.max(0, inner - visibleWidth(titled) - closeLabel.length);
	const top =
		theme.fg("text", `╭${titled}${"─".repeat(gap)}`) +
		theme.fg("accent", closeLabel) +
		theme.fg("text", "╮");
	const lines = [top];
	const contentWidth = Math.max(1, safe - 4);
	for (const raw of body) {
		const line = truncateToWidth(raw, contentWidth, "…");
		const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
		lines.push(theme.fg("text", `│ ${line}${pad} │`));
	}
	lines.push(theme.fg("text", `╰${"─".repeat(Math.max(0, safe - 2))}╯`));
	return lines;
}

/** Puts [x] on the top-right of a dialog that replaces the editor. */
export class PopupClose implements Component {
	private width = 0;
	private readonly inner: Component;
	private readonly onClose: () => void;
	private readonly mouseEnabled: () => boolean;

	constructor(inner: Component, onClose: () => void, mouseEnabled: () => boolean = () => true) {
		this.inner = inner;
		this.onClose = onClose;
		this.mouseEnabled = mouseEnabled;
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}

	render(width: number): string[] {
		this.width = width;
		if (!this.mouseEnabled()) return this.inner.render(width);
		const gap = Math.max(0, width - POPUP_CLOSE_BADGE.length);
		const bar = `${" ".repeat(gap)}${theme.fg("accent", POPUP_CLOSE_BADGE)}`;
		return [bar, ...this.inner.render(width)];
	}

	handleInput(data: string): boolean | void {
		const inner = this.inner as { handleInput?(data: string): boolean | void };
		return inner.handleInput?.(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const offset = this.mouseEnabled() ? 1 : 0;
		if (offset === 1 && event.y === 0) {
			if (event.type === "click" && event.button === "left" && event.x >= Math.max(0, this.width - POPUP_CLOSE_BADGE.length)) {
				this.onClose();
				return { handled: true };
			}
			return { handled: true };
		}
		const inner = this.inner as { handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined };
		return inner.handleMouse?.({ ...event, y: event.y - offset });
	}
}

/** Output of one background process. [x] closes the card and leaves the process running. */
export class ProcessPanel implements Component {
	private width = 0;
	private readonly task: () => ForegroundTask | undefined;
	private readonly onClose: () => void;
	private readonly mouseEnabled: () => boolean;

	constructor(task: () => ForegroundTask | undefined, onClose: () => void, mouseEnabled: () => boolean = () => true) {
		this.task = task;
		this.onClose = onClose;
		this.mouseEnabled = mouseEnabled;
	}

	invalidate(): void {}

	render(width: number): string[] {
		this.width = width;
		const task = this.task();
		const inner = Math.max(1, width - 4);
		const body = task ? processBody(task, inner) : ["This process has ended."];
		return popupFrame("Process", body, width, { mouseEnabled: this.mouseEnabled() });
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") this.onClose();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.mouseEnabled() || !popupCloseClicked(event, this.width)) return undefined;
		this.onClose();
		return { handled: true };
	}
}

function processBody(task: ForegroundTask, width: number): string[] {
	const output = task.output.trimEnd();
	const lines = output ? output.split("\n") : ["(no output yet)"];
	const tail = lines.slice(-24);
	const hidden = lines.length - tail.length;
	const status = task.status === "running" ? "Running" : `Exited ${task.exitCode ?? "none"}`;
	const body = [task.command, status, "", ...(hidden > 0 ? [`… ${hidden} earlier lines`] : []), ...tail];
	return body.map((line) => truncateToWidth(line, width, "…"));
}
