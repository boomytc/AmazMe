/**
 * The page's view model: a pure projection of the host's replicated state into blocks the DOM
 * renderer can drop in. It reads the same durable `ConversationView` the TUI presentation renders
 * and keeps no state of its own, so there is one transcript model and two renderers.
 *
 * Every string here comes from `strings.ts` in the reader's language, including the host's own
 * vocabulary: a tool name, a model name, and a reasoning level are data, while a status line or a
 * block title is copy.
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
import { ATTACHMENT_REMOVE_ACTION, COMPACT_ACTION, QUEUE_CANCEL_ACTION, SESSION_REMOVE_ACTION } from "./actions.ts";
import type { Locale } from "./locale.ts";
import { CHAT_VIEW, panelView, type PanelButton, type PanelView, type PanelViewInput } from "./panels.ts";
import { thinkingLevelCopy, translate } from "./strings.ts";

export type BlockTone = "plain" | "muted" | "error";

export interface TranscriptBlock {
	/** Stable key: entry id, or the live marker for a provisional block. */
	readonly id: EntryId | string;
	readonly kind: "user" | "assistant" | "thinking" | "tool" | "notice";
	readonly title: string;
	readonly text: string;
	/** Images the entry carries, as data URLs the reader sees. */
	readonly images?: readonly { readonly dataUrl: string; readonly alt: string }[];
	readonly tone: BlockTone;
	readonly running: boolean;
}

export interface RosterItem {
	readonly id: string;
	readonly label: string;
	/** The session's working directory, shown so two sessions are tellable apart. */
	readonly cwd: string | undefined;
	readonly age: string;
	readonly ageIso: string;
	readonly attached: boolean;
	/** The control that asks to remove this session; the page confirms first. */
	readonly remove: PanelButton;
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
	/** The catalog's refresh state: the control to ask for one, and the host's last word. */
	readonly refresh: ModelRefresh;
}

/** The model card's refresh row: a button plus the status the host's state reports. */
export interface ModelRefresh {
	readonly label: string;
	/** The host's last refresh outcome, or undefined while it has never refreshed. */
	readonly status: string | undefined;
	/** A refresh is in flight, so the control waits for it. */
	readonly busy: boolean;
}

/** The image types the page sends, and how large one may be. */
export const ATTACHMENT_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/** Why one picked image cannot be sent: the copy key that explains it. */
export type AttachmentRejection = "composer.attachmentUnsupported" | "composer.attachmentTooLarge";

/** Whether one picked image can be sent, and if not, why. */
export function attachmentRejection(image: {
	readonly mediaType: string;
	readonly bytes: number;
}): AttachmentRejection | undefined {
	if (!ATTACHMENT_TYPES.includes(image.mediaType)) return "composer.attachmentUnsupported";
	if (image.bytes > ATTACHMENT_MAX_BYTES) return "composer.attachmentTooLarge";
	return undefined;
}

/** A size a reader can compare at a glance: `340 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One image the reader attached and has not sent yet, as the composer shows it. */
export interface Attachment {
	readonly id: string;
	readonly name: string;
	/** The thumbnail: the image itself as a data URL. */
	readonly dataUrl: string;
	/** Its size, so the row says what the prompt is about to carry. */
	readonly size: string;
	/** The control that drops only this image. */
	readonly remove: PanelButton;
}

/** The reader's pending images, ready for the composer's strip. */
export function attachments(
	locale: Locale,
	images: readonly {
		readonly id: string;
		readonly name: string;
		readonly dataUrl: string;
		readonly bytes: number;
	}[],
): Attachment[] {
	return images.map((image) => ({
		id: image.id,
		name: image.name,
		dataUrl: image.dataUrl,
		size: formatBytes(image.bytes),
		remove: {
			id: ATTACHMENT_REMOVE_ACTION,
			label: translate(locale, "composer.removeAttachment"),
			tone: "default",
			data: image.id,
		},
	}));
}

/** One queued input the session accepted but has not started. */
export interface QueueItem {
	/** The inbox submission id, the subject of a withdraw. */
	readonly id: string;
	readonly text: string;
	/** The withdraw control, so the row carries its own cancel. */
	readonly cancel: PanelButton;
}

/** How the next submit is applied while a turn runs. */
export type SubmitMode = "steer" | "followUp";

export interface SubmitModeOption {
	readonly mode: SubmitMode;
	readonly label: string;
	readonly selected: boolean;
}

