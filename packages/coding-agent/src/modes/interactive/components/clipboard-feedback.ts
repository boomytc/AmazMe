import { type Component, truncateToWidth, visibleWidth } from "@amazme/tui";
import { theme } from "../theme/theme.ts";

const COPY_FEEDBACK_DURATION_MS = 1500;

/** Transient feedback in the input dock, not in the conversation or a floating overlay. */
export class ClipboardFeedback implements Component {
	private visible = false;
	private disposed = false;
	private timer?: NodeJS.Timeout;
	private readonly requestRender: () => void;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	showCopied(): void {
		if (this.disposed) return;
		if (this.timer) clearTimeout(this.timer);
		this.visible = true;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.visible = false;
			this.requestRender();
		}, COPY_FEEDBACK_DURATION_MS);
		this.timer.unref();
		this.requestRender();
	}

	render(width: number): string[] {
		if (!this.visible) return [];
		const columns = Math.max(0, width);
		const text = truncateToWidth(theme.fg("success", "Copied!"), columns, "");
		return [" ".repeat(Math.max(0, columns - visibleWidth(text))) + text];
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.visible = false;
		this.disposed = true;
	}
}
