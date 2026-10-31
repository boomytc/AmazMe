/** Pure client presentation contracts. Python owns session and execution state. */
import { DEFAULT_TYPOGRAPHY, type Typography } from "./typography.ts";
import type { ProjectGroup } from "./projects.ts";
import type { ApprovalPolicy } from "./permission-picker.ts";
import type { Locale } from "./locale.ts";
import type { ProviderAuthLike } from "./provider-auth.ts";
import type { ModelConnectionsLike } from "./model-connections.ts";
import { CHAT_VIEW, panelView, type PanelButton, type PanelView } from "./panels.ts";
import { dockView, type DockView } from "./dock.ts";
import { commandPalette, type CommandPalette } from "./commands.ts";
import { shortcuts, type Shortcut } from "./shortcuts.ts";
import { translate, thinkingLevelCopy, toolTitleCopy, type MessageKey } from "./strings.ts";
import { errorMessageCopy } from "./errors.ts";
import type { ToolResultView } from "./tool-results.ts";
import type { QuestionView } from "./generated/contracts.ts";
import * as actions from "./actions.ts";
const {APPROVAL_APPROVE_ACTION, APPROVAL_DENY_ACTION, ATTACHMENT_REMOVE_ACTION, COMPACT_ACTION, CONVERSATION_FORK_ACTION, FEEDBACK_DOWN_ACTION, FEEDBACK_UP_ACTION, QUEUE_CANCEL_ACTION, SESSION_REMOVE_ACTION, WELCOME_DISMISS_ACTION, WELCOME_SESSION_ACTION, WELCOME_SETTINGS_ACTION} = actions;
export type BlockTone = "plain" | "muted" | "error";

export interface TranscriptBlock {
	/** Stable key: entry id, or the live marker for a provisional block. */
	readonly id: string;
	readonly kind: "user" | "assistant" | "thinking" | "tool" | "notice";
	readonly title: string;
	/** Registered identity stays available when the visible tool name is localized. */
	readonly toolName?: string;
	readonly text: string;
	/**
	 * The requested command/file digest, readable key: value details and lossless JSON for copying.
	 * Absent when the call has no arguments; executed output stays separate.
	 */
	readonly toolArgs?: {
		readonly collapsed: string;
		readonly expanded: string;
		readonly source: string;
	};
	/** Images the entry carries, as data URLs the reader sees. */
	readonly images?: readonly {
		readonly dataUrl: string;
		readonly alt: string;
	}[];
	/** Executed output metadata, separate from the requested arguments. */
	readonly result?: ToolResultView;
	/** An answer's rating controls, and the rating it already carries. */
	readonly feedback?: FeedbackControls;
	readonly tone: BlockTone;
	readonly running: boolean;
	/** A committed interruption, never inferred from localized output text. */
	readonly interrupted?: boolean;
}