/** The controls around the conversation: compaction, and how a busy turn takes input. */
export interface RunControls {
	/** The header's compaction control. */
	readonly compact: PanelButton;
	/** The composer's mode toggle, offered while a turn runs. */
	readonly submitModes: readonly SubmitModeOption[];
}

/** The sidebar's new-session control. Its label is page copy; only its state is projected. */
export interface NewSessionAffordance {
	/** The host is reachable, so it can take a create. */
	readonly enabled: boolean;
}

export interface WebView {
	/** The language this view's copy is in; the renderer reads it for its own chrome too. */
	readonly locale: Locale;
	/** The roster, narrowed by the reader's filter. */
	readonly roster: readonly RosterItem[];
	/** The filter text itself, so the input keeps what the reader typed. */
	readonly rosterFilter: string;
	readonly blocks: readonly TranscriptBlock[];
	readonly status: string;
	readonly queue: readonly QueueItem[];
	/** Images attached but not sent yet. */
	readonly attachments: readonly Attachment[];
	readonly run: RunControls;
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
	readonly cwd?: string;
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
	readonly refresh:
		| { readonly status: "idle" | "refreshing" | "done" }
		| { readonly status: "warning"; readonly errors: Readonly<Record<string, string>> };
}

export interface WebViewInput {
	/** The reader's language, resolved from the stored preference and the browser. */
	readonly locale: Locale;
	readonly directory: SessionDirectoryLike | undefined;
	readonly transcript: ConversationView | undefined;
	readonly attachedId: string | undefined;
	readonly now: number;
	readonly models: ModelsStateLike | undefined;
	/** The levels the host reports for the attached model; `undefined` until the page has read them. */
	readonly thinkingLevels: readonly string[] | undefined;
	/** How the page would submit while a turn runs; the page owns this choice. */
	readonly submitMode: SubmitMode;
	/** The images the reader attached and has not sent. */
	readonly attachments: readonly {
		readonly id: string;
		readonly name: string;
		readonly dataUrl: string;
		readonly bytes: number;
	}[];
	/** The roster's filter text; the page owns it so a repaint never clears it. */
	readonly rosterFilter: string;
	/** The management view the page is showing, with the state of that area's services. */
	readonly panel: PanelViewInput;
}

/** The host has no session attached yet, so the picker's trigger stays inert. */
export function modelPickerEmpty(locale: Locale): ModelPicker {
	return {
		label: translate(locale, "model.none"),
		effort: undefined,
		groups: [],
		levels: [],
		empty: undefined,
		levelsEmpty: undefined,
		disabled: true,
		refresh: { label: translate(locale, "model.refresh"), status: undefined, busy: false },
	};
}

/** The host's refresh state as one line, or undefined when it has never refreshed. */
function refreshStatus(locale: Locale, refresh: ModelsStateLike["refresh"]): string | undefined {
	switch (refresh.status) {
		case "idle":
			return undefined;
		case "refreshing":
			return translate(locale, "model.refreshing");
		case "done":
			return translate(locale, "model.refreshDone");
		case "warning": {
			const providers = Object.keys(refresh.errors).join(", ");
			return translate(locale, "model.refreshWarning", { providers });
		}
	}
}

/**
 * The picker the composer chip opens: the host's catalog grouped by provider, the levels the
 * attached model reports, and the two empty states that keep the control explainable.
 */
