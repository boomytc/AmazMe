import type { AssistantMessage } from "@amazme/ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@amazme/tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { formatTokens } from "./footer.ts";
import { formatToolDuration } from "../../../core/tools/render-utils.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { markSelectedLines } from "./transcript-selection.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private static nextRowId = 0;
	readonly transcriptRowId = `assistant-${++AssistantMessageComponent.nextRowId}`;
	readonly transcriptRowLabel = "assistant";
	readonly transcriptRowText = (): string | undefined => this.collectText();
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	private readonly thinkingStartedAt = new Map<number, number>();
	private readonly thinkingDurationMs = new Map<number, number>();
	private readonly thinkingText = new Map<number, string>();
	private turnStartedAt: number | undefined;
	private turnDurationMs: number | undefined;
	private turnActions: TurnActions | undefined;
	private turnTimer: ReturnType<typeof setInterval> | undefined;
	private readonly turnStatus = new TurnStatusLine();
	private selected = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);
		this.addChild(this.turnStatus);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setSelected(selected: boolean): void {
		this.selected = selected;
	}

	/** Stop control for the live `[stop]` bracket, plus a render tick for the running clock. */
	setTurnActions(actions: TurnActions | undefined): void {
		this.turnActions = actions;
		this.turnStatus.setStop(actions?.stop);
		if (actions === undefined) this.#clearTurnTimer();
		else this.#syncTurnTimer();
	}

	override render(width: number): string[] {
		const rendered = super.render(width);
		const lines = this.selected ? markSelectedLines(rendered, width) : rendered;
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	private turnStatusModel(): TurnStatusModel | undefined {
		const message = this.lastMessage;
		if (!message) return undefined;
		if (this.isStreaming) {
			const elapsed = this.turnStartedAt === undefined ? 0 : Math.max(0, Date.now() - this.turnStartedAt);
			return {
				streaming: true,
				durationMs: elapsed,
				outputTokens: message.usage.output,
				bracket: "[stop]",
				clickable: this.turnActions !== undefined,
			};
		}
		if (message.stopReason === "pending" || message.stopReason === "deferred") return undefined;
		const durationMs = message.durationMs ?? this.turnDurationMs;
		if (durationMs === undefined && message.usage.output <= 0) return undefined;
		return {
			streaming: false,
			durationMs,
			outputTokens: message.usage.output,
			bracket: `[${message.stopReason}]`,
			clickable: false,
		};
	}

	private noteTurnDuration(isStreaming: boolean): void {
		if (isStreaming) {
			if (this.turnStartedAt === undefined) this.turnStartedAt = Date.now();
			return;
		}
		if (this.turnStartedAt !== undefined && this.turnDurationMs === undefined) {
			this.turnDurationMs = Math.max(0, Date.now() - this.turnStartedAt);
		}
	}

	#syncTurnTimer(): void {
		const want = this.isStreaming && this.turnActions !== undefined;
		if (want && this.turnTimer === undefined) {
			this.turnTimer = setInterval(() => this.turnActions?.requestRender(), 1000);
			return;
		}
		if (!want) this.#clearTurnTimer();
	}

	#clearTurnTimer(): void {
		if (this.turnTimer === undefined) return;
		clearInterval(this.turnTimer);
		this.turnTimer = undefined;
	}

	/** Collapsed row: `◆ Thinking…` while it runs, `◆ Thinking… 2.5s` once that run has finished. */
	private thinkingSummary(runIndex: number): string {
		const duration = this.thinkingDurationMs.get(runIndex);
		const label = duration === undefined ? "Thinking…" : `Thinking… ${formatToolDuration(duration)}`;
		return theme.fg("dim", "◆ ") + theme.italic(theme.fg("thinkingText", label));
	}

	private noteThinkingDuration(runIndex: number, thinkingText: string, hasContentAfter: boolean): void {
		const started = this.thinkingStartedAt.get(runIndex);
		if (this.isStreaming) {
			if (started === undefined) {
				this.thinkingStartedAt.set(runIndex, Date.now());
				this.thinkingText.set(runIndex, thinkingText);
				return;
			}
			const grew = this.thinkingText.get(runIndex) !== thinkingText;
			this.thinkingText.set(runIndex, thinkingText);
			if (!grew && hasContentAfter && !this.thinkingDurationMs.has(runIndex)) {
				this.thinkingDurationMs.set(runIndex, Math.max(0, Date.now() - started));
			}
			return;
		}
		if (started !== undefined && !this.thinkingDurationMs.has(runIndex)) {
			this.thinkingDurationMs.set(runIndex, Math.max(0, Date.now() - started));
		}
	}

	/** Copyable text of the rendered message, without tool calls or chrome. */
	private collectText(): string | undefined {
		const message = this.lastMessage;
		if (!message) return undefined;
		const parts: string[] = [];
		for (const content of message.content) {
			if (content.type === "text") parts.push(content.text);
			else if (content.type === "thinking") parts.push(content.thinking);
		}
		const text = parts.join("\n").trim();
		return text.length === 0 ? undefined : text;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.noteTurnDuration(isStreaming);
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		this.turnStatus.update(this.turnStatusModel());
		this.#syncTurnTimer();

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		if (message.diagnostics?.some(diagnostic => diagnostic.type === "image_payload_recovery")) {
			this.contentContainer.addChild(new Text(theme.fg("warning", "Retried without images. This response cannot see them; original attachments are preserved."), this.outputPad, 0));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const runIndex = thinkingRunIndex++;
				this.noteThinkingDuration(runIndex, thinkingBlocks.join("\n\n"), hasVisibleContentAfter);
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				const thinkingComponent = hidden
					? new Text(this.thinkingSummary(runIndex), this.outputPad, 0)
					: new Markdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad,
							0,
							this.markdownTheme,
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						);
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}

