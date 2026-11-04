/**
 * The session dock's view model: the tabs it offers and the panel each one shows. A dock panel is
 * built from the same vocabulary the management panels use — groups of rows, text blocks, inputs,
 * and the terminal's own screen — so the renderer treats them alike, and a new dock tab is another
 * pure builder here.
 *
 * The guide lists available tools; the workspace controller owns which tabs are open and selected.
 */
import {
	CONVERSATION_FORK_ACTION,
	CONVERSATION_SELECT_ACTION,
	CONVERSATIONS_REFRESH_ACTION,
	JOB_CLOSE_ACTION,
	JOB_KILL_ACTION,
	JOB_OUTPUT_ACTION,
	JOB_PAGE_ACTION,
	JOB_STREAM_ACTION,
	JOBS_REFRESH_ACTION,
	TASK_RETRY_ACTION,
	SESSION_RENAME_ACTION,
	SESSION_ARCHIVE_ACTION,
	SESSION_RESTORE_ACTION,
	WORKSPACE_CHECKPOINT_ACTION,
	WORKSPACE_OPEN_ACTION,
	WORKSPACE_READ_ACTION,
	WORKSPACE_RELOAD_ACTION,
	WORKSPACE_PAGE_ACTION,
} from "./actions.ts";
import type { Locale } from "./locale.ts";
import type { PanelGroup, PanelPending, PanelRow, PanelSpec } from "./panels.ts";
import type { MessageKey } from "./strings.ts";
import { taskBlockedCopy, taskKindCopy, taskPhaseCopy, taskStatusCopy, translate } from "./strings.ts";
import type { PtyPresentation } from "./pty-surface.ts";
import type { UsageReport } from "./generated/contracts.ts";
import { usagePanel } from "./usage.ts";

/** Tool kinds and the guide shared by state, projection, and rendering. */
export type DockTabId = "guide" | "files" | "terminal" | "jobs" | "conversations" | "tasks" | "changes" | "statistics";

const TAB_IDS: readonly DockTabId[] = ["files", "terminal", "jobs", "conversations", "tasks", "statistics"];
const TAB_MESSAGES: Readonly<Record<DockTabId, MessageKey>> = {
	guide: "dock.newTab",
	files: "dock.files",
	terminal: "dock.terminal",
	jobs: "dock.jobs",
	conversations: "dock.conversations",
	tasks: "dock.tasks",
	changes: "review.tab",
	statistics: "stats.title",
};

export function isDockTabId(value: unknown): value is DockTabId {
	return typeof value === "string" && Object.hasOwn(TAB_MESSAGES, value);
}

export interface DockTab {
	readonly id: DockTabId;
	readonly label: string;
	readonly active: boolean;
}

export interface DockView {
	readonly pty?: PtyPresentation;
	readonly open: boolean;
	readonly tabs: readonly DockTab[];
	readonly availableTabs: readonly DockTab[];
	/** The open tab's panel. */
	readonly panel: PanelSpec;
}

/** One entry of the host's workspace listing. */
export interface WorkspaceEntryLike {
	readonly name: string;
	readonly kind: "dir" | "file";
	readonly size: number;
}

/** What the host's workspace state carries, as this package reads it. */
export interface WorkspaceStateLike {
	readonly cwd: string;
	/** The workspace's registered name, which a checkpoint is saved under. */
	readonly name: string;
	readonly workspaces?: readonly string[];
	readonly view: WorkspaceViewLike;
}

export type WorkspaceViewLike =
	| {
			readonly kind: "listing";
			readonly path: string;
			readonly parent: string | null;
			readonly entries: readonly WorkspaceEntryLike[];
			readonly page?: { readonly offset: number; readonly limit: number; readonly total: number };
	  }
	| {
			readonly kind: "text";
			readonly path: string;
			readonly text: string;
			readonly truncated: boolean;
			readonly startLine: number;
			readonly selection?: { readonly line: number; readonly revision: number };
	  }
	| { readonly kind: "binary"; readonly path: string }
	| { readonly kind: "missing"; readonly path: string }
	| { readonly kind: "denied"; readonly path: string; readonly reason: string };

