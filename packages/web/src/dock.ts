/**
 * The session dock's view model: the tabs it offers and the panel each one shows. A dock panel is
 * built from the same vocabulary the management panels use — groups of rows, text blocks, and one
 * input line for the terminal — so the renderer treats both alike, and a new dock tab is another
 * pure builder here.
 *
 * Two surfaces live in the dock: the attached session's working directory (browse it, read a file)
 * and a shell in that directory (run a command, watch its output, stop it).
 */
import {
	CONVERSATION_FORK_ACTION,
	CONVERSATION_SELECT_ACTION,
	CONVERSATIONS_REFRESH_ACTION,
	TERMINAL_RUN_ACTION,
	TERMINAL_STOP_ACTION,
	WORKSPACE_OPEN_ACTION,
	WORKSPACE_READ_ACTION,
	WORKSPACE_RELOAD_ACTION,
} from "./actions.ts";
import type { Locale } from "./locale.ts";
import type { PanelGroup, PanelRow, PanelSpec } from "./panels.ts";
import type { MessageKey } from "./strings.ts";
import { translate } from "./strings.ts";

/** The dock's tabs, in the order it shows them. */
export type DockTabId = "files" | "terminal" | "conversations" | "tasks";

const TAB_IDS: readonly DockTabId[] = ["files", "terminal", "conversations", "tasks"];
const TAB_MESSAGES: Readonly<Record<DockTabId, MessageKey>> = {
	files: "dock.files",
	terminal: "dock.terminal",
	conversations: "dock.conversations",
	tasks: "dock.tasks",
};

export interface DockTab {
	readonly id: DockTabId;
	readonly label: string;
	readonly active: boolean;
}

export interface DockView {
	readonly open: boolean;
	readonly tabs: readonly DockTab[];
	/** The open tab's panel. */
	readonly panel: PanelSpec;
	/** The control that shows or hides the dock. */
	readonly toggle: { readonly label: string; readonly pressed: boolean };
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
	readonly view: WorkspaceViewLike;
}

export type WorkspaceViewLike =
	| {
			readonly kind: "listing";
			readonly path: string;
			readonly parent: string | null;
			readonly entries: readonly WorkspaceEntryLike[];
	  }
	| {
			readonly kind: "text";
			readonly path: string;
			readonly text: string;
			readonly truncated: boolean;
	  }
	| { readonly kind: "binary"; readonly path: string }
	| { readonly kind: "missing"; readonly path: string }
	| { readonly kind: "denied"; readonly path: string; readonly reason: string };

/** What the host's terminal state carries, as this package reads it. */
export interface TerminalStateLike {
	readonly status: "idle" | "running" | "done" | "cancelled";
	readonly command: string | null;
	readonly exitCode: number | null;
	readonly output: string;
	readonly truncated: boolean;
	readonly error: string | null;
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
}