interface TurnActions {
	stop(): void;
	requestRender(): void;
}

interface TurnStatusModel {
	readonly streaming: boolean;
	readonly durationMs: number | undefined;
	readonly outputTokens: number;
	readonly bracket: string;
	readonly clickable: boolean;
}

/** Right-aligned turn clock. While the answer runs, `[stop]` is a hover-red stop button. */
class TurnStatusLine implements Component {
	private model: TurnStatusModel | undefined;
	private onStop: (() => void) | undefined;
	private hovered = false;
	private stopStart = -1;
	private stopEnd = -1;

	setStop(stop: (() => void) | undefined): void {
		this.onStop = stop;
	}

	update(model: TurnStatusModel | undefined): void {
		this.model = model;
		if (model?.clickable !== true) this.hovered = false;
	}

	render(width: number): string[] {
		const model = this.model;
		if (!model) return [];
		const parts: string[] = [];
		if (model.durationMs !== undefined) parts.push(formatTurnDuration(model.durationMs));
		if (model.outputTokens > 0) parts.push(`↓${formatTokens(model.outputTokens)}`);
		parts.push(model.bracket);
		const head = parts.slice(0, -1).join(" ");
		const gap = head.length > 0 ? " " : "";
		const plain = head + gap + model.bracket;
		const pad = Math.max(0, width - visibleWidth(plain));
		this.stopStart = model.clickable ? pad + visibleWidth(head + gap) : -1;
		this.stopEnd = model.clickable ? this.stopStart + visibleWidth(model.bracket) : -1;
		const bracket = model.clickable && this.hovered ? theme.fg("error", model.bracket) : theme.fg("muted", model.bracket);
		const prefix = head.length > 0 ? theme.fg("muted", head + gap) : "";
		return [" ".repeat(pad) + prefix + bracket];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.model?.clickable !== true || event.y !== 0) return undefined;
		const over = event.x >= this.stopStart && event.x < this.stopEnd;
		if (event.type === "move") {
			if (over === this.hovered) return over ? { handled: true, render: false } : undefined;
			this.hovered = over;
			return { handled: true, render: true };
		}
		if (event.type === "click" && over) {
			this.onStop?.();
			return { handled: true };
		}
		return undefined;
	}

	handleMouseLeave(): boolean {
		if (!this.hovered) return false;
		this.hovered = false;
		return true;
	}

	invalidate(): void {}
}

/** Whole-turn clock, compact like `2.5s` and `15m58s`. */
function formatTurnDuration(ms: number): string {
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
}