/** One background job of the attached session, as the host publishes it. */
export interface JobSummaryLike {
	readonly job_id: string;
	readonly request_id: string;
	readonly state: "starting" | "running" | "stopping" | "succeeded" | "failed" | "cancelled" | "unknown" | "cleanup_pending";
	readonly outcome: "pending" | "completed" | "unknown";
	readonly resource_clean: boolean;
	readonly cancel_requested: boolean;
	readonly started_at_ms: number;
	readonly finished_at_ms: number;
	readonly exit_code?: number | null;
	readonly stop_reason?: string;
}

export interface JobOutputStateLike {
	readonly jobId: string;
	readonly stream: "stdout" | "stderr";
	readonly content: string;
	readonly nextOffset: number;
	readonly hasMore: boolean;
	readonly error?: string;
	readonly waitReason?: string;
}

export interface JobsStateLike {
	readonly jobs: readonly JobSummaryLike[];
	readonly truncated: boolean;
	readonly selected?: string;
	readonly output?: JobOutputStateLike;
}

/** One conversation of the session, as the host publishes it. */
export interface ConversationSummaryLike {
	readonly id: string;
	readonly label: string;
	readonly root: boolean;
	readonly role?: "main" | "fork" | "subagent";
	readonly depth?: number;
	readonly parentConversationId?: string;
	readonly parentEntryId?: string;
	readonly ownerConversationId?: string;
	readonly ownerTaskId?: string;
	readonly children: number;
	/** True when this conversation has an entry a fork can start from. */
	readonly hasEntries: boolean;
	readonly archivedAt?: number;
	readonly readOnly?: boolean;
	readonly run?: "idle" | "working" | "retrying" | "deferred" | "compacting" | "tool";
	readonly queued?: number;
}

/** One live task of the session's task graph, as the host publishes it. */
export interface TaskSummaryLike {
	readonly id: string;
	readonly kind: string;
	readonly conversationId: string;
	readonly ownerTaskId?: string;
	readonly background: boolean;
	readonly status: string;
	readonly wakeAt?: number;
	readonly blocked?: string;
	readonly phase: string;
	readonly waitsOn: readonly string[];
	readonly conversations: readonly string[];
}

export interface ConversationsStateLike {
	readonly conversations: readonly ConversationSummaryLike[];
	readonly tasks: readonly TaskSummaryLike[];
	readonly selected: string;
}

export interface DockViewInput {
	readonly usage?: UsageReport;
	readonly open: boolean;
	readonly tab: DockTabId;
	readonly tabs?: readonly DockTabId[];
	/** The session's working directory, which both dock surfaces live in. */
	readonly cwd: string;
	readonly workspace: WorkspaceStateLike | undefined;
	readonly jobs?: JobsStateLike;
	readonly conversations: ConversationsStateLike | undefined;
	readonly insights?: InsightsStateLike;
	readonly reviewDiff?: string;
	/** The file `reviewDiff` belongs to. The panel opens that diff under the file's row. */
	readonly reviewFile?: { readonly root: string; readonly path: string };
	readonly readOnly?: boolean;
	readonly pending?: PanelPending;
}

export interface InsightsStateLike {
	readonly conversationId: string;
	readonly paused: "calls" | "seconds" | "cost" | null;
	readonly calls: number;
	readonly cleanup: { readonly tools: number; readonly images: number };
	readonly files: readonly { readonly root: string; readonly path: string; readonly kind: "added" | "removed" | "modified"; readonly added: number; readonly removed: number; readonly binary: boolean }[];
	readonly verification: readonly { readonly command: string; readonly exitCode: number | null; readonly at: number }[];
	readonly notes: readonly string[];
	readonly skipped: number;
}

const JOB_STATE_MESSAGES = {
	starting: "jobs.state.starting",
	running: "jobs.state.running",
	stopping: "jobs.state.stopping",
	succeeded: "jobs.state.succeeded",
	failed: "jobs.state.failed",
	cancelled: "jobs.state.cancelled",
	unknown: "jobs.state.unknown",
	cleanup_pending: "jobs.state.cleanup_pending",
} as const satisfies Record<JobSummaryLike["state"], MessageKey>;

function jobShort(jobId: string): string {
	return jobId.length > 10 ? jobId.slice(0, 10) : jobId;
}