export interface RosterItem {
	readonly id: string;
	readonly projectId?: string | null;
	readonly archived?: boolean;
	/** The session's title, or the localized new-session label. */
	readonly label: string;
	/** The session's working directory, shown so two sessions are tellable apart. */
	readonly cwd: string | undefined;
	readonly age: string;
	readonly ageIso: string;
	readonly attached: boolean;
	/** Where the session lives: one this host owns, or a terminal session it can adopt. */
	readonly source: "host" | "local";
	/** The time bucket the roster lists the session under. */
	readonly group: RosterGroupId;
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

/** Catalog entries grouped by provider for the model selectors. */
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

/** The composer and settings selectors share the scoped catalog and supported thinking levels. */
export interface ModelPicker {
	/** The configured model name, including when hidden from the selectable scope. */
	readonly label: string;
	/** The configured thinking level for a model that reports levels. */
	readonly effort: string | undefined;
	readonly groups: readonly ModelGroup[];
	readonly levels: readonly ThinkingOption[];
	/** Explain an empty catalog or model scope. */
	readonly empty: string | undefined;
	/** The effort group's line when the attached model reports nothing above `off`. */
	readonly levelsEmpty: string | undefined;
	/** No attached session or no models service: the trigger is inert. */
	readonly disabled: boolean;
	/** The catalog's refresh state: the control to ask for one, and the host's last word. */
	readonly refresh: ModelRefresh;
	readonly scopeNotice?: string;
}

/** Refresh state shared by the model selectors and settings. */
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
export function attachmentRejection(image: { readonly mediaType: string; readonly bytes: number }): AttachmentRejection | undefined {
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

/** How the reader rated one answer, as the transcript shows it. */
export type MessageRatingLike = "up" | "down";

/**
 * The first-run guide: create a session or configure the interface. It is offered
 * while the host has no sessions and the reader has not dismissed it.
 */
export interface WelcomeCard {
	readonly title: string;
	readonly body: string;
	readonly steps: readonly PanelButton[];
	readonly dismiss: PanelButton;
	readonly note: string;
}

/** The guide, or undefined when it should not be shown. */
export function welcomeCard(locale: Locale, input: { readonly show: boolean }): WelcomeCard | undefined {
	if (!input.show) return undefined;
	return {
		title: translate(locale, "welcome.title"),
		body: translate(locale, "welcome.body"),
		steps: [
			{
				id: WELCOME_SESSION_ACTION,
				label: translate(locale, "welcome.step.session"),
				weight: "filled",
			},
			{
				id: WELCOME_SETTINGS_ACTION,
				label: translate(locale, "welcome.step.settings"),
				weight: "line",
			},
		],
		dismiss: {
			id: WELCOME_DISMISS_ACTION,
			label: translate(locale, "welcome.dismiss"),
			weight: "text",
		},
		note: translate(locale, "welcome.note"),
	};
}

/** The controls under one answer: both ratings, and which one is already set. */
export interface FeedbackControls {
	readonly rating: MessageRatingLike | null;
	readonly up: PanelButton;
	readonly down: PanelButton;
}

/** One rating as the host publishes it. */
export interface FeedbackRecordLike {
	readonly sessionId: string;
	readonly conversationId: string;
	readonly entryId: string;
	readonly rating: MessageRatingLike;
}

/** What the host's feedback state carries, as this package reads it. */
export interface FeedbackStateLike {
	readonly path: string;
	readonly records: readonly FeedbackRecordLike[];
}

/**
 * Which conversation's answers a rating list belongs to. Durable entry ids are per conversation, so
 * without this an answer in one session could show a rating given to the same id in another.
 */
export interface FeedbackScope {
	readonly sessionId: string;
	readonly conversationId: string;
}

export function feedbackControls(locale: Locale, entryId: string, rating: MessageRatingLike | null): FeedbackControls {
	return {
		rating,
		up: {
			id: FEEDBACK_UP_ACTION,
			label: translate(locale, "feedback.up"),
			weight: "text",
			data: entryId,
		},
		down: {
			id: FEEDBACK_DOWN_ACTION,
			label: translate(locale, "feedback.down"),
			weight: "text",
			data: entryId,
		},
	};
}

/** One tool call waiting for the reader's decision. */
export interface ApprovalCard {
	readonly id: string;
	readonly tool: string;
	/** A one-line digest of the call. */
	readonly detail: string;
	readonly approve: PanelButton;
	readonly deny: PanelButton;
}

/** What the host's approvals state carries, as this package reads it. */
export interface ApprovalsStateLike {
	readonly pending: readonly {
		readonly id: string;
		readonly tool: string;
		readonly detail: string;
	}[];
}

/**
 * The pending tool calls, each with its own approve and deny. A decision is the only thing that
 * releases the call, so the card names the tool and what it would do.
 */
export function approvalCards(locale: Locale, state: ApprovalsStateLike | undefined): ApprovalCard[] {
	return (state?.pending ?? []).map((request) => ({
		id: request.id,
		tool: toolTitleCopy(locale, request.tool),
		detail: request.detail,
		approve: {
			id: APPROVAL_APPROVE_ACTION,
			label: translate(locale, "approval.approve"),
			weight: "filled",
			data: request.id,
		},
		deny: {
			id: APPROVAL_DENY_ACTION,
			label: translate(locale, "approval.deny"),
			weight: "line",
			danger: true,
			data: request.id,
		},
	}));
}

/** The header's pending-approval mark. Absent when nothing is waiting, so the strip stays quiet. */
export interface ApprovalIndicator {
	readonly count: number;
	readonly label: string;
}

/**
 * The short mark the header keeps on screen while tool calls wait. The cards above the composer
 * are still where a call is approved or denied; this only says how many are waiting, including
 * when the transcript is empty or those cards are off screen.
 */
export function approvalIndicator(locale: Locale, state: ApprovalsStateLike | undefined): ApprovalIndicator | undefined {
	const count = state?.pending.length ?? 0;
	if (count === 0) return undefined;
	return {
		count,
		label: translate(locale, "header.pendingApprovals", { count: String(count) }),
	};
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
			weight: "text",
			data: image.id,
		},
	}));
}

