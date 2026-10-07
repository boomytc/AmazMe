/**
 * The page's view model: a pure projection of the host's replicated state into blocks the DOM
 * renderer can drop in. It reads the same durable `ConversationView` the TUI presentation renders
 * and keeps no state of its own, so there is one transcript model and two renderers.
 */
import type { AssistantMessage, Message, ToolCall, ToolResultMessage, UserMessage } from "@amazme/ai";
import {
	AssistantEntry,
	CompactionEntry,
	type ConversationView,
	type EntryId,
	type EntryRecord,
	type InboxState,
	type LiveState,
	ResetEntry,
	ToolResultEntry,
	UserEntry,
} from "@amazme/durable";
import { CHAT_VIEW, panelView, type PanelView, type PanelViewInput } from "./panels.ts";

export type BlockTone = "plain" | "muted" | "error";

export interface TranscriptBlock {
	/** Stable key: entry id, or the live marker for a provisional block. */
	readonly id: EntryId | string;
	readonly kind: "user" | "assistant" | "thinking" | "tool" | "notice";
	readonly title: string;
	readonly text: string;
	readonly tone: BlockTone;
	readonly running: boolean;
}

export interface RosterItem {
	readonly id: string;
	readonly label: string;
	readonly age: string;
	readonly ageIso: string;
	readonly attached: boolean;
}

/** One catalog entry the picker offers. */
export interface ModelOption {
	readonly provider: string;
	readonly modelId: string;
	readonly label: string;
	readonly selected: boolean;
}

/** Catalog entries under their provider, the way the picker's card lists them. */
export interface ModelGroup {
	readonly provider: string;
	readonly options: readonly ModelOption[];
}

/** One thinking level the attached model reports. */
export interface ThinkingOption {
	readonly level: string;
	readonly label: string;
	readonly selected: boolean;
}

/** The composer's model and effort control: the chip's text plus the card it opens. */
export interface ModelPicker {
	/** The chip's primary text: the configured model's name. */
	readonly label: string;
	/** The chip's secondary text: the configured level, for a model that reports levels. */
	readonly effort: string | undefined;
	readonly groups: readonly ModelGroup[];
	readonly levels: readonly ThinkingOption[];
	/** The card's line when the host's catalog is empty, so the control never looks broken. */
	readonly empty: string | undefined;
	/** The effort group's line when the attached model reports nothing above `off`. */
	readonly levelsEmpty: string | undefined;
	/** No attached session or no models service: the trigger is inert. */
	readonly disabled: boolean;
}

/** The sidebar's new-session control. Its label is page copy; only its state is projected. */
export interface NewSessionAffordance {
	/** The host is reachable, so it can take a create. */
	readonly enabled: boolean;
}

export interface WebView {
	readonly roster: readonly RosterItem[];
	readonly blocks: readonly TranscriptBlock[];
	readonly status: string;
	readonly queue: readonly string[];
	readonly attachedId: string | undefined;
	readonly empty: string | undefined;
	/** Whether a turn is in flight: the composer's primary action becomes the stop control. */
	readonly busy: boolean;
	readonly newSession: NewSessionAffordance;
	readonly model: ModelPicker;
	/** The sidebar's navigation and the management panel the main area shows. */
	readonly panel: PanelView;
}

/** The `amazme.live` document of a view: the active run, the streaming answer, and running tools. */
export function liveOf(view: ConversationView): LiveState {
	return (view.docs["amazme.live"] ?? {}) as LiveState;
}

/** The `amazme.inbox` document of a view: inputs the session accepted but has not started yet. */
export function inboxOf(view: ConversationView): InboxState {
	return (view.docs["amazme.inbox"] ?? { items: [] }) as InboxState;
}

/** One hosted Session as the host publishes it; only the fields the roster shows. */
export interface SessionSummaryLike {
	readonly serverId?: string;
	readonly sessionId: string;
	readonly createdAt: number;
}

/** The host's replicated session directory, as this package reads it. */
export interface SessionDirectoryLike {
	readonly sessions: readonly SessionSummaryLike[];
}

/** One catalog entry of the host's `amazme.models` state; only the fields the picker shows. */
export interface ModelSummaryLike {
	readonly provider: string;
	readonly modelId: string;
	readonly name: string;
	readonly reasoning: boolean;
}