export function modelPicker(
	locale: Locale,
	models: ModelsStateLike | undefined,
	levels: readonly string[] | undefined,
	attached: boolean,
): ModelPicker {
	if (models === undefined || !attached) return modelPickerEmpty(locale);
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
		(configured === null || configured === undefined
			? translate(locale, "model.none")
			: `${configured.provider}/${configured.modelId}`);
	// Levels read as `undefined` until the page has asked the host: no chip, and no verdict yet.
	const reasoned = levels !== undefined && levels.length > 1;
	return {
		label,
		effort: reasoned ? thinkingLevelCopy(locale, models.configuration.thinkingLevel) : undefined,
		groups,
		levels: (levels ?? []).map((level) => ({
			level,
			label: thinkingLevelCopy(locale, level),
			selected: level === models.configuration.thinkingLevel,
		})),
		empty: groups.length === 0 ? translate(locale, "model.empty") : undefined,
		levelsEmpty:
			levels === undefined || reasoned ? undefined : translate(locale, "model.levelsEmpty"),
		disabled: false,
		refresh: {
			label: translate(locale, "model.refresh"),
			status: refreshStatus(locale, models.refresh),
			busy: models.refresh.status === "refreshing",
		},
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

/**
 * The roster, newest first, narrowed by the reader's filter. A filter matches the session's id or
 * its working directory, so a path is as good a handle as the id.
 */
export function rosterItems(
	locale: Locale,
	state: SessionDirectoryLike | undefined,
	attachedId: string | undefined,
	now: number,
	filter = "",
): RosterItem[] {
	const sessions = state?.sessions ?? [];
	const needle = filter.trim().toLowerCase();
	return [...sessions]
		.filter(
			(session) =>
				needle.length === 0 ||
				session.sessionId.toLowerCase().includes(needle) ||
				(session.cwd ?? "").toLowerCase().includes(needle),
		)
		.sort(
			(left: SessionSummaryLike, right: SessionSummaryLike) =>
				right.createdAt - left.createdAt ||
				(left.serverId ?? "").localeCompare(right.serverId ?? "") ||
				left.sessionId.localeCompare(right.sessionId),
		)
		.map((session) => ({
			id: session.sessionId,
			label: session.sessionId,
			cwd: session.cwd,
			age: formatAge(session.createdAt, now),
			ageIso: new Date(session.createdAt).toISOString(),
			attached: attachedId === session.sessionId,
			remove: {
				id: SESSION_REMOVE_ACTION,
				label: translate(locale, "sidebar.remove"),
				tone: "danger",
				data: session.sessionId,
			},
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

/** The images one user message carries, as data URLs a browser can render. */
function userImages(content: UserMessage["content"]): { readonly dataUrl: string; readonly alt: string }[] {
	if (typeof content === "string") return [];
	return content.flatMap((block) =>
		block.type === "image"
			? [{ dataUrl: `data:${block.mimeType};base64,${block.data}`, alt: block.mimeType }]
			: [],
	);
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
function failureNotice(locale: Locale, message: AssistantMessage): { title: string; text: string } | undefined {
	if (message.stopReason === "length") {
		return { title: translate(locale, "block.truncated"), text: translate(locale, "block.truncatedText") };
	}
	// A tool-calling answer shows the failure on its cards instead.
	if (message.content.some((block) => block.type === "toolCall")) return undefined;
	if (message.stopReason === "aborted") {
		const detail = message.errorMessage;
		return {
			title: translate(locale, "block.aborted"),
			text:
				detail !== undefined && detail !== "Request was aborted"
					? detail
					: translate(locale, "block.abortedText"),
		};
	}
	if (message.stopReason === "error") {
		return {
			title: translate(locale, "block.error"),
			text: message.errorMessage ?? translate(locale, "block.errorText"),
		};
	}
	return undefined;
}

function toolResultText(locale: Locale, message: ToolResultMessage): string {
	const text = messageText(message.content, "\n\n").trim();
	if (text.length > 0) return text;
	return translate(locale, message.isError ? "tool.errorText" : "tool.noOutput");
}

function queuedItemText(locale: Locale, item: InboxState["items"][number]): string {
	const body =
		item.mode === "write"
			? `<${String(item.entry.kind)}>`
			: userText(item.content as UserMessage["content"]).replace(/\s+/g, " ");
	const mode =
		item.mode === "steer"
			? translate(locale, "queue.steer")
			: item.mode === "followUp"
				? translate(locale, "queue.followUp")
				: translate(locale, "queue.write");
	return `[${mode}] ${body}`;
}

function textOf(entry: EntryRecord): Message | undefined {
	return entry.model?.[0];
}

/** Entry ids the current context still shows, plus the live partial and running calls. */
export function transcriptBlocks(locale: Locale, view: ConversationView | undefined): TranscriptBlock[] {
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
				? toolResultText(locale, result)
				: running
					? (slot?.output ?? "")
					: ran
						? ""
						: translate(locale, "tool.notRun");
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
					const images = userImages(message.content);
					blocks.push({
						id: entry.id,
						kind: "user",
						title: translate(locale, "block.you"),
						text: userText(message.content),
						...(images.length === 0 ? {} : { images }),
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
							title: translate(locale, "block.thinking"),
							text: thinking,
							tone: "muted",
							running: false,
						});
					}
					const answer = assistantText(message.content);
					const failure = failureNotice(locale, message);
					// A failed answer with no text is the failure notice alone, not an empty card above it.
					if (answer.length > 0 || failure === undefined) {
						blocks.push({
							id: entry.id,
							kind: "assistant",
							// The author's own name is the brand, in every language.
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
					title: translate(locale, "block.compaction"),
					text: message?.role === "user" ? userText(message.content) : "",
					tone: "muted",
					running: false,
				});
				break;
			case ResetEntry.kind:
				blocks.push({
					id: entry.id,
					kind: "notice",
					title: translate(locale, "block.newContext"),
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
export function sessionStatus(locale: Locale, view: ConversationView | undefined): string {
	if (view === undefined) return "";
	const live = liveOf(view);
	const generation = live.generation;
	const compaction = live.compactions?.[0];
	const runningTool = live.tools?.find((slot) => slot.status === "running");
	if (generation?.retry !== undefined) {
		return translate(locale, "status.retrying", {
			attempt: String(generation.attempt + 1),
			error: generation.retry.error,
		});
	}
	if (generation?.deferred !== undefined) return translate(locale, "status.deferred");
	if (compaction !== undefined) {
		return compaction.retry
			? translate(locale, "status.compactingRetry", {
					reason: compaction.reason,
					attempt: String(compaction.attempt + 1),
				})
			: translate(locale, "status.compacting", { reason: compaction.reason });
	}
	if (runningTool !== undefined) return translate(locale, "status.runningTool", { name: runningTool.name });
	if (live.run !== undefined) return translate(locale, "status.working");
	return "";
}

/** Whether the session is running: a prompt then steers or queues instead of starting a run. */
export function isBusy(view: ConversationView | undefined): boolean {
	return view !== undefined && liveOf(view).run !== undefined;
}

/** The composer's placeholder names what the next submit will do. */
export function composerPlaceholder(locale: Locale, attachedId: string | undefined): string {
	return attachedId === undefined
		? translate(locale, "composer.placeholderDetached")
		: translate(locale, "composer.placeholder", { id: attachedId });
}

/** Inputs the session has accepted but not started yet, each with its own withdraw. */
export function queuedInputs(locale: Locale, view: ConversationView | undefined): QueueItem[] {
	const inbox = view === undefined ? { items: [] } : inboxOf(view);
	return inbox.items.map((item) => ({
		id: String(item.id),
		text: queuedItemText(locale, item),
		cancel: {
			id: QUEUE_CANCEL_ACTION,
			label: translate(locale, "queue.cancel"),
			tone: "default",
			data: String(item.id),
		},
	}));
}

/**
 * The run controls: compaction for the attached session, and the composer's mode toggle. The mode
 * is the page's own choice, so it arrives with the view rather than being decided here.
 */
export function runControls(locale: Locale, mode: SubmitMode, attached: boolean): RunControls {
	return {
		compact: {
			id: COMPACT_ACTION,
			label: translate(locale, "header.compact"),
			tone: "default",
			disabled: !attached,
		},
		submitModes: [
			{ mode: "steer", label: translate(locale, "composer.steer"), selected: mode === "steer" },
			{ mode: "followUp", label: translate(locale, "composer.queue"), selected: mode === "followUp" },
		],
	};
}

/** The view a page shows when it cannot reach or trust the host. */
export function failureView(locale: Locale, text: string): WebView {
	return {
		locale,
		roster: [],
		rosterFilter: "",
		blocks: [],
		status: "",
		queue: [],
		attachments: [],
		run: runControls(locale, "followUp", false),
		attachedId: undefined,
		empty: text,
		busy: false,
		newSession: { enabled: false },
		model: modelPickerEmpty(locale),
		panel: panelView({ locale, current: CHAT_VIEW }),
	};
}

export function buildWebView(input: WebViewInput): WebView {
	const { locale } = input;
	const blocks = transcriptBlocks(locale, input.transcript);
	const roster = rosterItems(locale, input.directory, input.attachedId, input.now, input.rosterFilter);
	const empty =
		input.directory === undefined
			? translate(locale, "header.connecting")
			: (input.directory.sessions.length === 0
					? translate(locale, "header.rosterEmpty")
					: roster.length === 0
						? translate(locale, "header.rosterNoMatch")
						: undefined);
	return {
		locale,
		roster,
		rosterFilter: input.rosterFilter,
		blocks,
		status: sessionStatus(locale, input.transcript),
		queue: queuedInputs(locale, input.transcript),
		attachments: attachments(locale, input.attachments),
		run: runControls(locale, input.submitMode, input.attachedId !== undefined),
		attachedId: input.attachedId,
		empty,
		busy: isBusy(input.transcript),
		// Only a reachable host can take a create; the roster appears with the same state.
		newSession: { enabled: input.directory !== undefined },
		model: modelPicker(locale, input.models, input.thinkingLevels, input.attachedId !== undefined),
		panel: panelView({ ...input.panel, locale }),
	};
}