/** One live task of the session's task graph, as the host publishes it. */
export interface TaskSummaryLike {
	readonly id: string;
	readonly kind: string;
	readonly conversationId: string;
	readonly ownerTaskId?: string;
	readonly background: boolean;
	readonly status: string;
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
	readonly open: boolean;
	readonly tab: string;
	/** The session's working directory, which both dock surfaces live in. */
	readonly cwd: string;
	readonly workspace: WorkspaceStateLike | undefined;
	readonly terminal: TerminalStateLike | undefined;
	readonly conversations: ConversationsStateLike | undefined;
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
export function conversationsPanel(locale: Locale, state: ConversationsStateLike | undefined): PanelSpec {
	const title = translate(locale, "dock.conversations");
	if (state === undefined) return { id: "conversations", title, notices: [], groups: [] };
	const rows: PanelRow[] = state.conversations.map((conversation) => ({
		id: `conversation:${conversation.id}`,
		title: conversationTitle(locale, conversation),
		description:
			conversation.ownerConversationId !== undefined && conversation.ownerTaskId !== undefined
				? translate(locale, "dock.owner", {
						task: `task ${conversation.ownerTaskId}`,
						conversation: `conversation ${conversation.ownerConversationId}`,
					})
				: conversation.parentConversationId !== undefined
					? translate(locale, "dock.forkedFrom", {
							conversation: conversation.parentConversationId,
							entry: conversation.parentEntryId ?? "",
						})
					: conversation.id,
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
		],
		actions: [
			{
				id: CONVERSATION_SELECT_ACTION,
				label: translate(locale, "dock.select"),
				tone: "default",
				data: conversation.id,
			},
			{
				id: CONVERSATION_FORK_ACTION,
				label: translate(locale, "header.fork"),
				tone: "default",
				data: conversation.id,
				disabled: !conversation.hasEntries,
			},
		],
	}));
	return {
		id: "conversations",
		title,
		notices: [],
		groups: [
			{
				id: "conversations:list",
				title: translate(locale, "dock.conversations"),
				actions: [
					{
						id: CONVERSATIONS_REFRESH_ACTION,
						label: translate(locale, "dock.reload"),
						tone: "default",
					},
				],
				rows,
				empty: translate(locale, "dock.noConversations"),
			},
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
	const rows: PanelRow[] = state.tasks.map((task) => ({
		id: `task:${task.id}`,
		title: `${task.kind} ${task.id}`,
		description: `${translate(locale, "dock.taskPhase", { phase: task.phase })} · ${task.conversationId}`,
		badges: [
			task.status,
			...(task.background ? [translate(locale, "dock.background")] : []),
			...(task.waitsOn.length > 0
				? [
						translate(locale, "dock.taskWaitsOn", {
							tasks: task.waitsOn.join(", "),
						}),
					]
				: []),
			...(task.conversations.length > 0
				? [
						translate(locale, "dock.taskOwns", {
							conversations: task.conversations.join(", "),
						}),
					]
				: []),
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
						tone: "default",
					},
				],
				rows,
				empty: translate(locale, "dock.noTasks"),
			},
		],
	};
}

export function dockTabs(locale: Locale, current: string): DockTab[] {
	return TAB_IDS.map((id) => ({
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

function reloadAction(locale: Locale) {
	return {
		id: WORKSPACE_RELOAD_ACTION,
		label: translate(locale, "dock.reload"),
		tone: "default" as const,
	};
}

function openAction(locale: Locale, path: string) {
	return {
		id: WORKSPACE_OPEN_ACTION,
		label: translate(locale, "dock.open"),
		tone: "default" as const,
		data: path,
	};
}

/** The row that walks back out of a file's directory to the directory itself. */
function rootRow(locale: Locale, title: string, path: string): PanelRow {
	return {
		id: "files:root",
		title,
		description: path,
		actions: [openAction(locale, path)],
	};
}

/**
 * The files panel: the directory being listed with one row per entry (a directory opens, a file
 * reads), or the file that was read with its text below. A refusal the host reported — outside the
 * working directory, binary, missing — is the panel's notice.
 */
export function filesPanel(locale: Locale, state: WorkspaceStateLike | undefined): PanelSpec {
	const title = translate(locale, "dock.files");
	if (state === undefined) {
		return { id: "files", title, notices: [], groups: [] };
	}
	const view = state.view;
	if (view.kind === "text") {
		// The file's own directory is the parent of its path, so the reader can step back out.
		const parent = view.path.includes("/") ? view.path.slice(0, view.path.lastIndexOf("/")) : ".";
		return {
			id: "files",
			title: view.path,
			description: state.cwd,
			notices: view.truncated ? [{ tone: "info", text: translate(locale, "dock.truncated") }] : [],
			groups: [
				{
					id: "files:back",
					title: translate(locale, "dock.contents"),
					actions: [reloadAction(locale)],
					rows: [rootRow(locale, parent === "." ? translate(locale, "dock.cwd") : parent, parent)],
				},
			],
			texts: [{ id: "files:text", text: view.text }],
		};
	}
	if (view.kind !== "listing") {
		const notice = view.kind === "denied" ? view.reason : view.kind === "binary" ? translate(locale, "dock.binary") : translate(locale, "dock.missing");
		return {
			id: "files",
			title: view.path,
			description: state.cwd,
			notices: [{ tone: view.kind === "denied" ? "error" : "info", text: notice }],
			groups: [
				{
					id: "files:back",
					title: translate(locale, "dock.contents"),
					actions: [reloadAction(locale)],
					rows: [rootRow(locale, translate(locale, "dock.cwd"), ".")],
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
			actions: [openAction(locale, view.parent)],
		});
	}
	for (const entry of view.entries) {
		const path = view.path === "." ? entry.name : `${view.path}/${entry.name}`;
		rows.push({
			id: `files:${path}`,
			title: entry.name,
			...(entry.kind === "dir" ? { badges: [translate(locale, "dock.directory")] } : { value: workspaceSize(entry.size) }),
			actions: [
				entry.kind === "dir"
					? openAction(locale, path)
					: {
							id: WORKSPACE_READ_ACTION,
							label: translate(locale, "dock.read"),
							tone: "default" as const,
							data: path,
						},
			],
		});
	}
	const group: PanelGroup = {
		id: "files:entries",
		title: view.path === "." ? translate(locale, "dock.cwd") : view.path,
		actions: [reloadAction(locale)],
		rows,
		empty: translate(locale, "dock.emptyDirectory"),
	};
	return {
		id: "files",
		title,
		description: state.cwd,
		notices: [],
		groups: [group],
	};
}

/** One line naming what the terminal's buffer shows. */
function terminalStatus(locale: Locale, state: TerminalStateLike): string {
	if (state.error !== null) return translate(locale, "dock.terminalFailed", { error: state.error });
	switch (state.status) {
		case "idle":
			return translate(locale, "dock.terminalIdle");
		case "running":
			return translate(locale, "dock.terminalRunning", {
				command: state.command ?? "",
			});
		case "cancelled":
			return translate(locale, "dock.terminalCancelled");
		case "done":
			return translate(locale, "dock.terminalDone", {
				code: String(state.exitCode ?? 0),
			});
	}
}

/** The terminal panel: one command line, the run and stop controls, and the output below. */
export function terminalPanel(
	locale: Locale,
	input: {
		readonly cwd: string;
		readonly state: TerminalStateLike | undefined;
	},
): PanelSpec {
	const title = translate(locale, "dock.terminal");
	const state = input.state;
	if (state === undefined) {
		return {
			id: "terminal",
			title,
			description: input.cwd,
			notices: [],
			groups: [],
			texts: [],
		};
	}
	const running = state.status === "running";
	return {
		id: "terminal",
		title,
		description: `${input.cwd} · ${terminalStatus(locale, state)}`,
		notices: state.truncated ? [{ tone: "info", text: translate(locale, "dock.truncated") }] : [],
		groups: [
			{
				id: "terminal:controls",
				title: translate(locale, "dock.command"),
				rows: [],
				actions: [
					{
						id: TERMINAL_STOP_ACTION,
						label: translate(locale, "dock.stop"),
						tone: "danger",
						disabled: !running,
					},
				],
			},
		],
		inputs: [
			{
				id: "terminal:line",
				placeholder: translate(locale, "dock.runPlaceholder"),
				value: "",
				submit: {
					id: TERMINAL_RUN_ACTION,
					label: translate(locale, "dock.run"),
					tone: "primary",
					disabled: running,
				},
			},
		],
		texts: [
			{
				id: "terminal:output",
				text: state.output,
				empty: translate(locale, "dock.noOutput"),
			},
		],
	};
}

/** The dock the main area shows beside the conversation. */
export function dockView(locale: Locale, input: DockViewInput): DockView {
	const tab = (TAB_IDS as readonly string[]).includes(input.tab) ? (input.tab as DockTabId) : "files";
	const panel =
		tab === "files"
			? filesPanel(locale, input.workspace)
			: tab === "terminal"
				? terminalPanel(locale, { cwd: input.cwd, state: input.terminal })
				: tab === "conversations"
					? conversationsPanel(locale, input.conversations)
					: tasksPanel(locale, input.conversations);
	return {
		open: input.open,
		tabs: dockTabs(locale, tab),
		panel,
		toggle: { label: translate(locale, "dock.toggle"), pressed: input.open },
	};
}
