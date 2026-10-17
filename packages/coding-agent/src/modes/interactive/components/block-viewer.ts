import { type Component, matchesKey, Text, truncateToWidth } from "@amazme/tui";
import { theme } from "../theme/theme.ts";

const PAGE_LINES = 18;

/**
 * Full-text viewer for one transcript block, shown as a centered overlay.
 *
 * The scrollback renders blocks with renderer-specific chrome, so the viewer keeps the
 * copyable text and adds only a title, position, and scroll keys.
 */
export class BlockViewer implements Component {
	private readonly text: string;
	private readonly title: string;
	private readonly onClose: () => void;
	private scroll = 0;
	private body: string[] = [];
	private renderedWidth = 0;

	constructor(title: string, text: string, onClose: () => void) {
		this.title = title;
		this.text = text;
		this.onClose = onClose;
	}

	invalidate(): void {
		this.renderedWidth = 0;
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) {
			this.onClose();
			return true;
		}
		if (matchesKey(data, "up")) return this.scrollBy(-1);
		if (matchesKey(data, "down")) return this.scrollBy(1);
		if (matchesKey(data, "pageUp")) return this.scrollBy(-PAGE_LINES);
		if (matchesKey(data, "pageDown")) return this.scrollBy(PAGE_LINES);
		return false;
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		if (this.renderedWidth !== innerWidth) {
			this.body = new Text(this.text, 1, 0).render(innerWidth);
			this.renderedWidth = innerWidth;
		}
		const maxScroll = Math.max(0, this.body.length - PAGE_LINES);
		this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
		const visible = this.body.slice(this.scroll, this.scroll + PAGE_LINES);
		const position = this.body.length === 0 ? "0/0" : `${this.scroll + 1}-${this.scroll + visible.length}/${this.body.length}`;
		const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
		return [
			truncateToWidth(theme.bold(theme.fg("accent", this.title)), width, "…"),
			rule,
			...visible,
			rule,
			truncateToWidth(theme.fg("dim", `Esc close · ↑/↓ scroll · ${position}`), width, "…"),
		];
	}

	private scrollBy(delta: number): boolean {
		const maxScroll = Math.max(0, this.body.length - PAGE_LINES);
		const next = Math.max(0, Math.min(maxScroll, this.scroll + delta));
		if (next === this.scroll) return false;
		this.scroll = next;
		return true;
	}
}