/** The host's replicated `amazme.models` state, as this package reads it. */
export interface ModelsStateLike {
	readonly catalog: { readonly revision: number; readonly availableModels: readonly ModelSummaryLike[] };
	readonly configuration: {
		readonly model: { readonly provider: string; readonly modelId: string } | null;
		readonly thinkingLevel: string;
	};
}

export interface WebViewInput {
	readonly directory: SessionDirectoryLike | undefined;
	readonly transcript: ConversationView | undefined;
	readonly attachedId: string | undefined;
	readonly now: number;
	readonly models: ModelsStateLike | undefined;
	/** The levels the host reports for the attached model; `undefined` until the page has read them. */
	readonly thinkingLevels: readonly string[] | undefined;
	/** The management view the page is showing, with the state of that area's services. */
	readonly panel: PanelViewInput;
}

/** The host has no session attached yet, so the picker's trigger stays inert. */
export const MODEL_PICKER_EMPTY: ModelPicker = {
	label: "No model",
	effort: undefined,
	groups: [],
	levels: [],
	empty: undefined,
	levelsEmpty: undefined,
	disabled: true,
};

/** The level names DSH's model catalog publishes; the platform's own vocabulary. */
export function thinkingLevelLabel(level: string): string {
	return level.length === 0 ? level : `${level[0]?.toUpperCase() ?? ""}${level.slice(1)}`;
}
/**
 * The picker the composer chip opens: the host's catalog grouped by provider, the levels the
 * attached model reports, and the two empty states that keep the control explainable.
 */
export function modelPicker(
	models: ModelsStateLike | undefined,
	levels: readonly string[] | undefined,
	attached: boolean,
): ModelPicker {
	if (models === undefined || !attached) return MODEL_PICKER_EMPTY;
	const configured = models.configuration.model;
	const byProvider = new Map<string, ModelOption[]>();
	for (const model of models.catalog.availableModels) {
		const options = byProvider.get(model.provider) ?? [];
		if (!byProvider.has(model.provider)) byProvider.set(model.provider, options);
		options.push({
			provider: model.provider,
			modelId: model.modelId,
			label: model.name,
			selected: configured?.provider === model.provider && configured.modelId === model.modelId,
		});
	}
	const groups: ModelGroup[] = [...byProvider]
		.map(([provider, options]) => ({ provider, options }))
		.sort((left, right) => left.provider.localeCompare(right.provider));
	const current = models.catalog.availableModels.find(
		(model) => model.provider === configured?.provider && model.modelId === configured?.modelId,
	);
	const label =
		current?.name ??
		(configured === null || configured === undefined ? "No model" : `${configured.provider}/${configured.modelId}`);
	// Levels read as `undefined` until the page has asked the host: no chip, and no verdict yet.
	const reasoned = levels !== undefined && levels.length > 1;
	return {
		label,
		effort: reasoned ? thinkingLevelLabel(models.configuration.thinkingLevel) : undefined,
		groups,
		levels: (levels ?? []).map((level) => ({
			level,
			label: thinkingLevelLabel(level),
			selected: level === models.configuration.thinkingLevel,
		})),
		empty: groups.length === 0 ? "No models available." : undefined,
		levelsEmpty:
			levels === undefined || reasoned ? undefined : "This model provides no reasoning effort levels.",
		disabled: false,
	};
}

export function formatAge(createdAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export function rosterItems(
	state: SessionDirectoryLike | undefined,
	attachedId: string | undefined,
	now: number,
): RosterItem[] {
	const sessions = state?.sessions ?? [];
	return [...sessions]
		.sort(
			(left: SessionSummaryLike, right: SessionSummaryLike) =>
				right.createdAt - left.createdAt ||
				(left.serverId ?? "").localeCompare(right.serverId ?? "") ||
				left.sessionId.localeCompare(right.sessionId),
		)
		.map((session) => ({
			id: session.sessionId,
			label: session.sessionId,
			age: formatAge(session.createdAt, now),
			ageIso: new Date(session.createdAt).toISOString(),
			attached: attachedId === session.sessionId,
		}));
}

function messageText(content: Message["content"], separator: string): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}