/** One queued input the session accepted but has not started. */
export interface QueueItem {
	/** An unconfirmed submission can retry its original ID as well as cancel it. */
	readonly retry?: PanelButton;
	/** The inbox submission id, the subject of a withdraw. */
	readonly id: string;
	readonly text: string;
	/** The withdraw control, so the row carries its own cancel. */
	readonly cancel?: PanelButton;
}

/** How the next submit is applied while a turn runs. */
export type SubmitMode = "steer" | "followUp";

export interface SubmitModeOption {
	readonly mode: SubmitMode;
	readonly label: string;
	readonly selected: boolean;
}

/**
 * The focused conversation's lane. The same fields the host publishes. The chrome shows the
 * conversation and whether it is running; model and thinking are carried for other consumers,
 * since the composer's picker is where they are displayed and changed.
 */
export interface LaneLike {
	readonly role: "main" | "fork" | "subagent";
	readonly label: string;
	readonly model: string;
	readonly thinking: string;
	readonly run: "idle" | "working" | "retrying" | "deferred" | "compacting" | "tool";
	readonly detail: string;
}

/** The controls around the conversation: compaction, fork, and how a busy turn takes input. */
export interface RunControls {
	/** Compaction, offered from the context ring. */
	readonly compact: PanelButton;
	/** Fork the shown conversation at its newest entry. */
	readonly fork: PanelButton;
	/** The composer's mode toggle, offered while a turn runs. */
	readonly submitModes: readonly SubmitModeOption[];
}

/** The sidebar's new-session control. Its label is page copy; only its state is projected. */
export interface NewSessionAffordance {
	/** The host is reachable, so it can take a create. */
	readonly enabled: boolean;
	readonly pending?: boolean;
}

export interface WebView {
	readonly modelConnections?: ModelConnectionsLike;
	readonly typography: Typography;
	/** The language this view's copy is in; the renderer reads it for its own chrome too. */
	readonly locale: Locale;
	/** Namespace of the displayed transcript; independent of whether sending is currently available. */
	readonly transcriptScope?: string;
	/** The roster, narrowed by the reader's filter. */
	readonly roster: readonly RosterItem[];
	readonly projects?: readonly ProjectGroup[];
	/** The one archived session the reader currently has open, pinned under the projects. */
	readonly archivedAttached?: RosterItem;
	readonly readOnly?: boolean;
	/** The filter text itself, so the input keeps what the reader typed. */
	readonly rosterFilter: string;
	readonly blocks: readonly TranscriptBlock[];
	readonly status: string;
	readonly queue: readonly QueueItem[];
	/** Images attached but not sent yet. */
	readonly attachments: readonly Attachment[];
	/** The session's pending tool approvals. */
	readonly approvals: readonly ApprovalCard[];
	readonly questions?: readonly QuestionView[];
	/** Pending approvals the header keeps visible. Absent when the queue is empty. */
	readonly approvalIndicator: ApprovalIndicator | undefined;
	/** Host-owned export warning; never inserted into the model transcript. */
	readonly mirrorWarning?: { readonly path: string; readonly detail: string } | null;
	/** The first-run guide, while the host has no sessions and it is not dismissed. */
	readonly welcome: WelcomeCard | undefined;
	readonly run: RunControls;
	/** The command palette for the current draft. */
	readonly palette: CommandPalette;
	/** The keyboard shortcuts, with this platform's key names. */
	readonly shortcuts: readonly Shortcut[];
	/** Whether the draft is a command line the page runs instead of prompting. */
	readonly commandLine: boolean;
	/** An optional draft candidate, scoped to one completed answer by the host page. */
	readonly suggestion?: { readonly key: string; readonly text: string };
	/** The focused conversation's label, and the history the reader paged in above the transcript. */
	readonly focus: string | undefined;
	/** Lane, model, thinking, and run. Empty until a session is attached. */
	readonly lane: string;
	readonly history: {
		readonly blocks: readonly TranscriptBlock[];
		readonly more: boolean;
		readonly loading: boolean;
	};