function jobTime(locale: Locale, milliseconds: number): string {
	return new Date(milliseconds).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/**
 * The background jobs panel: what the session's shell started, each job's state and exit, and one
 * job's paged output with a stream switch and a stop request.
 */
export function jobsPanel(locale: Locale, state: JobsStateLike | undefined): PanelSpec {
	const title = translate(locale, "dock.jobs");
	if (state === undefined)
		return { id: "jobs", title, description: translate(locale, "jobs.description"), notices: [], groups: [] };
	const selected = state.jobs.find((job) => job.job_id === state.selected);
	const rows: PanelRow[] = state.jobs.map((job) => {
		const active = job.state === "starting" || job.state === "running" || job.state === "stopping";
		return {
			id: `job:${job.job_id}`,
			title: jobShort(job.job_id),
			description: translate(locale, "jobs.request", { request: job.request_id.slice(0, 8) }),
			badges: [
				translate(locale, JOB_STATE_MESSAGES[job.state]),
				...(job.exit_code === undefined || job.exit_code === null ? [] : [translate(locale, "jobs.exitCode", { code: String(job.exit_code) })]),
				...(job.finished_at_ms > 0 && !job.resource_clean ? [translate(locale, "jobs.unclean")] : []),
				...(job.outcome === "unknown" ? [translate(locale, "jobs.unknownOutcome")] : []),
			],
			value: translate(locale, "jobs.started", { time: jobTime(locale, job.started_at_ms) }),
			actions: [
				{ id: JOB_OUTPUT_ACTION, label: translate(locale, "jobs.open"), weight: "text", data: job.job_id },
				...(active && !job.cancel_requested
					? [{ id: JOB_KILL_ACTION, label: translate(locale, "jobs.kill"), weight: "line" as const, danger: true, data: job.job_id }]
					: []),
			],
		};
	});
	const groups: PanelGroup[] = [
		{
			id: "jobs:list",
			title: translate(locale, "jobs.list"),
			description: translate(locale, "jobs.listDescription"),
			actions: [{ id: JOBS_REFRESH_ACTION, label: translate(locale, "jobs.refresh"), weight: "line" }],
			rows,
			empty: { cause: "first-use", text: translate(locale, "jobs.empty") },
		},
	];
	if (selected !== undefined && state.output !== undefined) {
		const output = state.output;
		groups.push({
			id: "jobs:output",
			title: translate(locale, "jobs.outputTitle", { job: jobShort(selected.job_id) }),
			actions: [
				{ id: JOB_STREAM_ACTION, label: "stdout", weight: "line", data: "stdout", pressed: output.stream === "stdout" },
				{ id: JOB_STREAM_ACTION, label: "stderr", weight: "line", data: "stderr", pressed: output.stream === "stderr" },
				{ id: JOB_OUTPUT_ACTION, label: translate(locale, "jobs.reloadOutput"), weight: "line", data: selected.job_id },
				...(output.hasMore ? [{ id: JOB_PAGE_ACTION, label: translate(locale, "jobs.loadMore"), weight: "line" as const, data: String(output.nextOffset) }] : []),
				{ id: JOB_CLOSE_ACTION, label: translate(locale, "jobs.close"), weight: "text" },
			],
			rows: [],
			footnote: translate(locale, JOB_STATE_MESSAGES[selected.state]),
		});
	}
	return {
		id: "jobs",
		title,
		description: translate(locale, "jobs.description"),
		notices: [
			...(state.truncated ? [{ tone: "info" as const, persistence: "pinned" as const, text: translate(locale, "jobs.truncated") }] : []),
			...(state.output?.error ? [{ tone: "error" as const, text: translate(locale, "jobs.outputError", { error: state.output.error }) }] : []),
			...(state.output?.waitReason ? [{ tone: "info" as const, text: translate(locale, "jobs.wait", { reason: state.output.waitReason }) }] : []),
		],
		groups,
		...(state.output === undefined ? {} : { texts: [{ id: `jobs:output:${state.output.jobId}:${state.output.stream}`, text: state.output.content, empty: translate(locale, "jobs.outputEmpty") }] }),
	};
}

export function changesPanel(locale: Locale, state: InsightsStateLike | undefined, diff?: string, file?: { readonly root: string; readonly path: string }): PanelSpec {
	const title = translate(locale, "review.title");
	if (!state) return { id: "changes", title, notices: [], groups: [] };
	const open = file !== undefined && diff !== undefined && state.files.some(item => item.root === file.root && item.path === file.path);
	const showing = (item: InsightsStateLike["files"][number]): boolean =>
		open && file !== undefined && diff !== undefined && item.root === file.root && item.path === file.path;
	return { id: "changes", title, description: translate(locale, "review.description"),
		notices: [...(state.paused ? [{ tone: "info" as const, persistence: "pinned" as const, text: translate(locale, `review.paused.${state.paused}`) }] : []),
			...state.notes.map(text => ({ tone: "info" as const, text })), ...(state.skipped ? [{ tone: "info" as const, persistence: "pinned" as const, text: translate(locale, "review.skipped", { count: String(state.skipped) }) }] : []),
			...(state.cleanup.tools || state.cleanup.images ? [{ tone: "info" as const, persistence: "pinned" as const, text: translate(locale, "review.cleanup", { tools: String(state.cleanup.tools), images: String(state.cleanup.images) }) }] : [])],
		groups: [{ id: "changes:files", title: translate(locale, "dock.files"), actions: [
			{ id: "insights:refresh", label: translate(locale, "dock.reload"), weight: "line" as const },
			...(state.paused ? [{ id: "insights:resume", data: state.conversationId, label: translate(locale, "review.resume"), weight: "filled" as const }] : []),
		], rows: state.files.map(item => ({ id: `change:${item.root}/${item.path}`, title: item.path, description: item.root,
			badges: [translate(locale, `review.${item.kind}`), ...(item.binary ? [translate(locale, "review.binary")] : [{ added: item.added, removed: item.removed }])],
			actions: [{ id: "insights:diff", data: JSON.stringify([state.conversationId, item.root, item.path]), label: translate(locale, showing(item) ? "review.hide" : "review.diff"), weight: "text" as const, pressed: showing(item) }],
			...(showing(item) && diff !== undefined ? { detail: { id: "changes:diff", text: diff, title: item.path, diff: /^--- .+\r?\n\+\+\+ .+/m.test(diff) } } : {}),
		})), empty: { cause: "first-use", text: translate(locale, "review.empty") } },
		{ id: "changes:verification", title: translate(locale, "review.verification"), rows: state.verification.map((item, index) => ({ id: `verification:${index}`, title: item.command, description: translate(locale, item.exitCode === null ? "review.unknown" : item.exitCode === 0 ? "review.passed" : "review.failed", { code: String(item.exitCode) }) })), empty: { cause: "first-use", text: translate(locale, "review.noVerification") } }],
		...(diff === undefined || open ? {} : { texts: [{ id: "changes:diff", text: diff, diff: /^--- .+\r?\n\+\+\+ .+/m.test(diff) }] }),
	};
}

/**
 * The title a conversation row shows. The root uses the reader's word for the main line. Any other
 * conversation uses its first input. The host's id fallback is not a name, so the row says so instead.
 */
function conversationTitle(locale: Locale, conversation: ConversationSummaryLike): string {
	const indent = "  ".repeat(conversation.depth ?? 0);
	if (conversation.root || conversation.role === "main") return `${indent}${translate(locale, "dock.main")}`;
	const named = conversation.label.trim();
	const text = named.length === 0 || named === conversation.id ? translate(locale, "dock.untitled") : named;
	return `${indent}${text}`;
}

/**
 * The conversations panel: every conversation of the session, the root named in the reader's language,
 * a subagent's child naming the task and conversation that made it, and the focused one marked as selected.
 */
export function conversationsPanel(locale: Locale, state: ConversationsStateLike | undefined, sessionReadOnly = false): PanelSpec {
	const title = translate(locale, "dock.conversations");
	if (state === undefined) return { id: "conversations", title, notices: [], groups: [] };
	const nameOf = (id: string): string => {
		const conversation = state.conversations.find(item => item.id === id);
		return conversation ? conversationTitle(locale, conversation).trim() : translate(locale, "dock.untitled");
	};
	const rows: PanelRow[] = state.conversations.map((conversation) => ({
		id: `conversation:${conversation.id}`,
		title: conversationTitle(locale, conversation),
		description:
			conversation.ownerConversationId !== undefined && conversation.ownerTaskId !== undefined
				? translate(locale, "dock.owner", {
						task: taskKindCopy(locale, state.tasks.find(task => task.id === conversation.ownerTaskId)?.kind ?? ""),
						conversation: nameOf(conversation.ownerConversationId),
					})
				: conversation.parentConversationId !== undefined
					? translate(locale, "dock.forkedFrom", {
							conversation: nameOf(conversation.parentConversationId),
						})
					: conversation.root || conversation.role === "main" ? translate(locale, "dock.mainHelp") : undefined,
		badges: [
			translate(locale, conversation.role === "fork" ? "dock.fork" : conversation.role === "subagent" || !conversation.root ? "dock.child" : "dock.main"),
			...(conversation.children > 0
				? [
						translate(locale, "dock.children", {
							count: String(conversation.children),
						}),
					]
				: []),
			...(conversation.id === state.selected ? [translate(locale, "dock.selected")] : []),
			...(conversation.readOnly || conversation.archivedAt !== undefined ? [translate(locale, "project.archived")] : []),
			...(conversation.run && conversation.run !== "idle" ? [translate(locale, conversation.run === "compacting" ? "dock.summarizing" : conversation.run === "tool" ? "dock.runningTool" : `lane.${conversation.run}`)] : []),
			...((conversation.queued ?? 0) > 0 ? [translate(locale, "dock.queuedCount", { count: String(conversation.queued) })] : []),
		],
		...(conversation.role !== "fork" || conversation.archivedAt !== undefined ? {} : { menu: {
			label: translate(locale, "dock.forkActions"), data: conversation.id,
			actions: [
				{ id: SESSION_RENAME_ACTION, label: translate(locale, "sidebar.rename"), weight: "text" as const, data: conversation.id, glyph: "square-pen" as const, disabled: sessionReadOnly },
				{ id: SESSION_ARCHIVE_ACTION, label: translate(locale, "project.archive"), weight: "text" as const, danger: true, data: conversation.id, glyph: "folder" as const, disabled: sessionReadOnly },
			],
		} }),
		actions: [
			{
				id: CONVERSATION_SELECT_ACTION,
				label: translate(locale, "dock.select"),
				weight: "text" as const,
				data: conversation.id,
			},
			...(conversation.readOnly || conversation.archivedAt !== undefined ? [] : [{
				id: CONVERSATION_FORK_ACTION, label: translate(locale, "header.fork"), weight: "text" as const,
				data: conversation.id, disabled: sessionReadOnly || !conversation.hasEntries,
			}]),
			...(conversation.role === "fork" && conversation.archivedAt !== undefined ? [{
				id: SESSION_RESTORE_ACTION, label: translate(locale, "dock.restoreFork"), weight: "text" as const,
				data: conversation.id, disabled: sessionReadOnly,
			}] : []),
		],
	}));
	return {
		id: "conversations",
		title,
		notices: [],
		groups: [
			{
				id: "conversations:list",
				title: translate(locale, state.conversations.some(item => item.readOnly || item.archivedAt !== undefined) ? "dock.activeConversations" : "dock.conversations"),
				actions: [
					{
						id: CONVERSATIONS_REFRESH_ACTION,
						label: translate(locale, "dock.reload"),
						weight: "line" as const,
					},
				],
				rows: rows.filter((_, index) => !state.conversations[index]?.readOnly && state.conversations[index]?.archivedAt === undefined),
				empty: { cause: "first-use", text: translate(locale, "dock.noConversations") },
				footnote: translate(locale, "dock.forkSharedFiles"),
			},
			...(state.conversations.some(item => item.readOnly || item.archivedAt !== undefined) ? [{
				id: "conversations:archived", title: translate(locale, "dock.archivedForks"),
				rows: rows.filter((_, index) => state.conversations[index]?.readOnly || state.conversations[index]?.archivedAt !== undefined),
			}] : []),
		],
	};
}

/**
 * The task graph panel: every live task with its phase, what it waits on, and the conversations it
 * owns, so a long run is legible while it happens.
 */
export function tasksPanel(locale: Locale, state: ConversationsStateLike | undefined): PanelSpec {
	const title = translate(locale, "dock.tasks");
	if (state === undefined) return { id: "tasks", title, notices: [], groups: [] };
	const conversationName = (id: string): string => {
		const conversation = state.conversations.find((item) => item.id === id);
		return conversation === undefined ? translate(locale, "dock.untitled") : conversationTitle(locale, conversation).trim();
	};
	const rows: PanelRow[] = state.tasks.map((task) => ({
		id: `task:${task.id}`,
		title: `${taskKindCopy(locale, task.kind)} #${task.id}`,
		description: `${taskPhaseCopy(locale, task.phase)} · ${conversationName(task.conversationId)}`,
		badges: [
			task.blocked !== undefined
				? taskBlockedCopy(locale, task.blocked)
				: task.status === "sleeping" && task.wakeAt !== undefined
					? translate(locale, "dock.taskSleepsUntil", { at: new Date(task.wakeAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US") })
					: task.status === "waiting" && task.waitsOn.length > 0
						? translate(locale, "dock.taskWaitsOn", { count: String(task.waitsOn.length) })
						: taskStatusCopy(locale, task.status),
			...(task.background ? [translate(locale, "dock.background")] : []),
			...(task.conversations.length > 0
				? [
						translate(locale, "dock.taskOwns", {
							count: String(task.conversations.length),
						}),
					]
				: []),
		],
		actions: [
			...(task.blocked === "restart_limit" ? [{
				id: TASK_RETRY_ACTION,
				label: translate(locale, "dock.retryTask"),
				data: task.id,
				weight: "text" as const,
				disabled: state.conversations.find((item) => item.id === task.conversationId)?.readOnly === true,
			}] : []),
			...[...new Set([task.conversationId, ...task.conversations])]
				.filter((id) => state.conversations.some((conversation) => conversation.id === id))
				.map((id) => ({
					id: CONVERSATION_SELECT_ACTION,
					label: translate(locale, id === task.conversationId ? "dock.viewTaskConversation" : "dock.viewOwnedConversation", { name: conversationName(id) }),
					data: id,
					weight: "text" as const,
				})),
		],
	}));
	return {
		id: "tasks",
		title,
		notices: [],
		groups: [
			{
				id: "tasks:list",
				title: translate(locale, "dock.tasks"),
				actions: [
					{
						id: CONVERSATIONS_REFRESH_ACTION,
						label: translate(locale, "dock.reload"),
						weight: "line" as const,
					},
				],
				rows,
				empty: { cause: "first-use", text: translate(locale, "dock.noTasks") },
			},
		],
	};
}

export function dockTabs(locale: Locale, current: DockTabId, ids: readonly DockTabId[] = TAB_IDS): DockTab[] {
	return ids.map((id) => ({
		id,
		label: translate(locale, TAB_MESSAGES[id]),
		active: id === current,
	}));
}

/** The size a file row shows, in the units a listing uses. */
export function workspaceSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type WorkspaceActionTarget =
	| { readonly kind: "open"; readonly path: string; readonly offset?: number }
	| { readonly kind: "read"; readonly path: string }
	| { readonly kind: "link"; readonly path: string; readonly sessionId: string; readonly line?: number };

/** Decode a presentation-bound target without consulting the service's mutable selected directory. */
export function parseWorkspaceAction(data: string | undefined): WorkspaceActionTarget {
	const target: unknown = data === undefined ? undefined : JSON.parse(data);
	if (target === null || typeof target !== "object" || !("path" in target) || typeof target.path !== "string" || target.path.length === 0
		|| !("kind" in target)) throw new TypeError("Invalid workspace navigation target");
	if (target.kind === "link") {
		if (!("sessionId" in target) || typeof target.sessionId !== "string" || !target.sessionId) throw new TypeError("Missing file link owner");
		const line = "line" in target ? target.line : undefined;
		if (line !== undefined && (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1)) throw new TypeError("Invalid file line");
		return { kind: "link", path: target.path, sessionId: target.sessionId, ...(typeof line === "number" ? { line } : {}) };
	}
	if (target.kind === "read") return { kind: "read", path: target.path };
	if (target.kind !== "open") throw new TypeError("Invalid workspace navigation kind");
	const offset = "offset" in target ? target.offset : undefined;
	if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)) throw new TypeError("Invalid workspace directory page");
	return { kind: "open", path: target.path, ...(typeof offset === "number" ? { offset } : {}) };
}

function reloadAction(locale: Locale, path: string, read: boolean) {
	return { id: WORKSPACE_RELOAD_ACTION, label: translate(locale, "dock.reload"), weight: "line" as const,
		data: JSON.stringify({ kind: read ? "read" : "open", path }),
	};
}

function openAction(locale: Locale, path: string) {
	return {
		id: WORKSPACE_OPEN_ACTION,
		label: translate(locale, "dock.open"),
		weight: "text" as const,
		data: path,
	};
}

/** Bind navigation to the displayed workspace, even if another client switches its selected root. */
export function workspacePath(cwd: string, path: string): string {
	return path === "." ? cwd : `${cwd.replace(/[\\/]+$/, "")}/${path}`;
}

function rootRow(locale: Locale, title: string, path: string, cwd: string): PanelRow {
	const action = openAction(locale, workspacePath(cwd, path));
	return { id: "files:root", title, description: path, actions: [action], file: { kind: "up", action } };
}

/**
 * The files panel: the directory being listed with one row per entry (a directory opens, a file
 * reads), or the file that was read with its text below. A refusal the host reported — outside the
 * working directory, binary, missing — is the panel's notice.
 */
/** The client path the host uses for one file: relative for the primary workspace, prefixed for grants. */
function clientPath(name: string, relative: string): string {
	const inner = relative.replace(/^\.\/+/, "");
	if (name === "primary") return inner;
	return inner.length === 0 ? `grant/${name}` : `grant/${name}/${inner}`;
}

export function filesPanel(locale: Locale, state: WorkspaceStateLike | undefined): PanelSpec {
	const title = translate(locale, "dock.files");
	if (state === undefined) {
		return { id: "files", title, notices: [], groups: [] };
	}
	const view = state.view;
	const segments = view.kind === "denied" ? [] : view.path.split(/[\\/]/).filter(part => part !== "." && part !== "");
	const files: NonNullable<PanelSpec["files"]> = {
		cwd: state.cwd, path: view.path,
		breadcrumbs: [
			{ label: state.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? state.cwd, path: state.cwd, current: segments.length === 0 },
			...segments.map((label, index) => ({ label, path: workspacePath(state.cwd, segments.slice(0, index + 1).join("/")), current: index === segments.length - 1 })),
		],
		...(view.kind === "listing" ? { filterScope: JSON.stringify([state.cwd, view.path, view.page?.offset ?? 0]) } : {}),
	};
	const reload = reloadAction(locale, workspacePath(state.cwd, view.kind === "denied" ? "." : view.path), view.kind !== "listing" && view.kind !== "denied");
	const folders: PanelGroup[] = (state.workspaces?.length ?? 0) > 1 ? [{
		id: "files:workspaces", title: translate(locale, "project.folders"), rows: [{
			id: "files:workspace", title: translate(locale, "project.directory"), controls: [{
				id: WORKSPACE_OPEN_ACTION, kind: "select", value: state.cwd, label: translate(locale, "project.directory"),
				options: state.workspaces!.map(path => {
					const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
					return { value: path, label: state.workspaces!.filter(folder => (folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder) === name).length === 1 ? name : path };
				}),
			}],
		}],
	}] : [];
	if (view.kind === "text") {
		// The file's own directory is the parent of its path, so the reader can step back out.
		const parent = segments.slice(0, -1).join("/") || ".";
		return {
			id: "files",
			title: segments.at(-1) ?? view.path,
			files,
			notices: [
				...(view.truncated ? [{ tone: "info" as const, persistence: "pinned" as const, text: translate(locale, "dock.truncated") }] : []),
				...(view.selection && (view.selection.line < view.startLine || view.selection.line >= view.startLine + (view.text ? view.text.split("\n").length - Number(view.text.endsWith("\n")) : 0))
					? [{ tone: "info" as const, persistence: "pinned" as const, text: translate(locale, "dock.lineUnavailable", { line: String(view.selection.line) }) }] : []),
			],
			groups: [
				...folders,
				{
					id: "files:back",
					title: translate(locale, "dock.contents"),
					actions: [
						reload,
						{
							id: WORKSPACE_CHECKPOINT_ACTION,
							label: translate(locale, "dock.checkpoint"),
							weight: "line",
							data: JSON.stringify({
								workspace: state.name,
								path: clientPath(state.name, view.path),
							}),
						},
					],
					rows: [rootRow(locale, translate(locale, "dock.backToFolder"), parent, state.cwd)],
				},
			],
			texts: [{ id: `files:text:${state.cwd}:${view.path}`, text: view.text, source: { startLine: view.startLine, selection: view.selection } }],
		};
	}
	if (view.kind !== "listing") {
		const notice = view.kind === "denied" ? (view.reason === "Folder is outside project workspaces." ? translate(locale, "project.outsideWorkspace") : view.reason) : view.kind === "binary" ? translate(locale, "dock.binary") : translate(locale, "dock.missing");
		return {
			id: "files",
			title: segments.at(-1) ?? title,
			files,
			notices: [{ tone: view.kind === "denied" ? "error" : "info", text: notice }],
			groups: [
				...folders,
				{
					id: "files:back",
					title: translate(locale, "dock.contents"),
					actions: [reload],
					rows: [rootRow(locale, translate(locale, "dock.cwd"), ".", state.cwd)],
				},
			],
		};
	}
	const rows: PanelRow[] = [];
	if (view.parent !== null) {
		rows.push({
			id: "files:up",
			title: translate(locale, "dock.parent"),
			description: view.parent,
			actions: [openAction(locale, workspacePath(state.cwd, view.parent))],
			file: { kind: "up", action: openAction(locale, workspacePath(state.cwd, view.parent)) },
		});
	}
	for (const entry of view.entries) {
		const path = view.path === "." ? entry.name : `${view.path}/${entry.name}`;
		const action = entry.kind === "dir" ? openAction(locale, workspacePath(state.cwd, path)) : {
			id: WORKSPACE_READ_ACTION, label: translate(locale, "dock.read"), weight: "text" as const, data: workspacePath(state.cwd, path),
		};
		rows.push({
			id: `files:${path}`, title: entry.name,
			...(entry.kind === "dir" ? { badges: [translate(locale, "dock.directory")] } : { value: workspaceSize(entry.size) }),
			actions: [action], file: { kind: entry.kind, action },
		});
	}
	const page = view.page;
	const paging = page === undefined ? [] : [
		...(page.offset > 0 ? [{ id: WORKSPACE_PAGE_ACTION, label: translate(locale, "dock.previousPage"), data: JSON.stringify({ kind: "open", path: workspacePath(state.cwd, view.path), offset: Math.max(0, page.offset - page.limit) }), weight: "line" as const }] : []),
		...(page.offset + page.limit < page.total ? [{ id: WORKSPACE_PAGE_ACTION, label: translate(locale, "dock.nextPage"), data: JSON.stringify({ kind: "open", path: workspacePath(state.cwd, view.path), offset: page.offset + page.limit }), weight: "line" as const }] : []),
	];
	const group: PanelGroup = {
		id: "files:entries",
		title: translate(locale, "dock.entries"),
		actions: [reload, ...paging],
		...(page === undefined ? {} : { description: translate(locale, "dock.pageRange", { from: String(page.total === 0 ? 0 : page.offset + 1), to: String(Math.min(page.offset + page.limit, page.total)), total: String(page.total) }) }),
		rows,
		empty: { cause: page !== undefined && page.total > 0 ? "no-match" : "first-use", text: translate(locale, page !== undefined && page.total > 0 ? "dock.emptyPage" : "dock.emptyDirectory") },
	};
	return {
		id: "files",
		title,
		files,
		notices: [],
		groups: [...folders, group],
	};
}

/**
 * The terminal tab is the shell's own screen: the tab title already names it and the prompt reports
 * the working directory. The screen carries the output, and an ended shell speaks through the page's
 * toast layer instead of a line that would resize the terminal. Closing the tab ends the shell.
 */
export function terminalPanel(locale: Locale, input: { readonly cwd: string }): PanelSpec {
	return {
		id: "terminal",
		title: translate(locale, "dock.terminal"),
		description: input.cwd,
		notices: [],
		groups: [],
	};
}

/** The dock the main area shows beside the conversation. */
export function dockView(locale: Locale, input: DockViewInput): DockView {
	const tab = input.tab;
	const panel =
		tab === "guide"
			? { id: "guide", title: "", groups: [], notices: [] }
			: tab === "files"
			? filesPanel(locale, input.workspace)
			: tab === "terminal"
				? terminalPanel(locale, { cwd: input.cwd })
				: tab === "jobs"
					? jobsPanel(locale, input.jobs)
					: tab === "conversations"
					? conversationsPanel(locale, input.conversations, input.readOnly)
					: tab === "statistics" ? usagePanel(locale, input.usage) : tab === "changes" ? changesPanel(locale, input.insights, input.reviewDiff, input.reviewFile) : tasksPanel(locale, input.conversations);
	return {
		open: input.open,
		tabs: dockTabs(locale, tab, input.tabs ?? [tab]),
		availableTabs: dockTabs(locale, tab, [...TAB_IDS, ...(input.insights ? ["changes" as const] : [])]),
		panel: {
			...panel,
			...(input.pending === undefined ? {} : { pending: input.pending }),
		},
	};
}