function userText(content: UserMessage["content"]): string {
	return messageText(content, "");
}

function assistantText(content: AssistantMessage["content"]): string {
	return messageText(content, "\n\n");
}

function thinkingText(content: AssistantMessage["content"]): string {
	return content
		.filter((block) => block.type === "thinking")
		.map((block) => block.thinking)
		.join("\n\n");
}

function toolCallText(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

/** The failure notice the TUI shows for a committed answer that never completed, if any. */
function failureNotice(message: AssistantMessage): { title: string; text: string } | undefined {
	if (message.stopReason === "length") return { title: "Truncated", text: "Response was truncated before completion." };
	// A tool-calling answer shows the failure on its cards instead.
	if (message.content.some((block) => block.type === "toolCall")) return undefined;
	if (message.stopReason === "aborted") {
		const detail = message.errorMessage;
		return { title: "Aborted", text: detail !== undefined && detail !== "Request was aborted" ? detail : "Operation aborted" };
	}
	if (message.stopReason === "error") {
		return { title: "Error", text: message.errorMessage ?? "Unknown error" };
	}
	return undefined;
}

function toolResultText(message: ToolResultMessage): string {
	const text = messageText(message.content, "\n\n").trim();
	if (text.length > 0) return text;
	return message.isError ? "Tool reported an error" : "(no output)";
}

function queuedItemText(item: InboxState["items"][number]): string {
	const body =
		item.mode === "write"
			? `<${String(item.entry.kind)}>`
			: userText(item.content as UserMessage["content"]).replace(/\s+/g, " ");
	return `[${item.mode}] ${body}`;
}

function textOf(entry: EntryRecord): Message | undefined {
	return entry.model?.[0];
}

/** Entry ids the current context still shows, plus the live partial and running calls. */
export function transcriptBlocks(view: ConversationView | undefined): TranscriptBlock[] {
	if (view === undefined) return [];
	const results = new Map<string, ToolResultMessage>();
	for (const entry of view.entries) {
		if (entry.kind !== ToolResultEntry.kind) continue;
		const message = textOf(entry);
		if (message?.role !== "toolResult") continue;
		results.set(message.toolCallId, message);
	}

	const live = liveOf(view);
	const runningCalls = new Set((live.tools ?? []).filter((slot) => slot.status === "running").map((slot) => slot.callId));
	const blocks: TranscriptBlock[] = [];
	const pushTool = (call: ToolCall, ran: boolean, streaming: boolean): void => {
		const result = results.get(call.id);
		const running = result === undefined && (streaming || runningCalls.has(call.id));
		const slot = (live.tools ?? []).find((candidate) => candidate.callId === call.id);
		const text =
			result !== undefined
				? toolResultText(result)
				: running
					? (slot?.output ?? "")
					: ran
						? ""
						: "Not run: the answer was interrupted.";
		blocks.push({
			id: `tool:${call.id}`,
			kind: "tool",
			title: call.name,
			text,
			tone: result?.isError === true ? "error" : "plain",
			running,
		});
	};

	for (const entry of view.entries) {
		const message = textOf(entry);
		switch (entry.kind) {
			case UserEntry.kind:
				if (message?.role === "user") {
					blocks.push({
						id: entry.id,
						kind: "user",
						title: "You",
						text: userText(message.content),
						tone: "plain",
						running: false,
					});
				}
				break;
			case AssistantEntry.kind:
				if (message?.role === "assistant") {
					const thinking = thinkingText(message.content);
					if (thinking.length > 0) {
						blocks.push({
							id: `${entry.id}:thinking`,
							kind: "thinking",
							title: "Thinking",
							text: thinking,
							tone: "muted",
							running: false,
						});
					}
					const answer = assistantText(message.content);
					const failure = failureNotice(message);
					// A failed answer with no text is the failure notice alone, not an empty card above it.
					if (answer.length > 0 || failure === undefined) {
						blocks.push({
							id: entry.id,
							kind: "assistant",
							title: "AmazMe",
							text: answer,
							tone: "plain",
							running: false,
						});
					}
					if (failure !== undefined) {
						blocks.push({
							id: `${entry.id}:failure`,
							kind: "notice",
							title: failure.title,
							text: failure.text,
							tone: "error",
							running: false,
						});
					}
					// Only a tool-calling answer runs its calls; an aborted, failed, or truncated one never does.
					for (const call of toolCallText(message)) pushTool(call, message.stopReason === "toolUse", false);
				}
				break;
			case CompactionEntry.kind:
				blocks.push({
					id: entry.id,
					kind: "notice",
					title: "Compaction",
					text: message?.role === "user" ? userText(message.content) : "",
					tone: "muted",
					running: false,
				});
				break;
			case ResetEntry.kind:
				blocks.push({
					id: entry.id,
					kind: "notice",
					title: "New context",
					text: "",
					tone: "muted",
					running: false,
				});
				break;
			default:
				break;
		}
	}

	const partial = live.generation?.message as AssistantMessage | undefined;
	if (partial !== undefined) {
		blocks.push({
			id: "live:generation",
			kind: "assistant",
			title: "AmazMe",
			text: assistantText(partial.content),
			tone: "plain",
			running: true,
		});
		for (const call of toolCallText(partial)) {
			if (blocks.some((block) => block.id === `tool:${call.id}`)) continue;
			pushTool(call, true, true);
		}
	}
	for (const slot of live.tools ?? []) {
		if (slot.status !== "running") continue;
		if (blocks.some((block) => block.id === `tool:${slot.callId}`)) continue;
		blocks.push({
			id: `tool:${slot.callId}`,
			kind: "tool",
			title: slot.name,
			text: slot.output ?? "",
			tone: "plain",
			running: true,
		});
	}
	return blocks;
}

/** The one live status line, with the same precedence the TUI status indicator uses. */
export function sessionStatus(view: ConversationView | undefined): string {
	if (view === undefined) return "";
	const live = liveOf(view);
	const generation = live.generation;
	const compaction = live.compactions?.[0];
	const runningTool = live.tools?.find((slot) => slot.status === "running");
	if (generation?.retry !== undefined) return `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;
	if (generation?.deferred !== undefined) return "Waiting for deferred response…";
	if (compaction !== undefined) {
		return compaction.retry
			? `Retrying ${compaction.reason} compaction (attempt ${compaction.attempt + 1})…`
			: `Compacting (${compaction.reason})…`;
	}
	if (runningTool !== undefined) return `Running ${runningTool.name}…`;
	if (live.run !== undefined) return "Working…";
	return "";
}

/** Whether the session is running: a prompt then steers or queues instead of starting a run. */
export function isBusy(view: ConversationView | undefined): boolean {
	return view !== undefined && liveOf(view).run !== undefined;
}

/** The composer's placeholder names what the next submit will do. */
export function composerPlaceholder(attachedId: string | undefined): string {
	return attachedId === undefined ? "No session attached" : `Send a task to ${attachedId}`;
}

/** Inputs the session has accepted but not started yet. */
export function queuedInputs(view: ConversationView | undefined): string[] {
	const inbox = view === undefined ? { items: [] } : inboxOf(view);
	return inbox.items.map(queuedItemText);
}

/** The view a page shows when it cannot reach or trust the host. */
export function failureView(text: string): WebView {
	return {
		roster: [],
		blocks: [],
		status: "",
		queue: [],
		attachedId: undefined,
		empty: text,
		busy: false,
		newSession: { enabled: false },
		model: MODEL_PICKER_EMPTY,
		panel: panelView({ current: CHAT_VIEW }),
	};
}

export function buildWebView(input: WebViewInput): WebView {
	const blocks = transcriptBlocks(input.transcript);
	const roster = rosterItems(input.directory, input.attachedId, input.now);
	const empty =
		input.directory === undefined
			? "Connecting to the host…"
			: roster.length === 0
				? "No sessions on this host yet."
				: undefined;
	return {
		roster,
		blocks,
		status: sessionStatus(input.transcript),
		queue: queuedInputs(input.transcript),
		attachedId: input.attachedId,
		empty,
		busy: isBusy(input.transcript),
		// Only a reachable host can take a create; the roster appears with the same state.
		newSession: { enabled: input.directory !== undefined },
		model: modelPicker(input.models, input.thinkingLevels, input.attachedId !== undefined),
		panel: panelView(input.panel),
	};
}