	readonly attachedId: string | undefined;
	/** The attached session's readable name, or the localized new-session label. */
	readonly sessionLabel: string | undefined;
	/** Context occupancy, tokens, and cost. Always present, including before the first answer. */
	readonly meter: StatusMeter;
	readonly empty: string | undefined;
	/** Whether a turn is in flight: the stop control stays on screen until it settles. */
	readonly busy: boolean;
	readonly newSession: NewSessionAffordance;
	/** Only an unsent new chat can choose a project. Existing sessions keep their ownership. */
	readonly sessionDraft?: {
		readonly projectId: string | null;
		readonly label: string;
		readonly projects: readonly { readonly id: string; readonly name: string }[];
		readonly disabled: boolean;
	};
	readonly model: ModelPicker;
	readonly modelPending?: boolean;
	readonly approvalPolicy?: ApprovalPolicy;
	/** The sidebar's navigation and the management panel the main area shows. */
	readonly panel: PanelView;
	/** The session dock beside the conversation. */
	readonly dock: DockView;
}


export interface SessionSummaryLike {
	readonly projectId?: string | null;
	readonly archivedAt?: number;
	readonly workEndedAt?: number;
	readonly serverId?: string;
	readonly sessionId: string;
	readonly createdAt: number;
	readonly cwd?: string;
	/** The display name `/name` reads, when the session has one. */
	readonly name?: string;
	/** Where the session lives; a host that does not say is taken to own it. */
	readonly source?: "host" | "local";
}

/** The host's replicated session directory, as this package reads it. */
export interface SessionDirectoryLike {
	readonly sessions: readonly SessionSummaryLike[];
	readonly projects?: readonly { readonly id: string; readonly name: string; readonly cwd: string; readonly workspaces?: readonly string[]; readonly revision?: number; readonly createdAt: number; readonly removed?: true }[];
	readonly defaultProjectId?: string;
}

/** One catalog entry of the host's `amazme.models` state; only the fields the picker shows. */
export interface ModelSummaryLike {
	readonly provider: string;
	readonly modelId: string;
	readonly name: string;
	readonly reasoning: boolean;
	/** Present when the host publishes the model's context window. */
	readonly contextWindow?: number;
}

/** The host's replicated `amazme.models` state, as this package reads it. */
export interface ModelsStateLike {
	readonly authentication?: ProviderAuthLike | null;
	readonly catalog: {
		readonly revision: number;
		readonly availableModels: readonly ModelSummaryLike[];
		readonly enabledModelIds: readonly string[] | null;
	};
	readonly configuration: {
		readonly model: {
			readonly provider: string;
			readonly modelId: string;
		} | null;
		readonly thinkingLevel: string;
	};
	readonly refresh:
		| { readonly status: "idle" | "refreshing" | "done" }
		| {
				readonly status: "warning";
				readonly errors: Readonly<Record<string, string>>;
		  };
}


