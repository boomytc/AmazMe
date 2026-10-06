import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@amazme/tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type { StatusIndicator } from "./status-indicator.ts";

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	public readonly embedWorkingStatus: boolean;
	private modelLabel: (() => string) | undefined;
	private shortcutLine: (() => string) | undefined;
	private boxTop = 0;
	private menuLines = 0;
	private boxed = false;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Return true when the interactive session consumed the key. */
	public onBeforeInput?: (data: string) => boolean;
	/** Child transcript view hides the composer by skipping its render. */
	public hidden = false;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	setModelLabel(label: () => string): void {
		this.modelLabel = label;
	}

	setShortcutLine(line: () => string): void {
		this.shortcutLine = line;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (!this.embedWorkingStatus || !this.workingStatusIndicator || width <= 0) {
			return super.renderTopBorder(width, hiddenLineCount);
		}

		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);

		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;

		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			statusWidth = visibleWidth(status);
		}

		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			return (
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.boxed) return super.handleMouse(event);
		if (this.menuLines > 0 && event.y >= 1 && event.y < 1 + this.menuLines) {
			return super.handleMouse({
				...event,
				y: this.renderedMenuY(event.y),
				x: event.x - 1,
				width: Math.max(1, event.width - 4),
			});
		}
		if (event.y < this.boxTop) return undefined;
		return super.handleMouse({
			...event,
			y: event.y - this.boxTop,
			x: event.x - 3,
			width: Math.max(1, event.width - 4),
		});
	}

	override render(width: number): string[] {
		if (this.hidden) return [];
		if (width < 8) {
			this.boxed = false;
			this.boxTop = 0;
			this.menuLines = 0;
			return super.render(width);
		}
		const inner = width - 4;
		const raw = super.render(inner);
		const visible = this.renderedVisibleLineCount;
		const menu = raw.slice(visible + 2);
		const content = raw.slice(1, 1 + visible);
		this.menuLines = menu.length;
		this.boxTop = menu.length > 0 ? menu.length + 3 : 0;
		this.boxed = true;
		const lines: string[] = [];
		if (menu.length > 0) {
			lines.push(this.borderColor(`╭${"─".repeat(width - 2)}╮`));
			for (const item of menu) {
				const pad = " ".repeat(Math.max(0, width - 2 - visibleWidth(item)));
				lines.push(`${this.borderColor("│")}${item}${pad}${this.borderColor("│")}`);
			}
			lines.push(this.borderColor(`╰${"─".repeat(width - 2)}╯`));
			lines.push("");
		}
		lines.push(`${this.borderColor("╭")}${this.renderTopBorder(width - 2, this.scrollOffset)}${this.borderColor("╮")}`);
		content.forEach((line, index) => {
			lines.push(`${this.borderColor("│")}${index === 0 ? "> " : "  "}${line}${this.borderColor("│")}`);
		});
		lines.push(this.bottomBorder(width));
		lines.push(truncateToWidth(this.shortcutBar(), width, ""));
		return lines;
	}

	private renderedMenuY(y: number): number {
		return this.renderedVisibleLineCount + 2 + (y - 1);
	}

	private bottomBorder(width: number): string {
		const inner = width - 2;
		const label = (this.modelLabel?.() ?? "").replace(/\s+/g, " ").trim();
		if (label.length === 0 || visibleWidth(label) + 6 > inner) {
			return this.borderColor(`╰${"─".repeat(Math.max(0, inner))}╯`);
		}
		const right = 2;
		const left = Math.max(1, inner - visibleWidth(label) - right - 2);
		return (
			this.borderColor(`╰${"─".repeat(left)} `) +
			`\x1b[2m${label}\x1b[22m` +
			this.borderColor(` ${"─".repeat(right)}╯`)
		);
	}

	private shortcutBar(): string {
		const supplied = this.shortcutLine?.();
		if (supplied) return supplied;
		const chip = (key: string, action: string) => `\x1b[1m${key}\x1b[22m:${action}`;
		return [chip("Ctrl+\\", "dashboard"), chip("Ctrl+c", "cancel"), chip("Tab", "complete"), chip("Cmd+⌫", "line")].join(
			" │ ",
		);
	}

	handleInput(data: string): void {
		if (this.onBeforeInput?.(data)) {
			return;
		}

		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