export function modelPickerEmpty(locale: Locale): ModelPicker {
	return {
		label: translate(locale, "model.none"),
		effort: undefined,
		groups: [],
		levels: [],
		empty: undefined,
		levelsEmpty: undefined,
		disabled: true,
		refresh: {
			label: translate(locale, "model.refresh"),
			status: undefined,
			busy: false,
		},
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
 * Scoped choices grouped by provider, the levels the
 * attached model reports, and the two empty states that keep the control explainable.
 */
export function modelPicker(locale: Locale, models: ModelsStateLike | undefined, levels: readonly string[] | undefined, attached: boolean): ModelPicker {
	if (models === undefined || !attached) return modelPickerEmpty(locale);
	const configured = models.configuration.model;
	const byProvider = new Map<string, ModelOption[]>();
	for (const model of models.catalog.availableModels) {
		if (models.catalog.enabledModelIds !== null && !models.catalog.enabledModelIds.includes(`${model.provider}/${model.modelId}`)) continue;
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
	const current = models.catalog.availableModels.find((model) => model.provider === configured?.provider && model.modelId === configured?.modelId);
	const label =
		current?.name ?? (configured === null || configured === undefined ? translate(locale, "model.none") : `${configured.provider}/${configured.modelId}`);
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
		empty: groups.length === 0 ? translate(locale, models.catalog.availableModels.length === 0 || models.catalog.enabledModelIds === null ? "model.empty" : "model.scopeEmpty") : undefined,
		levelsEmpty: levels === undefined || reasoned ? undefined : translate(locale, "model.levelsEmpty"),
		disabled: false,
		...(configured && !current ? { scopeNotice: translate(locale, "model.unavailable") }
			: configured && models.catalog.enabledModelIds !== null && !models.catalog.enabledModelIds.includes(`${configured.provider}/${configured.modelId}`)
				? { scopeNotice: translate(locale, "model.scopeHidden") } : {}),
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

/** The display name `/name` reads, when it is non-blank. */
function displayName(session: SessionSummaryLike): string | undefined {
	const name = session.name?.trim();
	return name === undefined || name.length === 0 ? undefined : name;
}

/**
 * The roster, newest first, narrowed by the reader's filter. A filter matches the title the row
 * shows (the stored name, or the untitled label), its id, or its working directory.
 */
export function rosterItems(locale: Locale, state: SessionDirectoryLike | undefined, attachedId: string | undefined, now: number, filter = "", archived = false, retentionDays = 0): RosterItem[] {
	const sessions = state?.sessions ?? [];
	const needle = filter.trim().toLowerCase();
	const untitled = translate(locale, "sidebar.untitled").toLowerCase();
	return [...sessions]
		.filter(session => (session.archivedAt !== undefined) === archived)
		.filter((session) => {
			if (needle.length === 0) return true;
			const name = displayName(session)?.toLowerCase() ?? "";
			const title = name.length === 0 ? untitled : name;
			const project = state?.projects?.find(project => project.id === session.projectId);
			return title.includes(needle) || session.sessionId.toLowerCase().includes(needle) || (session.cwd ?? "").toLowerCase().includes(needle) || (project?.name ?? "").toLowerCase().includes(needle);
		})
		.sort(
			(left: SessionSummaryLike, right: SessionSummaryLike) =>
				right.createdAt - left.createdAt || (left.serverId ?? "").localeCompare(right.serverId ?? "") || left.sessionId.localeCompare(right.sessionId),
		)
		.map((session) => ({
			id: session.sessionId,
			projectId: session.projectId,
			archived: session.archivedAt !== undefined,
			label: displayName(session) ?? translate(locale, "sidebar.untitled"),
			cwd: session.cwd,
			age: session.archivedAt === undefined ? formatAge(session.createdAt, now) : translate(locale, retentionDays > 0 && now - session.archivedAt >= retentionDays * 86400000 ? "project.retentionDue" : "project.archivedAge", { age: formatAge(session.archivedAt, now) }),
			ageIso: new Date(session.archivedAt ?? session.createdAt).toISOString(),
			attached: attachedId === session.sessionId,
			source: session.source ?? "host",
			group: rosterGroupOf(session.createdAt, now),
			remove: {
				id: SESSION_REMOVE_ACTION,
				label: translate(locale, "sidebar.remove"),
				weight: "text",
				danger: true,
				data: session.sessionId,
			},
		}));
}

/** The roster's time buckets, newest first. */
export type RosterGroupId = "today" | "yesterday" | "week" | "earlier";

/** The local midnight `offset` days from the day `now` falls on. */
function dayStart(now: number, offset: number): number {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	day.setDate(day.getDate() + offset);
	return day.getTime();
}

/** The bucket a session made at `createdAt` belongs to. A timestamp ahead of the clock counts as today. */
export function rosterGroupOf(createdAt: number, now: number): RosterGroupId {
	if (createdAt >= dayStart(now, 0)) return "today";
	if (createdAt >= dayStart(now, -1)) return "yesterday";
	if (createdAt >= dayStart(now, -7)) return "week";
	return "earlier";
}

/** One bucket of the roster, with its label in the reader's language. */
export interface RosterGroup {
	readonly id: RosterGroupId;
	readonly label: string;
	readonly items: readonly RosterItem[];
}

const ROSTER_GROUP_LABELS: readonly { readonly id: RosterGroupId; readonly message: MessageKey }[] = [
	{ id: "today", message: "roster.today" },
	{ id: "yesterday", message: "roster.yesterday" },
	{ id: "week", message: "roster.week" },
	{ id: "earlier", message: "roster.earlier" },
];

/** The roster in its buckets, in bucket order and then newest first. An empty bucket is left out. */
export function rosterGroups(locale: Locale, items: readonly RosterItem[]): RosterGroup[] {
	return ROSTER_GROUP_LABELS.map(({ id, message }) => ({
		id,
		label: translate(locale, message),
		items: items.filter((item) => item.group === id),
	})).filter((group) => group.items.length > 0);
}

/** The attached session's readable name, or the untitled label when `/name` has not set one. */
export function attachedSessionLabel(directory: SessionDirectoryLike | undefined, attachedId: string | undefined, locale: Locale = "en"): string | undefined {
	if (attachedId === undefined) return undefined;
	const session = directory?.sessions.find((item) => item.sessionId === attachedId);
	return (session === undefined ? undefined : displayName(session)) ?? translate(locale, "sidebar.untitled");
}

/**
 * A leading `(digits) ` is the desktop shell's pending-count prefix. A session name that starts
 * that way is rewritten with full-width parentheses so only a real pending count produces the prefix.
 */
const TITLE_COUNT_PREFIX = /^\((\d+)\) /u;

function titleSessionName(name: string): string {
	return name.replace(TITLE_COUNT_PREFIX, "（$1） ");
}

/**
 * The window title. No attached session keeps the product and its version. An attached session
 * uses the display name the roster already shows: `(n) <name> — <app>` while the header's
 * approval indicator reports n > 0, and `<name> — <app>` once that count is back to none.
 */
export function windowTitle(input: {
	readonly appName: string;
	readonly version: string;
	/** `sessionLabel`: the display name the roster shows, or the untitled label when `/name` has not set one. */
	readonly sessionName: string | undefined;
	/** `approvalIndicator.count`, or 0 when the indicator is absent. */
	readonly pendingCount: number;
}): string {
	if (input.sessionName === undefined || input.sessionName.length === 0) {
		return `${input.appName} ${input.version}`;
	}
	const sessionName = titleSessionName(input.sessionName);
	if (Number.isInteger(input.pendingCount) && input.pendingCount > 0) {
		return `(${input.pendingCount}) ${sessionName} — ${input.appName}`;
	}
	return `${sessionName} — ${input.appName}`;
}

/**
 * Ids of blocks whose text contains the query, case-insensitively, in the given order.
 *
 * Folded details stay searchable because the caller passes their text. Stored history
 * that is not in this list is not searched here; the page loads it and searches again.
 */
export function transcriptSearchHits(
	entries: readonly { readonly id: string; readonly text: string }[],
	query: string,
): string[] {
	const needle = query.trim().toLocaleLowerCase();
	if (needle.length === 0) return [];
	return entries.filter((entry) => entry.text.toLocaleLowerCase().includes(needle)).map((entry) => entry.id);
}

/** Token counts in the same widths the TUI top bar uses. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** The header's context, tokens, and cost. Unknown measurements stay visible as `?`. */

export interface StatusMeter {
	readonly context: string;
	readonly tokens: string;
	readonly cost: string;
	readonly tone: "neutral" | "warning" | "error";
}


export function composerPlaceholder(locale: Locale, attached: boolean): string {
	return translate(locale, attached ? "composer.placeholder" : "composer.placeholderDetached");
}

/** Inputs the session has accepted but not started yet, each with its own withdraw. */
export function runControls(locale: Locale, mode: SubmitMode, attached: boolean, forkable: boolean): RunControls {
	return {
		compact: {
			id: COMPACT_ACTION,
			label: translate(locale, "header.compact"),
			weight: "line",
			disabled: !attached,
		},
		fork: {
			id: CONVERSATION_FORK_ACTION,
			label: translate(locale, "header.fork"),
			weight: "line",
			disabled: !attached || !forkable,
		},
		submitModes: [
			{
				mode: "steer",
				label: translate(locale, "composer.steer"),
				selected: mode === "steer",
			},
			{
				mode: "followUp",
				label: translate(locale, "composer.queue"),
				selected: mode === "followUp",
			},
		],
	};
}

/** The view a page shows when it cannot reach or trust the host. */
export function failureView(locale: Locale, text: string): WebView {
	return {
		locale,
		typography: { ...DEFAULT_TYPOGRAPHY },
		roster: [],
		rosterFilter: "",
		focus: undefined,
		lane: "",
		history: { blocks: [], more: false, loading: false },
		palette: commandPalette(locale, { draft: "", commands: [] }),
		shortcuts: shortcuts(locale, ""),
		commandLine: false,
		blocks: [],
		status: "",
		queue: [],
		attachments: [],
		approvals: [],
		approvalIndicator: undefined,
		welcome: undefined,
		run: runControls(locale, "followUp", false, false),
		attachedId: undefined,
		sessionLabel: undefined,
		meter: {context:"?", tokens:"? / ?", cost:"$0.000", tone:"neutral"},
		empty: text,
		busy: false,
		newSession: { enabled: false },
		model: modelPickerEmpty(locale),
		panel: panelView({ locale, current: CHAT_VIEW }),
		dock: dockView(locale, {
			open: false,
			tab: "files",
			cwd: "",
			workspace: undefined,
			terminal: undefined,
			conversations: undefined,
		}),
	};
}
