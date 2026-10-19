/// <reference lib="dom" />
/**
 * Page entry: read the host's boot manifest, dial the loopback byte transport, bind the host's
 * replicated services, and paint them. The page contract, view model, and DOM renderer come from
 * `@amazme/web`; this module owns the client lifecycle, session attachment, and the visible
 * failure states.
 */
import { FONT_FAMILY_FIELDS, FONT_SIZE_FIELDS, resolveTypography } from "@amazme/web/typography";
import type { ModelThinkingLevel } from "@amazme/ai";
import type { ReplicatedState } from "@amazme/chord";
import type { RoutedServices } from "../services/connection.ts";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@amazme/chord/context";
import { Client, type ClientOptions } from "@amazme/client";
import { createWebSocketTransportFactory } from "@amazme/client/websocket";
import type { ConversationView, EntryRecord } from "@amazme/durable";
import {
	PROJECT_ADD_ACTION, PROJECT_ADD_MODAL, PROJECT_SELECT_ACTION, PROJECT_RENAME_ACTION, PROJECT_RENAME_MODAL,
	PROJECT_EDIT_ACTION, PROJECT_EDIT_MODAL, PROJECT_NEW_SESSION_ACTION,
	PROJECT_REMOVE_ACTION, PROJECT_REMOVE_MODAL, SESSION_ARCHIVE_OPEN_ACTION, SESSION_ARCHIVE_ACTION, SESSION_RESTORE_ACTION,
	SESSION_ARCHIVE_MODAL, archiveSessionModal,
	addProjectModal, editProjectModal, renameProjectModal, removeProjectModal,
} from "@amazme/web";
import {
	AUTOMATION_VIEW,
	APPROVAL_APPROVE_ACTION,
	APPROVAL_DENY_ACTION,
	ATTACHMENT_REMOVE_ACTION,
	addMcpServerModal,
	mcpProjectModal,
	addPackageModal,
	addScheduleModal,
	editScheduleModal,
	scheduleHistoryModal,
	scheduleActionCopy,
	applyTheme,
	attachmentRejection,
	BOOT_GLOBAL,
	buildWebView,
	promptSuggestionContext,
	PromptSuggestionController,
	CHAT_VIEW,
	COMPACT_ACTION,
	COMPACT_MODAL,
	CONVERSATION_FORK_ACTION,
	CONVERSATION_SELECT_ACTION,
	CONVERSATIONS_REFRESH_ACTION,
	TASK_RETRY_ACTION,
	CONVERSATION_RENAME_ACTION,
	CONVERSATION_RENAME_MODAL,
	CONVERSATION_ARCHIVE_ACTION,
	CONVERSATION_ARCHIVE_MODAL,
	CONVERSATION_RESTORE_ACTION,
	renameForkModal,
	archiveForkModal,
	collectPageElements,
	commandPalette,
	compactModal,
	composeSkill,
	createRenderer,
	DOCK_TAB_ACTION,
	DOCK_TOGGLE_ACTION,
	documentLanguage,
	FALLBACK_LOCALE,
	FEEDBACK_DOWN_ACTION,
	FEEDBACK_UP_ACTION,
	failureView,
	followSystemTheme,
	HISTORY_MORE_ACTION,
	TRANSCRIPT_SEARCH_ACTION,
	importSkillModal,
	isBusy,
	type Locale,
	type MessageKey,
	newSkillModal,
	type PageElements,
	type PageRenderer,
	type PanelAction,
	type PanelGroup,
	type PanelModal,
	type PanelNotice,
	type PanelRow,
	type WebView,
	PLUGIN_MCP_ADD_ACTION,
	PLUGIN_MCP_RELOAD_ACTION,
	PLUGIN_MCP_RECONNECT_ACTION,
	PLUGIN_MCP_LOGIN_ACTION,
	PLUGIN_MCP_LOGIN_OPEN_ACTION,
	PLUGIN_MCP_LOGIN_REDIRECT_ACTION,
	PLUGIN_MCP_LOGIN_CANCEL_ACTION,
	PLUGIN_MCP_LOGIN_MODAL,
	PLUGIN_MCP_ENABLED_ACTION,
	PLUGIN_MCP_EXPOSURE_ACTION,
	PLUGIN_MCP_MODAL,
	PLUGIN_MCP_PROJECT_ACTION,
	PLUGIN_MCP_PROJECT_MODAL,
	PLUGIN_MCP_REMOVE_ACTION,
	PLUGIN_PACKAGE_ADD_ACTION,
	PLUGIN_PACKAGE_MODAL,
	PLUGIN_PACKAGE_REMOVE_ACTION,
	panelNav,
	parseCommandLine,
	QUEUE_CANCEL_ACTION,
	REFRESH_MODELS_ACTION,
	MODEL_SELECT_ACTION,
	MODEL_THINKING_ACTION,
	modelPicker,
	MODEL_SCOPE_ACTION,
	MODEL_SCOPE_MODAL,
	MODEL_DEFAULTS_ACTION,
	SESSION_RELOAD_ACTION,
	modelScopeModal,
	PROVIDER_AUTH_ACTION,
	PROVIDER_AUTH_MODAL,
	PROVIDER_AUTH_OPEN_ACTION,
	PROVIDER_AUTH_CANCEL_ACTION,
	providerAuthModal,
	providerLoginModal,
	removeScheduleModal,
	removeSessionModal,
	renameSessionModal,
	SESSION_RENAME_ACTION,
	SESSION_RENAME_MODAL,
	removeSkillModal,
	resolveLocale,
	resolveThemePreference,
	rosterItems,
	SCHEDULE_ADD_ACTION,
	SCHEDULE_ADD_MODAL,
	SCHEDULE_ENABLED_ACTION,
	SCHEDULE_REMOVE_ACTION,
	SCHEDULE_REMOVE_MODAL,
	SCHEDULE_RUN_ACTION,
	SCHEDULE_CANCEL_ACTION,
	SCHEDULE_EDIT_ACTION,
	SCHEDULE_HISTORY_ACTION,
	SCHEDULE_HISTORY_MODAL,
	SCHEDULE_RELOAD_ACTION,
	SESSION_REMOVE_ACTION,
	SESSION_REMOVE_MODAL,
	SETTINGS_FIELD_ACTION,
	SETTINGS_RELOAD_ACTION,
	DIAGNOSTICS_ACTION,
	DIAGNOSTICS_MODAL,
	SETTINGS_VIEW,
	type ShortcutId,
	SKILL_CREATE_MODAL,
	SKILL_EDIT_ACTION,
	SKILL_EDIT_MODAL,
	SKILL_IMPORT_ACTION,
	SKILL_IMPORT_MODAL,
	SKILL_NEW_ACTION,
	SKILL_REMOVE_ACTION,
	SKILL_REMOVE_MODAL,
	SUBMIT_MODE_ACTION,
	type SubmitMode,
	skillModal,
	TERMINAL_RUN_ACTION,
	TERMINAL_STOP_ACTION,
	type ThemePreference,
	translate,
	WELCOME_DISMISS_ACTION,
	WELCOME_SESSION_ACTION,
	WELCOME_SETTINGS_ACTION,
	type WebBootManifest,
	WORKSPACE_OPEN_ACTION,
	WORKSPACE_READ_ACTION,
	WORKSPACE_RELOAD_ACTION,
	WORKSPACE_PAGE_ACTION,
	workspacePath,
	parseWorkspaceAction,
	type CommandLike,
} from "@amazme/web";
import { oldestPresentedEntryId } from "../../durable/conversation-view.ts";
import { sessionOpenErrorText } from "../session-database-error.ts";
import { sessionDeepLink } from "./deep-link.ts";
import { HistoryAvailability, loadRemainingHistory } from "./history-availability.ts";
import { perfRequest, runPerfCase } from "./perf.ts";
import { AgentController, type AgentPromptImage } from "../../core/plugins/agent-controller.ts";
import { Approvals, type Approvals as ApprovalsService, type ApprovalsState } from "../services/approvals.ts";
import { Commands, type Commands as CommandsService, type CommandsState } from "../services/commands.ts";
import { createServerServiceSource, createSessionServiceSource, type SessionServiceSource } from "../services/connection.ts";
import { Conversations, type Conversations as ConversationsService } from "../services/conversations.ts";
import { Feedback, type Feedback as FeedbackService, type FeedbackState } from "../services/feedback.ts";
import { Mcp, type Mcp as McpService } from "../services/mcp.ts";
import type { McpManagementState } from "../../core/mcp/management.ts";
import type { McpExposure } from "../../core/mcp-servers.ts";
import { Models, type Models as ModelsService, type ModelsState } from "../services/models.ts";
import { Plugins, PresentationPlugins } from "../services/plugins.ts";
import { type ScheduleInput, type ScheduleResult, Schedules, type Schedules as SchedulesService } from "../../core/plugins/schedules.ts";
import { SessionDirectory, SessionManagement } from "../services/sessions.ts";
import { isProjectSelection, ProjectManagement, SessionArchive } from "../services/projects.ts";
import type { ProjectSelection } from "../services/projects.ts";
import { SessionSettings, Settings, type SettingsState } from "../services/settings.ts";
import { SessionInsights } from "../services/insights.ts";
import { SessionMirror } from "../services/session-mirror.ts";
import type { SessionMirrorWarning } from "../services/session-mirror.ts";
import { Skills } from "../services/skills.ts";
import { Diagnostics } from "../services/diagnostics.ts";
import { formatDiagnosticReport, type DiagnosticReport } from "../../core/diagnostics-types.ts";
import { Terminal, type Terminal as TerminalService, type TerminalState } from "../services/terminal.ts";
import { Transcript } from "../services/transcript.ts";
import { Workspace } from "../services/workspace.ts";
import type { Workspace as WorkspaceService, WorkspaceOpenInput, WorkspaceState } from "../services/workspace.ts";

function readManifest(): WebBootManifest | undefined {
	const candidate = (globalThis as Record<string, unknown>)[BOOT_GLOBAL];
	if (typeof candidate !== "object" || candidate === null) return undefined;
	const manifest = candidate as Partial<WebBootManifest>;
	if (typeof manifest.server?.id !== "string" || typeof manifest.transport?.url !== "string") return undefined;
	return manifest as WebBootManifest;
}

function message(error: unknown): string {
	return sessionOpenErrorText(error) ?? (error instanceof Error ? error.message : String(error));
}

/** One image the reader attached and has not sent yet, kept as the prompt will carry it. */
interface PendingImage {
	readonly id: string;
	readonly name: string;
	readonly mediaType: string;
	readonly bytes: number;
	/** The thumbnail, and the source the base64 payload is cut from. */
	readonly dataUrl: string;
	readonly data: string;
}

/**
 * A connection or attachment transition replaces a service binding, and a call that was in flight
 * on the old one fails with a disposed binding. Attaching is idempotent, so the page tries once
 * more instead of handing the reader a failure that a moment later would not happen.
 */
async function retryOnRebind<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (!message(error).toLowerCase().includes("binding is disposed")) throw error;
		return await run();
	}
}

/**
 * Queues the page's session transitions, so they run one at a time and in the order they were
 * asked for. A transition releases the bindings of the attachment before it, so two running at
 * once would have the later one dispose the bindings the earlier one is still binding — a "binding
 * is disposed" failure the page brought on itself. The last request is the one that ends attached.
 */
export function sessionTransitions(): <T>(run: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(run: () => Promise<T>): Promise<T> => {
		const next = tail.then(run, run);
		tail = next.catch(() => undefined);
		return next;
	};
}

/** Dock actions for leaving the focused conversation back to an earlier entry. The host performs them. */
const LEAVE_ACTION = "conversation:leave";
const LEAVE_SUMMARY_ACTION = "conversation:leave-summary";
const LEAVE_CUSTOM_ACTION = "conversation:leave-custom";
const LEAVE_CUSTOM_MODAL = "conversation:leave-custom-submit";

/** Return-point rows on the conversations dock, sharing the host's leave path with `/tree`. */
function withReturnPoints(view: WebView, points: readonly { readonly id: string; readonly label: string }[], skipPrompt: boolean): WebView {
	if (view.readOnly || view.dock.panel.id !== "conversations" || points.length === 0) return view;
	const copy = (key: MessageKey): string => translate(view.locale, key);
	const actions = (id: string): PanelRow["actions"] =>
		skipPrompt
			? [{ id: LEAVE_ACTION, label: copy("history.return"), tone: "default", data: id }]
			: [
					{ id: LEAVE_ACTION, label: copy("history.noSummary"), tone: "default", data: id },
					{ id: LEAVE_SUMMARY_ACTION, label: copy("history.summarize"), tone: "default", data: id },
					{ id: LEAVE_CUSTOM_ACTION, label: copy("history.custom"), tone: "default", data: id },
				];
	const rows: PanelRow[] = points.map((point) => ({
		id: `return:${point.id}`,
		title: point.label,
		description: copy("history.continue"),
		actions: actions(point.id),
	}));
	const group: PanelGroup = {
		id: "conversations:return",
		title: copy("history.returnTo"),
		rows,
		empty: "",
	};
	return {
		...view,
		dock: {
			...view.dock,
			panel: {
				...view.dock.panel,
				groups: [...view.dock.panel.groups, group],
			},
		},
	};
}

/** Read one picked file as a data URL; the browser does the decoding. */
function readAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error("read failed"));
		reader.readAsDataURL(file);
	});
}

/** Attach one session and keep its transcript subscribed until the attachment changes. */
class SessionPainter {
	/** The language of the view this page paints; the page sets it before every paint. */
	locale: Locale = "en";
	readonly #sessionSource: SessionServiceSource;
	readonly #renderer: PageRenderer;
	readonly #plugins: PresentationPlugins;
	#transcript: ReplicatedState<ConversationView> | undefined;
	#controller: AgentController | undefined;
	#models: Models | undefined;
	#mcp: McpService | undefined;
	#sessionSettings: SessionSettings | undefined;
	#insights: SessionInsights | undefined;
	#reviewDiff: string | undefined;
	#reviewRequest = 0;
	#reviewIdentity: string | undefined;
	#mirror: SessionMirror | undefined;
	#commands: CommandsService | undefined;
	#workspace: WorkspaceService | undefined;
	#terminal: TerminalService | undefined;
	#conversations: ConversationsService | undefined;
	#approvals: ApprovalsService | undefined;
	#levels: readonly string[] | undefined;
	#levelsModel: string | undefined;
	#levelsRequest = 0;
	#services: ReturnType<SessionServiceSource["open"]> | undefined;
	#sessionId: string | undefined;
	#ready = false;

	constructor(sessionSource: SessionServiceSource, renderer: PageRenderer, plugins: PresentationPlugins) {
		this.#sessionSource = sessionSource;
		this.#renderer = renderer;
		this.#plugins = plugins;
	}

	get sessionId(): string | undefined {
		return this.#sessionId;
	}
	get ready(): boolean {
		return this.#ready;
	}
	get binding(): object | undefined {
		return this.#services;
	}
	get settingsValue(): SessionSettings["state"]["value"] {
		return this.#sessionSettings?.state.value;
	}
	get settingsService(): SessionSettings | undefined {
		return this.#sessionSettings;
	}
	get insightsService(): SessionInsights | undefined { return this.#insights; }
	get insights(): SessionInsights["state"]["value"] {
		const value = this.#insights?.state.value;
		return value?.conversationId === this.#conversations?.state.value?.selected ? value : undefined;
	}
	get reviewDiff(): string | undefined { return this.#reviewDiff; }
	async inspectDiff(conversation: string, root: string, path: string): Promise<void> {
		const service = this.#insights, request = ++this.#reviewRequest;
		if (!service) return;
		const diff = await service.diff(conversation, root, path, BACKGROUND_CONTEXT);
		if (this.#insights === service && this.#reviewRequest === request && this.insights?.conversationId === conversation) this.#reviewDiff = diff;
	}

	get mirrorWarning(): SessionMirrorWarning | null | undefined {
		return this.#mirror?.state.value?.warning;
	}

	get transcriptValue(): ConversationView | undefined {
		return this.#transcript?.value;
	}

	/**
	 * A non-root conversation the page is driving. The root stays on `AgentController`; a fork or
	 * subagent goes through the conversations service, which owns that conversation's controller.
	 */
	#focused(conversationId: string | undefined): { readonly id: string; readonly view: ConversationView | undefined } | undefined {
		if (conversationId === undefined) return undefined;
		const conversations = this.#conversations;
		if (conversations === undefined) return undefined;
		const state = conversations.state.value;
		if (state === undefined) return undefined;
		const root = state.conversations.find((entry) => entry.root)?.id;
		if (root === undefined || conversationId === root) return undefined;
		return { id: conversationId, view: state.view ?? undefined };
	}

	get mcpValue(): McpManagementState | undefined {
		return this.#mcp?.state.value;
	}
	get mcpService(): McpService | undefined {
		return this.#mcp;
	}

	get modelsValue(): ModelsState | undefined {
		return this.#models?.state.value;
	}
	get modelsService(): ModelsService | undefined {
		return this.#models;
	}

	/** The attached model's levels; `undefined` until the host has answered for this model. */
	get levels(): readonly string[] | undefined {
		return this.#levels;
	}

	/** The attached session's file browser, including its selected project folder. */
	get workspace(): WorkspaceState | undefined {
		return this.#workspace?.state.value;
	}

	/** The attached session's shell buffer. */
	get terminal(): TerminalState | undefined {
		return this.#terminal?.state.value;
	}

	get workspaceService(): WorkspaceService | undefined { return this.#workspace; }

	async workspaceOpen(path: WorkspaceOpenInput): Promise<void> {
		await this.#workspace?.open(path, BACKGROUND_CONTEXT);
	}

	async workspaceRead(path: string): Promise<void> {
		await this.#workspace?.read(path, BACKGROUND_CONTEXT);
	}

	async workspaceNavigate(data: string | undefined): Promise<void> {
		const target = parseWorkspaceAction(data);
		if (target.kind === "read") await this.workspaceRead(target.path);
		else await this.workspaceOpen(target.offset === undefined ? target.path : { path: target.path, offset: target.offset });
	}

	async runTerminal(command: string): Promise<void> {
		const result = await this.#terminal?.run(command, BACKGROUND_CONTEXT);
		if (result !== undefined && !result.ok) throw new Error(result.problem);
	}

	async stopTerminal(): Promise<void> {
		await this.#terminal?.stop(BACKGROUND_CONTEXT);
	}

	/** The tool calls waiting for the reader's decision. */
	get approvals(): ApprovalsState | undefined {
		return this.#approvals?.state.value;
	}

	/** The approvals service itself, for the decisions the page reports. */
	get approvalsService(): ApprovalsService | undefined {
		return this.#approvals;
	}

	/** The session's conversations, live tasks, and the focused conversation's view. */
	get conversations(): ConversationsService["state"]["value"] | undefined {
		return this.#conversations?.state.value;
	}

	get conversationsService(): ConversationsService | undefined {
		return this.#conversations;
	}

	/** The session's command catalogue, as the host published it. */
	get commands(): CommandsState["commands"] {
		return this.#commands?.state.value?.commands ?? [];
	}

	/** That catalogue's replicated state, so a page repaints when the host revises it. */
	get commandsState(): ReplicatedState<CommandsState> | undefined {
		return this.#commands?.state;
	}

	/** Run one of the host's commands; the result carries the note or the problem to show. */
	async runCommand(name: string, args: string): Promise<{ readonly ok: boolean; readonly message: string }> {
		const commands = this.#commands;
		if (commands === undefined)
			return {
				ok: false,
				message: translate(this.locale, "page.commandUnknown", { name }),
			};
		if (name === "reload") {
			const sessionId = this.#sessionId;
			if (sessionId === undefined) throw new Error(translate(this.locale, "page.reloadTargetChanged"));
			const assertAttached = (): void => {
				if (this.#sessionId !== sessionId || this.#commands !== commands) {
					throw new Error(translate(this.locale, "page.reloadTargetChanged"));
				}
			};
			// The server owns source builds; the worker then switches to the resulting generation.
			try {
				await this.#plugins.prepareSession({ sessionId, packagePaths: null }, BACKGROUND_CONTEXT);
				assertAttached();
				await this.#plugins.reload(BACKGROUND_CONTEXT);
			} catch {
				assertAttached();
				return { ok: false, message: translate(this.locale, "page.pluginBuildFailed") };
			}
			assertAttached();
		}
		const result = await commands.run(name, args, BACKGROUND_CONTEXT).catch((error: unknown) => {
			if (name !== "reload") throw error;
			return { ok: false, problem: translate(this.locale, "page.pluginActivationFailed") } as const;
		});
		return result.ok
			? { ok: true, message: name === "reload" ? translate(this.locale, "page.pluginsReloaded") : result.note }
			: { ok: false, message: result.problem };
	}

	/** The host's completions for one command's argument. */
	async complete(name: string, prefix: string): Promise<readonly { value: string; label: string; description?: string }[]> {
		return (await this.#commands?.complete(name, prefix, BACKGROUND_CONTEXT)) ?? [];
	}

	/**
	 * The prompt a resource command stands for — a prompt template or a skill. The host expands it
	 * with the same code the terminal uses, so both clients send the model the same text; the page
	 * sends it, so a focused conversation and the composer's submit mode still apply.
	 */
	async expandCommand(
		name: string,
		args: string,
	): Promise<{ readonly ok: boolean; readonly message: string }> {
		const commands = this.#commands;
		if (commands === undefined) return { ok: false, message: translate(this.locale, "page.commandUnknown", { name }) };
		const expansion = await commands.expand(name, args, BACKGROUND_CONTEXT);
		return expansion.ok ? { ok: true, message: expansion.prompt } : { ok: false, message: expansion.problem };
	}

	/** Have the host re-read the session's templates and skills after their files changed. */
	async refreshCommands(): Promise<void> {
		await this.#commands?.refresh(BACKGROUND_CONTEXT);
	}

	/**
	 * Send input to the attached session: an image prompt, a new run when idle, or — while a turn
	 * runs — the mode the composer asks for, so a mid-turn message is a steer or a queued follow-up.
	 */
	async submit(text: string, mode: SubmitMode, images: readonly AgentPromptImage[] = [], conversationId?: string): Promise<void> {
		const request = {
			message: text,
			images: images.length === 0 ? null : [...images],
		};
		const focused = this.#focused(conversationId);
		const conversations = this.#conversations;
		if (focused !== undefined && conversations !== undefined) {
			const response = !isBusy(focused.view)
				? await conversations.prompt(focused.id, request, BACKGROUND_CONTEXT)
				: mode === "steer"
					? await conversations.steer(focused.id, request, BACKGROUND_CONTEXT)
					: await conversations.followUp(focused.id, request, BACKGROUND_CONTEXT);
			if (!response.accepted) {
				this.#renderer.setConnection(
					translate(this.locale, "page.promptRejected", {
						error: response.error.message,
					}),
					"error",
				);
			}
			return;
		}
		const controller = this.#controller;
		if (controller === undefined) return;
		const response = !isBusy(this.transcriptValue)
			? await controller.prompt(request, BACKGROUND_CONTEXT)
			: mode === "steer"
				? await controller.steer(request, BACKGROUND_CONTEXT)
				: await controller.followUp(request, BACKGROUND_CONTEXT);
		// A rejection must be visible; an accepted prompt shows itself in the transcript.
		if (!response.accepted) {
			this.#renderer.setConnection(
				translate(this.locale, "page.promptRejected", {
					error: response.error.message,
				}),
				"error",
			);
		}
	}

	/** Withdraw queued input and abort the running turn and compaction. */
	async abort(conversationId?: string): Promise<void> {
		const focused = this.#focused(conversationId);
		if (focused !== undefined && this.#conversations !== undefined) {
			await this.#conversations.abort(focused.id, BACKGROUND_CONTEXT);
			return;
		}
		await this.#controller?.abort(BACKGROUND_CONTEXT);
	}

	/** Withdraw one queued input by its inbox submission id; the rest stay queued. */
	async cancelQueued(entryId: string, conversationId?: string): Promise<void> {
		const focused = this.#focused(conversationId);
		const outcome =
			focused !== undefined && this.#conversations !== undefined
				? await this.#conversations.cancelQueued(focused.id, entryId, BACKGROUND_CONTEXT)
				: await this.#controller?.cancelQueued(entryId, BACKGROUND_CONTEXT);
		if (outcome !== undefined && outcome.outcome !== "cancelled") {
			this.#renderer.setConnection(translate(this.locale, "page.queueGone"), "error");
		}
	}

	/** Summarize the conversation so far; an empty instruction asks the host for its own summary. */
	async compact(instructions: string, conversationId?: string): Promise<void> {
		const trimmed = instructions.trim();
		const request = {
			customInstructions: trimmed.length === 0 ? null : trimmed,
		};
		const focused = this.#focused(conversationId);
		const response =
			focused !== undefined && this.#conversations !== undefined
				? await this.#conversations.compact(focused.id, request, BACKGROUND_CONTEXT)
				: await this.#controller?.compact(request, BACKGROUND_CONTEXT);
		if (response !== undefined && !response.accepted) {
			this.#renderer.setConnection(
				translate(this.locale, "page.compactFailed", {
					error: response.error.message,
				}),
				"error",
			);
		}
	}

	/** Ask the host to re-read the provider catalog; the state reports the outcome. */
	async refreshModels(): Promise<void> {
		await this.#models?.refresh(BACKGROUND_CONTEXT);
	}

	/** Switch the attached session's model; the host owns which ids exist. */
	async selectModel(provider: string, modelId: string): Promise<void> {
		await this.#models?.select({ provider, modelId }, BACKGROUND_CONTEXT);
	}

	/** Switch the attached model's thinking level; the host validates the level. */
	async selectThinking(level: string): Promise<void> {
		await this.#models?.selectThinking(level as ModelThinkingLevel, BACKGROUND_CONTEXT);
	}

	/**
	 * Read the levels the host supports for the attached model, once per model. The models state is
	 * replicated, so a switch made anywhere — this page, the TUI, another tab — lands here.
	 */
	async #refreshLevels(paint: () => void): Promise<void> {
		const service = this.#models;
		const configuration = service?.state.value?.configuration.model;
		const model = `${service?.state.value?.catalog.revision}:${configuration === undefined || configuration === null ? "" : `${configuration.provider}/${configuration.modelId}`}`;
		if (service === undefined || model === this.#levelsModel) return;
		this.#levelsModel = model;
		this.#levels = undefined;
		const request = ++this.#levelsRequest;
		const current = () => this.#models === service && this.#levelsRequest === request;
		try {
			const levels = await service.getThinkingLevels(BACKGROUND_CONTEXT);
			if (!current()) return;
			this.#levels = levels;
		} catch (error) {
			if (!current()) return;
			this.#levelsModel = undefined;
			throw error;
		}
		paint();
	}

	async attach(sessionId: string, paint: () => void): Promise<void> {
		// Bound services are the mark of a live attachment: the same id with nothing bound is a
		// stale handle from a transition that was interrupted, so it is bound again.
		if (this.#sessionId === sessionId && this.ready) return;
		await this.detach();
		this.#sessionId = sessionId;
		const attached = this.#sessionSource.attachment.value;
		if (attached === undefined || attached.status === "detached" || attached.sessionId !== sessionId) {
			throw new Error(`Host did not attach session ${sessionId}`);
		}
		const catalogue = await this.#sessionSource.catalogue(BACKGROUND_CONTEXT);
		const hasMcp = catalogue.some(entry => entry.serviceId === Mcp.name);
		const hasInsights = catalogue.some(entry => entry.serviceId === SessionInsights.name);
		const services = this.#sessionSource.open({
			services: [Transcript, AgentController, Models, SessionSettings, Commands, Workspace, Terminal, Conversations, Approvals, ...(hasMcp ? [Mcp] : []), ...(hasInsights ? [SessionInsights] : []), SessionMirror],
			assertAccess(): void {},
			onError: (error: Error) => {
				if (this.#services !== services || this.#sessionId !== sessionId) return;
				this.#renderer.setConnection(
					translate(this.locale, "page.streamFailed", {
						error: message(error),
					}),
					"error",
				);
			},
		});
		this.#services = services;
		try {
			await services.ready(BACKGROUND_CONTEXT);
		} catch (error) {
			await this.detach();
			throw error;
		}
		const transcript = services.get(Transcript);
		this.#transcript = transcript.state;
		this.#controller = services.get(AgentController);
		this.#models = services.get(Models);
		this.#mcp = hasMcp ? services.get(Mcp) : undefined;
		this.#mcp?.state.subscribe(() => paint());
		this.#sessionSettings = services.get(SessionSettings);
		this.#sessionSettings.state.subscribe(() => paint());
		this.#mirror = services.get(SessionMirror);
		this.#mirror.state.subscribe(() => paint());
		this.#commands = services.get(Commands);
		this.#workspace = services.get(Workspace);
		this.#terminal = services.get(Terminal);
		this.#conversations = services.get(Conversations);
		this.#insights = hasInsights ? services.get(SessionInsights) : undefined;
		this.#insights?.state.subscribe(() => {
			const value = this.#insights?.state.value;
			const identity = value === undefined ? undefined : `${value.conversationId}:${value.reviewRevision}`;
			if (identity !== this.#reviewIdentity) { this.#reviewIdentity = identity; this.#reviewDiff = undefined; this.#reviewRequest++; }
			paint();
		});
		this.#approvals = services.get(Approvals);
		// A listing, a file, or terminal output lands here; the page repaints the dock from it.
		this.#workspace.state.subscribe(() => paint());
		this.#terminal.state.subscribe(() => paint());
		// The conversation list, the task graph, and the focused view arrive here.
		this.#conversations.state.subscribe(() => paint());
		// A tool call waiting for a decision arrives here.
		this.#approvals.state.subscribe(() => paint());
		this.#levels = undefined;
		this.#levelsModel = undefined;
		// A model switch made anywhere repaints the chip and re-reads the levels of the new model.
		this.#models.state.subscribe(() => {
			paint();
			void this.#refreshLevels(paint).catch((error: unknown) => {
				this.#renderer.setConnection(
					translate(this.locale, "page.modelStateFailed", {
						error: message(error),
					}),
					"error",
				);
			});
		});
		transcript.state.subscribe(() => paint());
		// Reused workers re-read the files changed by another client or the native terminal.
		await this.#sessionSettings.reload(BACKGROUND_CONTEXT);
		await this.#mcp?.reload(BACKGROUND_CONTEXT);
		await this.#workspace.open(".", BACKGROUND_CONTEXT);
		await this.#refreshLevels(paint);
		// The catalogue is re-read once per attachment: a plugin that registered a command while this
		// session started is in it, without the reader doing anything.
		await this.refreshCommands().catch(() => undefined);
		this.#ready = true;
		paint();
	}

	async detach(): Promise<void> {
		// The bindings go first, then their release: a paint that lands while the release is in
		// flight reads an unattached page instead of a disposed handle.
		const services = this.#services;
		this.#ready = false;
		this.#services = undefined;
		this.#transcript = undefined;
		this.#controller = undefined;
		this.#models = undefined;
		this.#mcp = undefined;
		this.#sessionSettings = undefined;
		this.#insights = undefined;
		this.#reviewDiff = undefined;
		this.#reviewIdentity = undefined;
		this.#reviewRequest++;
		this.#mirror = undefined;
		this.#commands = undefined;
		this.#workspace = undefined;
		this.#terminal = undefined;
		this.#conversations = undefined;
		this.#approvals = undefined;
		this.#levels = undefined;
		this.#levelsModel = undefined;
		this.#sessionId = undefined;
		this.#levelsRequest += 1;
		await services?.dispose(BACKGROUND_CONTEXT);
	}
}

export async function startPage(renderer: PageRenderer): Promise<Client | undefined> {
	const manifest = readManifest();
	if (manifest === undefined) {
		fail(renderer, new Error(translate(FALLBACK_LOCALE, "page.noManifest")), FALLBACK_LOCALE);
		return undefined;
	}
	const client = new Client({
		serverId: manifest.server.id,
		transportFactory: createWebSocketTransportFactory({
			url: manifest.transport.url,
		}),
	} satisfies ClientOptions);

	const report = (error: Error): void => renderer.setConnection(error.message, "error");
	const serverSource = createServerServiceSource(client, { onError: report });
	const sessionSource = createSessionServiceSource(client, { onError: report });
	/** The reader's language and palette: the stored preference, or what this browser asks for. */
	let locale: Locale = resolveLocale(manifest.preferences?.locale, navigator.languages);
	let appearance: ThemePreference = resolveThemePreference(manifest.preferences?.appearance);
	let typography = resolveTypography(manifest.preferences.typography);
	const copy = (key: MessageKey, values?: Record<string, string>): string => translate(locale, key, values);
	const serverServices = serverSource.open({
		services: [SessionDirectory, SessionManagement, ProjectManagement, SessionArchive, Settings, Skills, Plugins, PresentationPlugins, Feedback, Diagnostics],
		assertAccess(): void {},
		onError: report,
	});
	const directory = serverServices.get(SessionDirectory);
	const management = serverServices.get(SessionManagement);
	const projects = serverServices.get(ProjectManagement);
	const archives = serverServices.get(SessionArchive);
	/** The management surface's own services, and the view the main area shows. */
	const settings = serverServices.get(Settings);
	const skills = serverServices.get(Skills);
	const plugins = serverServices.get(Plugins);
	const painter = new SessionPainter(sessionSource, renderer, serverServices.get(PresentationPlugins));
	const feedback = serverServices.get(Feedback);
	const diagnostics = serverServices.get(Diagnostics);
	let diagnosticReport: DiagnosticReport | undefined;
	let diagnosticRequest = 0;
	let modelSelection: { readonly binding: object | undefined } | undefined;
	let forkModalOwner: { readonly service: ConversationsService; readonly sessionId: string; readonly conversationId: string } | undefined;
	let schedules: SchedulesService | undefined;
	let scheduleServices: RoutedServices | undefined;
	let removeScheduleObserver: (() => void) | undefined;
	let scheduleEpoch = 0;
	let scheduleDiscovery: Promise<void> = Promise.resolve();
	let booted = false;
	let directoryReady = false;
	const availableViews = (): readonly string[] => ["plugins", "skills", SETTINGS_VIEW, ...(schedules === undefined ? [] : [AUTOMATION_VIEW])];
	let view = CHAT_VIEW;
	let creating = false;
	let modal: PanelModal | undefined;
	let modelScopeView: { readonly service: ModelsService; readonly sessionId: string } | undefined;
	let mcpView: { readonly service: McpService; readonly sessionId: string; readonly target: string } | undefined;
	/** Only the modal's binding and expected ids are local; interaction state stays on Models. */
	let providerAuthView: {
		readonly service: ModelsService;
		readonly sessionId: string;
		loginId?: string;
		starting?: boolean;
		matched?: boolean;
	} | undefined;
	/** How the composer submits while a turn runs; the reader picks it in the composer itself. */
	let submitMode: SubmitMode = "followUp";
	/** Images attached but not sent yet, in the order the reader added them. */
	let pending: readonly PendingImage[] = [];
	let attachmentSequence = 0;
	/** The roster's filter text; the page owns it so creating or attaching never clears it. */
	let rosterFilter = "";
	let selectedProjectId: string | undefined;
	/** Lets the open archived session stay attached. It does not browse the archive list. */
	let allowArchivedAttach = false;
	let selectionRevision = 0;
	const selectionKey = `amazme.selection.${manifest.server.id}`;
	const rememberSelection = (): void => {
		const session = directory.state.value?.sessions.find(session => session.sessionId === desiredSessionId);
		const pinned = session !== undefined && (session.projectId === selectedProjectId || session.archivedAt !== undefined);
		const selection: ProjectSelection = {
			...(selectedProjectId === undefined ? {} : { projectId: selectedProjectId }),
			...(pinned && session !== undefined ? {
				sessionId: session.sessionId,
				...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
			} : {}),
		};
		try { sessionStorage.setItem(selectionKey, JSON.stringify(selection)); }
		catch { /* A restricted webview may not provide session storage. */ }
		if (booted && directoryReady && client.connected) void projects.remember(selection, BACKGROUND_CONTEXT).catch(report);
	};
	/** The dock: whether it is open, and which tab it shows. Both belong to this page. */
	let dockOpen = false;
	let dockTab = "files";
	/** The stored history the reader paged in, oldest first, above the transcript. */
	let history: readonly EntryRecord[] = [];
	let historyCursor: string | null = null;
	let historyLoading = false;
	let historyRequest = 0;
	/** Whether the reader has paged in history; later availability comes from its cursor. */
	let historyLoaded = false;
	const historyAvailability = new HistoryAvailability(
		() => paint(),
		(error) => renderer.setConnection(copy("page.panelFailed", { error: message(error) }), "error"),
	);
	/** The session's root conversation, once the conversation list has published it. */
	let rootConversationId = "";
	let desiredSessionId: string | undefined;
	const sessionReady = (): boolean => directoryReady && client.connected && painter.ready
		&& painter.sessionId === desiredSessionId && client.attachment?.sessionId === desiredSessionId;
	/** A read-only display cache while connection-bound services are released and rebound. */
	let reconnectTranscript:
		| Pick<WebView, "blocks" | "history" | "transcriptScope" | "sessionLabel" | "focus" | "lane" | "model">
		| undefined;
	/** Earlier user entries of the focused conversation, so the dock can leave back to one. */
	let returnPoints: readonly { readonly id: string; readonly label: string }[] = [];
	let returnPointsKey = "";
	let returnPointsRequest = 0;
	/** The composer's draft, mirrored here so the command palette can be projected from it. */
	let draft = "";
	const suggestions = new PromptSuggestionController(() => paint());
	const sessionDrafts = new Map<string, { readonly text: string; readonly images: readonly PendingImage[] }>();
	let draftSessionId: string | undefined;
	const saveDraft = (): void => {
		if (draftSessionId !== undefined) sessionDrafts.set(draftSessionId, { text: draft, images: pending });
	};
	const restoreDraft = (sessionId: string, focus = true): void => {
		const saved = sessionDrafts.get(sessionId);
		draftSessionId = sessionId;
		pending = saved?.images ?? [];
		completions = [];
		completionSequence += 1;
		renderer.setDraft(saved?.text ?? "", focus);
	};
	/** The host's argument completions for the command line being typed. */
	let completions: readonly {
		readonly value: string;
		readonly label: string;
		readonly description?: string;
	}[] = [];
	let paletteSelection = 0;
	/** The completion request in flight, so a stale answer never lands on a newer draft. */
	let completionSequence = 0;

	/**
	 * Paint, and never let a paint escape: a binding that a transition replaced is a line the reader
	 * can see, where an exception out of a subscription callback would be invisible and fatal.
	 */
	const paintSafely = (render: () => void): void => {
		try {
			render();
		} catch (error) {
			renderer.setConnection(copy("page.paintFailed", { error: message(error) }), "error");
		}
	};

	/** The composer offers work actions; model, account and session management use click controls. */
	const composerCommands = (): readonly CommandLike[] => painter.sessionId === desiredSessionId && painter.ready
		? painter.commands.filter(command => command.source !== "builtin" && (command.source !== "skill" || settingValue("enableSkillCommands") !== "false")) : [];

	/** The session's root conversation id, as the host's conversation list reports it. */
	const rootId = (): string | undefined => painter.conversations?.conversations.find((entry) => entry.root)?.id;

	/** Whether the page is showing a conversation other than the root. */
	const focusing = (): boolean => {
		const conversations = painter.conversations;
		const root = rootId();
		return conversations !== undefined && root !== undefined && conversations.selected !== root;
	};

	/** The conversation the page shows: the root's live transcript, or a focused one's view. */
	const shownTranscript = (): ConversationView | undefined => {
		if (painter.sessionId !== desiredSessionId) return undefined;
		if (!focusing()) return painter.transcriptValue;
		return painter.conversations?.view ?? undefined;
	};

	/** The focused conversation's label, when it is not the root. */
	const focusedLabel = (): string | undefined => {
		const conversations = painter.conversations;
		if (conversations === undefined || !focusing()) return undefined;
		return conversations.conversations.find((entry) => entry.id === conversations.selected)?.label;
	};

	/** The catalogue's value for one field, once the host has published it. */
	const effectiveSettings = () => {
		if (desiredSessionId === undefined) return settings.state.value;
		if (painter.sessionId !== desiredSessionId || painter.settingsValue === undefined) return undefined;
		// Project diagnostics belong to the attached worker's directory, not the host's startup directory.
		const globalErrors = settings.state.value?.errors.filter(error => error.scope === "global") ?? [];
		if (globalErrors.length === 0) return painter.settingsValue;
		const errorKey = (error: SettingsState["errors"][number]) => JSON.stringify([error.scope, error.path, error.message]);
		const seen = new Set(painter.settingsValue.errors.map(errorKey));
		return {
			...painter.settingsValue,
			errors: [...globalErrors.filter(error => !seen.has(errorKey(error))), ...painter.settingsValue.errors],
		};
	};
	const settingValue = (id: string): string | undefined =>
		effectiveSettings()?.descriptors.find((descriptor) => descriptor.id === id)?.value;

	/**
	 * The host read the session's command resources when it attached. A skill written, removed, or
	 * imported in the panel, or the skill-command switch, must reach the palette without a worker
	 * restart, so the host re-reads them whenever those inputs move. Reload session resources also
	 * picks up skill files, enables newly saved tools, and reconnects MCP.
	 */
	const catalogInputs = (): string => `${skills.state.value?.revision ?? 0}:${settingValue("enableSkillCommands") ?? ""}`;
	let catalogRead = catalogInputs();
	const refreshCommandResources = (): void => {
		const inputs = catalogInputs();
		if (inputs === catalogRead) return;
		catalogRead = inputs;
		void painter.refreshCommands().catch(() => {});
	};

	/**
	 * A switch made in the panel reaches this page through the replicated settings: the resolved
	 * language and palette follow the host's value, so both tabs agree without a reload.
	 */
	const paint = (): void => {
		const bound = sessionReady();
		const transcript = shownTranscript();
		const service = bound && !historyLoaded && !historyLoading ? painter.conversationsService : undefined;
		const conversationId = painter.conversations?.selected;
		const before = oldestPresentedEntryId(transcript?.entries);
		const historyAvailable = historyAvailability.update(
			service === undefined || painter.sessionId === undefined || conversationId === undefined || before === null
				? undefined
				: { service, sessionId: painter.sessionId, conversationId, before, revision: historyRequest },
		);
		// The root id comes from the host's list; the cache keeps submit routing stable across paints.
		if (bound) rootConversationId = rootId() ?? rootConversationId;
		locale = resolveLocale(settingValue("locale") ?? locale, navigator.languages);
		appearance = resolveThemePreference(settingValue("appearance") ?? appearance);
		const globalSettings = settings.state.value;
		if (globalSettings !== undefined) {
			const values = { ...typography };
			for (const field of FONT_FAMILY_FIELDS) {
				const value = globalSettings.descriptors.find(descriptor => descriptor.id === field)?.value;
				if (value !== undefined) values[field] = value;
			}
			for (const field of FONT_SIZE_FIELDS) {
				const value = globalSettings.descriptors.find(descriptor => descriptor.id === field)?.value;
				if (value !== undefined) values[field] = Number(value);
			}
			typography = resolveTypography(values);
		}
		painter.locale = locale;
		applyTheme(appearance);
		document.documentElement.lang = documentLanguage(locale);
		refreshCommandResources();
		if (panelCurrent && !panelCurrent()) {
			panelCurrent = undefined;
			panelPending = undefined;
			modalPending = false;
			modalNotice = undefined;
		}
		if (forkModalOwner && (!client.connected || painter.conversationsService !== forkModalOwner.service
			|| painter.sessionId !== forkModalOwner.sessionId || desiredSessionId !== forkModalOwner.sessionId
			|| modal === undefined || ![CONVERSATION_RENAME_MODAL, CONVERSATION_ARCHIVE_MODAL].includes(modal.id)
			|| (modal.id === CONVERSATION_RENAME_MODAL && (painter.conversations?.conversations.find(item => item.id === forkModalOwner?.conversationId)?.archivedAt !== undefined
				|| directory.state.value?.sessions.find(item => item.sessionId === forkModalOwner?.sessionId)?.archivedAt !== undefined)))) {
			forkModalOwner = undefined;
			if (modal && [CONVERSATION_RENAME_MODAL, CONVERSATION_ARCHIVE_MODAL].includes(modal.id)) modal = undefined;
			modalPending = false;
			modalNotice = undefined;
			panelPending = undefined;
		}
		if (mcpView && (!client.connected || painter.mcpService !== mcpView.service || painter.sessionId !== mcpView.sessionId || desiredSessionId !== mcpView.sessionId)) {
			mcpView = undefined;
			modal = undefined;
			modalPending = false;
			modalNotice = undefined;
			panelPending = undefined;
		}
		if (modelScopeView && (!client.connected || painter.modelsService !== modelScopeView.service || painter.sessionId !== modelScopeView.sessionId || desiredSessionId !== modelScopeView.sessionId)) {
			modelScopeView = undefined;
			modal = undefined;
			modalPending = false;
			modalNotice = undefined;
			panelPending = undefined;
		}
		if (providerAuthView !== undefined) {
			const owner = providerAuthView;
			const state = painter.modelsValue?.authentication;
			if (!client.connected || painter.modelsService !== owner.service || painter.sessionId !== owner.sessionId || desiredSessionId !== owner.sessionId || !state) {
				providerAuthView = undefined;
				modal = undefined;
				modalPending = false;
				modalNotice = undefined;
			} else {
				const login = state.login?.id === owner.loginId ? state.login : null;
				const expired = !login && owner.matched;
				if (login) owner.matched = true;
				else if (expired) {
					owner.loginId = undefined;
					owner.matched = false;
				}
				const next = owner.starting || owner.loginId !== undefined ? providerLoginModal(locale, state, login)
					: providerAuthModal(locale, state);
				if (modal?.data !== next.data) modalNotice = undefined;
				if (expired) modalNotice = { tone: "error", text: copy("auth.expired") };
				modal = next;
			}
		}
		const now = Date.now();
		const retentionDays = Number(effectiveSettings()?.descriptors.find(descriptor => descriptor.id === "archiveRetentionDays")?.value ?? 0);
		const built = buildWebView({
					locale,
					typography,
					desktop: typeof window !== "undefined" && window.amazmeDesktop !== undefined,
					creatingSession: creating,
					selectedProjectId,
					directory: directoryReady ? directory.state.value : undefined,
					transcript,
					focus: bound ? focusedLabel() : undefined,
					...(!bound || painter.conversations?.lane === undefined ? {} : { lane: painter.conversations.lane }),
					history: bound ? history : [],
					historyMore: bound && (historyLoaded ? historyCursor !== null : historyAvailable),
					historyLoading: bound && historyLoading,
					attachedId: bound ? painter.sessionId : undefined,
					now,
					models: bound ? painter.modelsValue : undefined,
					thinkingLevels: bound ? painter.levels : undefined,
					modelPending: modelSelection !== undefined && modelSelection.binding === painter.binding,
					submitMode,
					attachments: bound ? pending : [],
					approvals: bound ? painter.approvals : undefined,
					feedback: feedback.state.value,
					// Durable entry ids are per conversation, so the ratings are scoped to the one shown.
					feedbackScope: {
						sessionId: painter.sessionId ?? "",
						conversationId: painter.conversations?.selected ?? rootConversationId,
					},
					showWelcome: settingValue("showWelcome") !== "false",
					rosterFilter,
					draft,
					commands: composerCommands(),
					completions,
					paletteSelection,
					platform: navigator.platform,
					dock: {
						open: dockOpen,
						tab: dockTab,
						cwd: bound ? directory.state.value?.sessions.find(session => session.sessionId === desiredSessionId)?.cwd ?? painter.workspace?.cwd ?? "" : "",
						workspace: bound ? painter.workspace : undefined,
						terminal: bound ? painter.terminal : undefined,
						conversations: bound ? painter.conversations : undefined,
						...(panelPending === undefined ? {} : { pending: panelPending }),
						...(panelNoticeDock !== dockTab || panelNotice === undefined ? {} : { notice: panelNotice }),
						...(bound && painter.insights ? { insights: painter.insights, reviewDiff: painter.reviewDiff } : {}),
					},
					// The panel inherits this view's language, so one resolution serves the whole page.
					panel: {
						locale,
						current: view,
						availableViews: availableViews(),
						...(modal === undefined ? {} : { modal: modal.id === DIAGNOSTICS_MODAL ? {
							...modal, title: copy("panel.settings.diagnostics"), description: copy("panel.settings.diagnosticsHelp"), submit: copy("modal.close"),
							fields: [{ id: "report", label: copy("panel.settings.diagnostics"), kind: "textarea" as const, readOnly: true, value: diagnosticReport === undefined ? copy(modalNotice?.tone === "error" ? "panel.settings.diagnosticsFailed" : "panel.settings.diagnosticsLoading") : formatDiagnosticReport(diagnosticReport, locale) }],
						} : modal }),
						settings: {
							...(directoryReady ? { archives: {
								sessions: directory.state.value?.sessions ?? [],
								projects: directory.state.value?.projects ?? [],
								retentionDays: Number.isFinite(retentionDays) ? retentionDays : 0,
								now,
							} } : {}),
							state: desiredSessionId === undefined || bound ? effectiveSettings() : undefined, models: {
							available: client.connected && painter.ready && painter.sessionId === desiredSessionId && painter.modelsService !== undefined,
							authentication: bound && Boolean(painter.modelsValue?.authentication),
							selected: bound && Boolean(painter.modelsValue?.configuration.model),
							picker: { ...modelPicker(locale, bound ? painter.modelsValue : undefined, bound ? painter.levels : undefined, bound), disabled: !bound || modelSelection?.binding === painter.binding },
						} },
						skills: { state: skills.state.value },
						plugins: { state: plugins.state.value, runtime: desiredSessionId === undefined ? undefined
							: client.connected && painter.sessionId === desiredSessionId ? (painter.mcpValue ?? null) : null },
						...(schedules === undefined ? {} : { automation: {
							state: schedules.state.value,
							sessionId: bound ? painter.sessionId : undefined,
							now: Date.now(),
						} }),
						// The page's own management state: what is in flight, and what it last said.
						...(panelPending === undefined ? {} : { pending: panelPending }),
						...(panelNotice === undefined
							|| (view === AUTOMATION_VIEW && schedules?.state.value?.problem)
							|| (view === SETTINGS_VIEW && effectiveSettings()?.errors.some(error => panelNotice?.text.includes(error.message)))
							? {}
							: { notice: panelNotice }),
						modalPending,
						...(modalNotice === undefined ? {} : { modalNotice }),
					},
				});
		const source = promptSuggestionContext(transcript);
		const suggestionService = painter.modelsService;
		const suggestionKey = bound && source ? JSON.stringify([painter.sessionId, source.conversationId, source.answerEntryId, locale, painter.modelsValue?.configuration.model]) : undefined;
		suggestions.update(suggestionKey, bound && settingValue("promptSuggestions") !== "false" && view === CHAT_VIEW &&
			!modal && !built.readOnly && !built.busy && !built.modelPending && draft.length === 0 &&
			pending.length === 0 && built.approvals.length === 0 && built.queue.length === 0,
			signal => source && suggestionService ? suggestionService.suggestPrompt({
				conversationId: source.conversationId, answerEntryId: source.answerEntryId, locale,
			}, withAbortSignal(signal, BACKGROUND_CONTEXT)) : Promise.resolve(null));
		const displayed = reconnectTranscript === undefined ? built : { ...built, ...reconnectTranscript, status: "", busy: false };
		paintSafely(() => renderer.render(withReturnPoints(
			{
				...displayed,
				suggestion: suggestions.valueFor(suggestionKey),
				mirrorWarning: bound ? painter.mirrorWarning : undefined,
				newSession: { ...displayed.newSession, enabled: client.connected && displayed.newSession.enabled },
			},
			bound ? returnPoints : [],
			bound && painter.conversations?.branchSummarySkipPrompt === true,
		)));
		refreshReturnPoints();
	};

	const refreshReturnPoints = (): void => {
		const selected = painter.conversations?.selected;
		const service = painter.conversationsService;
		if (selected === undefined || service === undefined) {
			returnPoints = [];
			returnPointsKey = "";
			return;
		}
		const key = `${selected}:${painter.conversations?.revision ?? 0}`;
		if (key === returnPointsKey) return;
		returnPointsKey = key;
		const request = ++returnPointsRequest;
		void service.returnPoints(selected, BACKGROUND_CONTEXT).then(
			(points) => {
				if (request !== returnPointsRequest) return;
				const same = points.length === returnPoints.length && points.every((point, index) => point.id === returnPoints[index]?.id && point.label === returnPoints[index]?.label);
				returnPoints = points;
				if (!same) paint();
			},
			() => {
				if (request !== returnPointsRequest) return;
				returnPoints = [];
			},
		);
	};
	let observedDirectory = directory.state.value;
	directory.state.subscribe((state, _context, delivery) => {
		if (!client.connected) return;
		const reconnectHydrate = booted && delivery.kind === "hydrate" && !directoryReady;
		if (delivery.kind === "hydrate") {
			directoryReady = true;
			renderer.setConnectionState(
				(language) => translate(language, "connection.connected"),
				"connected",
			);
		}
		const previous = observedDirectory?.sessions.find(session => session.sessionId === desiredSessionId);
		const current = state.sessions.find(session => session.sessionId === desiredSessionId);
		const previousProject = observedDirectory?.projects?.find(project => project.id === current?.projectId);
		const currentProject = state.projects?.find(project => project.id === current?.projectId);
		const foldersSaved = state.projects?.some(project => project.revision !== observedDirectory?.projects?.find(previous => previous.id === project.id)?.revision);
		observedDirectory = state;
		if (booted && desiredSessionId !== undefined) {
			if ((previous !== undefined && current === undefined)
				|| (reconnectHydrate && current?.archivedAt !== undefined && previous?.archivedAt !== current.archivedAt)) {
				void clearSession().catch(report);
			} else if (current?.archivedAt !== undefined && previous !== undefined && previous.archivedAt === undefined) {
				allowArchivedAttach = true;
				rememberSelection();
			} else if (current !== undefined && previous?.archivedAt !== undefined && current.archivedAt === undefined) {
				allowArchivedAttach = false;
				rosterFilter = "";
				selectedProjectId = current.projectId;
				reconnectTranscript = undefined;
				rememberSelection();
			}
		}
		const available = state.projects?.filter(project => !project.removed) ?? [];
		if (booted && delivery.kind !== "hydrate" && sessionReady() && current !== undefined) {
			if (previousProject && currentProject && (previousProject.removed !== currentProject.removed
				|| JSON.stringify(previousProject.workspaces ?? [previousProject.cwd]) !== JSON.stringify(currentProject.workspaces ?? [currentProject.cwd]))) {
				const service = painter.conversationsService;
				void painter.workspaceOpen(".").catch(error => {
					if (sessionReady() && painter.conversationsService === service && painter.sessionId === current.sessionId) report(error);
				});
			}
			// Trust is stored by path, so a saved folder can also affect sessions in another project.
			if (foldersSaved) {
				const settings = painter.settingsService;
				const mcp = painter.mcpService;
				void settings?.reload(BACKGROUND_CONTEXT).then(async () => {
					if (client.connected && painter.settingsService === settings && desiredSessionId === current.sessionId) await mcp?.reload(BACKGROUND_CONTEXT);
				}).catch(error => {
					if (sessionReady() && painter.settingsService === settings && desiredSessionId === current.sessionId) report(error);
				});
			}
		}
		if (!available.some(project => project.id === selectedProjectId)) {
			selectedProjectId = available.find(project => project.id === state.defaultProjectId)?.id ?? available[0]?.id;
			if (booted) { selectionRevision += 1; rememberSelection(); }
		}
		paint();
	});
	// A rating given here, or by another tab, repaints the transcript's controls.
	feedback.state.subscribe(() => paint());
	settings.state.subscribe(() => {
		paint();
		const service = painter.settingsService;
		if (service && sessionReady()) void service.reload(BACKGROUND_CONTEXT).catch(() => undefined);
	});
	skills.state.subscribe(() => paint());
	// The catalogue itself moves when the host re-reads the session's templates and skills.
	painter.commandsState?.subscribe(() => paint());
	plugins.state.subscribe(() => {
		paint();
		const service = painter.mcpService;
		if (service && sessionReady()) void service.reload(BACKGROUND_CONTEXT).catch(() => undefined);
	});
	const clearSchedules = async (): Promise<number> => {
		const epoch = ++scheduleEpoch;
		const previous = scheduleServices;
		scheduleServices = undefined;
		schedules = undefined;
		removeScheduleObserver?.();
		removeScheduleObserver = undefined;
		if (view === AUTOMATION_VIEW) { view = CHAT_VIEW; modal = undefined; }
		await previous?.dispose(BACKGROUND_CONTEXT);
		return epoch;
	};
	const discoverSchedules = async (): Promise<void> => {
		const epoch = await clearSchedules();
		if (epoch !== scheduleEpoch || !client.connected || leaving) return;
		const catalogue = await serverSource.catalogue(BACKGROUND_CONTEXT);
		if (epoch !== scheduleEpoch || !client.connected || leaving) return;
		if (catalogue.some(entry => entry.serviceId === Schedules.name)) {
			const binding = serverSource.open({ services: [Schedules], assertAccess() {}, onError: report });
			scheduleServices = binding;
			try { await binding.ready(BACKGROUND_CONTEXT); }
			catch (error) {
				if (epoch !== scheduleEpoch) { await binding.dispose(BACKGROUND_CONTEXT); return; }
				await clearSchedules(); throw error;
			}
			if (epoch !== scheduleEpoch || leaving || !client.connected) { await binding.dispose(BACKGROUND_CONTEXT); return; }
			schedules = binding.get(Schedules);
			removeScheduleObserver = schedules.state.subscribe(() => paint());
		}
		paint();
	};

	/**
	 * Attach another session. The painter lets go of the previous one first: the host has already
	 * moved this connection's attachment by the time the new services bind, so a send in that window
	 * would reach a session this client no longer has. The composer is inert until the new one lands.
	 * Transitions are queued, so a click during the page's own first bind waits its turn instead of
	 * disposing the bindings that bind is using.
	 */
	const transition = sessionTransitions();
	const clearSession = async (): Promise<void> => {
		selectionRevision += 1;
		allowArchivedAttach = false;
		desiredSessionId = undefined;
		reconnectTranscript = undefined;
		rememberSelection();
		saveDraft();
		await transition(async () => {
			if (desiredSessionId !== undefined) return;
			await painter.detach();
			if (client.connected && client.attachment !== undefined) await management.detach(BACKGROUND_CONTEXT);
			draftSessionId = undefined;
			pending = [];
			completions = [];
			completionSequence += 1;
			history = [];
			historyRequest += 1;
			historyLoading = false;
			historyCursor = null;
			historyLoaded = false;
			rootConversationId = "";
			returnPoints = [];
			returnPointsKey = "";
			returnPointsRequest += 1;
			reconnectTranscript = undefined;
			renderer.setDraft("", false);
			paint();
		});
	};
	const canResumeSession = (sessionId: string): boolean => {
		const state = directory.state.value;
		const session = state?.sessions.find(session => session.sessionId === sessionId);
		const project = state?.projects?.find(project => project.id === session?.projectId);
		return directoryReady && session !== undefined
			&& (!project?.removed || (allowArchivedAttach && session.archivedAt !== undefined))
			&& (session.archivedAt === undefined || allowArchivedAttach);
	};
	const selectSession = (sessionId: string, resume = false): Promise<void> => {
		if (!resume) {
			selectionRevision += 1;
			const summary = directory.state.value?.sessions.find(session => session.sessionId === sessionId);
			if (summary?.archivedAt === undefined) allowArchivedAttach = false;
			if (summary?.projectId !== undefined) selectedProjectId = summary.projectId;
			desiredSessionId = sessionId;
			rememberSelection();
			reconnectTranscript = undefined;
		}
		return transition(async () => {
			if (desiredSessionId !== sessionId) return;
			if (!resume && painter.sessionId === sessionId && painter.ready) {
				paint();
				return;
			}
			saveDraft();
			panelNotice = undefined;
			modalNotice = undefined;
			historyRequest += 1;
			await painter.detach();
			if (!resume) {
				history = [];
				historyCursor = null;
				historyLoaded = false;
			}
			historyLoading = false;
			rootConversationId = "";
			returnPoints = [];
			returnPointsKey = "";
			returnPointsRequest += 1;
			paint();
			if (!client.connected) return;
			await retryOnRebind(async () => {
				if (!client.connected || !directoryReady || desiredSessionId !== sessionId
					|| (resume && !canResumeSession(sessionId))) return;
				await management.attach(sessionId, BACKGROUND_CONTEXT);
				await sessionSource.whenAttached(sessionId, BACKGROUND_CONTEXT);
				if (!client.connected || desiredSessionId !== sessionId || !canResumeSession(sessionId)) return;
				await painter.attach(sessionId, paint);
			});
			if (desiredSessionId !== sessionId || client.attachment?.sessionId !== sessionId || !painter.ready) return;
			reconnectTranscript = undefined;
			restoreDraft(sessionId, !resume);
			paint();
		});
	};
	renderer.onSelect = (sessionId) => {
		view = CHAT_VIEW;
		providerAuthView = undefined;
		modal = undefined;
		void selectSession(sessionId).catch((error: unknown) => {
			renderer.setConnection(
				(language) => translate(language, "page.attachFailed", { error: message(error) }),
				"error",
				(language) => translate(language, "page.attachFailedShort"),
			);
		});
	};
	// The host creates the session; the roster shows it from the replicated directory. A second
	// click while the first create is in flight would make a second session, so this one is one-shot.
	/** Create a session and attach it. The project row and the shortcut share this path. */
	const createSession = (): void => {
		if (creating || !client.connected || !directoryReady) return;
		const known = directory.state.value?.projects;
		if (known !== undefined && !known.some(project => project.id === selectedProjectId && !project.removed)) {
			selectedProjectId = known.find(project => !project.removed)?.id;
		}
		if (known !== undefined && selectedProjectId === undefined) { modal = addProjectModal(locale); paint(); return; }
		const projectId = selectedProjectId;
		desiredSessionId = undefined;
		const selection = ++selectionRevision;
		allowArchivedAttach = false;
		rememberSelection();
		creating = true;
		paint();
		void management.create({ reuseEmpty: true, ...(projectId === undefined ? {} : { projectId }) }, BACKGROUND_CONTEXT)
			.then(async (created) => {
				if (selectionRevision !== selection) return;
				await selectSession(created.sessionId);
				view = CHAT_VIEW;
				modal = undefined;
			})
			.catch((error: unknown) => {
				renderer.setConnection(copy("page.newSessionFailed", { error: message(error) }), "error");
			})
			.finally(() => {
				creating = false;
				paint();
			});
	};
	renderer.onCreateSession = createSession;
	renderer.onBrowseDirectories = async path => {
		if (!client.connected) throw new Error(copy("connection.hostGone"));
		await serverServices.ready(BACKGROUND_CONTEXT);
		return projects.folders(path === undefined ? {} : { path }, BACKGROUND_CONTEXT);
	};
	renderer.onPickDirectories = async () => window.amazmeDesktop?.pickDirectories();
	renderer.onShortcut = (id: ShortcutId) => {
		if (id === "font.increase" || id === "font.decrease" || id === "font.reset") {
			if (!client.connected || window.amazmeDesktop === undefined) return;
			const action = id === "font.increase" ? "increase" : id === "font.decrease" ? "decrease" : "reset";
			void settings.adjustFontSizes(action, BACKGROUND_CONTEXT).catch((error: unknown) => {
				renderer.setConnection(copy("page.fontChangeFailed", { error: message(error) }), "error");
			});
			return;
		}
		if (id === "session.new") {
			createSession();
			return;
		}
		if (id === "composer.focus") {
			view = CHAT_VIEW;
			closeModal();
			document.getElementById("prompt")?.focus();
			return;
		}
		// Cycle the main area through the conversation and every management view.
		const views = [CHAT_VIEW, ...panelNav(locale, CHAT_VIEW, availableViews()).map((item) => item.id)];
		const index = views.indexOf(view);
		view = views[(index + 1) % views.length] ?? CHAT_VIEW;
		providerAuthView = undefined;
		modal = undefined;
		paint();
	};
	/** A single in-flight selection prevents reasoning from racing a model switch. */
	const selectModelSetting = (apply: () => Promise<void>, errorKey: "page.modelChangeFailed" | "page.thinkingFailed"): void => {
		if (!client.connected || !painter.ready || painter.sessionId !== desiredSessionId || modelSelection?.binding === painter.binding) return;
		const binding = painter.binding;
		const operation = { binding };
		modelSelection = operation;
		paint();
		void apply().catch((error: unknown) => {
			if (painter.binding !== binding || painter.sessionId !== desiredSessionId) return;
			renderer.setConnection(copy(errorKey, { error: message(error) }), "error");
		}).finally(() => {
			if (modelSelection !== operation) return;
			modelSelection = undefined;
			paint();
		});
	};
	renderer.onSelectModel = (provider, modelId) => selectModelSetting(() => painter.selectModel(provider, modelId), "page.modelChangeFailed");
	renderer.onSelectThinking = (level) => selectModelSetting(() => painter.selectThinking(level), "page.thinkingFailed");
	/**
	 * Add picked, pasted, or dropped images. An image the page cannot send is refused with the
	 * reason instead of being dropped silently, and the rest of the batch still arrives.
	 */
	/**
	 * Follow a work-action draft and ask the host for argument completions. Answers are sequenced so a slow one cannot land on a newer draft.
	 */
	renderer.onDismissSuggestion = () => suggestions.dismiss();
	renderer.onDraftChange = (text) => {
		draft = text;
		saveDraft();
		paletteSelection = 0;
		const line = parseCommandLine(text);
		const sequence = ++completionSequence;
		if (line === undefined || !text.includes(" ") || !composerCommands().some((command) => command.name === line.name)) {
			completions = [];
			paint();
			return;
		}
		void painter.complete(line.name, line.args).then(
			(answered) => {
				if (sequence !== completionSequence) return;
				completions = answered;
				paint();
			},
			() => {
				if (sequence !== completionSequence) return;
				completions = [];
				paint();
			},
		);
	};
	renderer.onPaletteSelection = (index) => {
		paletteSelection = index;
		paint();
	};
	renderer.onCommandPick = (value) => {
		const line = parseCommandLine(draft);
		// A name pick leaves a space for the argument; an argument pick replaces the rest of the line.
		if (line === undefined || !draft.includes(" ")) {
			renderer.setDraft(`/${value} `);
			return;
		}
		renderer.setDraft(`/${line.name} ${value}`);
	};
	renderer.onFilterRoster = (text) => {
		rosterFilter = text;
		paint();
	};
	renderer.onAttachFiles = (files) => {
		const sessionId = draftSessionId;
		void (async () => {
			const added: PendingImage[] = [];
			for (const file of files) {
				const rejection = attachmentRejection({
					mediaType: file.type,
					bytes: file.size,
				});
				if (rejection !== undefined) {
					renderer.setConnection(
						copy(rejection, {
							name: file.name,
							limit: copy("composer.attachmentLimit"),
						}),
						"error",
					);
					continue;
				}
				try {
					const dataUrl = await readAsDataUrl(file);
					added.push({
						id: `image-${++attachmentSequence}`,
						name: file.name.length === 0 ? "image" : file.name,
						mediaType: file.type,
						bytes: file.size,
						dataUrl,
						data: dataUrl.slice(dataUrl.indexOf(",") + 1),
					});
				} catch {
					renderer.setConnection(copy("page.attachmentFailed", { name: file.name }), "error");
				}
			}
			if (added.length === 0) return;
			if (sessionId !== draftSessionId) {
				if (sessionId !== undefined) {
					const saved = sessionDrafts.get(sessionId);
					sessionDrafts.set(sessionId, { text: saved?.text ?? "", images: [...(saved?.images ?? []), ...added] });
				}
				return;
			}
			pending = [...pending, ...added];
			saveDraft();
			paint();
		})();
	};
	/**
	 * Run one command line. A resource command — a prompt template or a skill — is expanded by the
	 * host and sent on this page's own prompt path, so the focused conversation and the submit mode
	 * still apply; the host's own commands run on the host, and their note or problem reaches the
	 * connection line.
	 */
	const runCommandLine = (name: string, args: string): void => {
		if (name === "changes" && painter.insightsService) { view = CHAT_VIEW; dockOpen = true; dockTab = "changes"; paint(); return; }
		if (name === "limits" || name === "execution") { view = SETTINGS_VIEW; paint(); return; }
		if (name === "resume-run" && painter.insightsService && painter.insights) { void painter.insightsService.resume(painter.insights.conversationId, BACKGROUND_CONTEXT).catch(report); return; }
		const command = composerCommands().find((candidate) => candidate.name === name);
		if (!command) {
			const key: MessageKey = ["model", "thinking", "scoped_models", "login", "logout"].includes(name) ? "model.commandInstead"
				: ["name", "tree", "agents", "fork", "older"].includes(name) ? "page.sessionCommandInstead"
				: name === "tasks" ? "page.tasksCommandInstead" : ["mcp", "plugins"].includes(name) ? "page.pluginsCommandInstead"
				: name === "attachments" ? "page.attachmentsCommandInstead"
				: name === "reload" ? "page.reloadCommandInstead" : name === "compact" ? "page.compactCommandInstead" : "page.commandUnknown";
			renderer.setConnection(copy(key, { name }), "error");
			return;
		}
		if (command?.source === "template" || command?.source === "skill") {
			const target = targetConversation();
			const sessionId = painter.sessionId;
			const owner = painter.commandsState;
			const mode = submitMode;
			void painter.expandCommand(name, args).then(
				(expansion) => {
					if (painter.sessionId !== sessionId || desiredSessionId !== sessionId || painter.commandsState !== owner || targetConversation() !== target) {
						renderer.setConnection(copy("page.commandTargetChanged"), "error");
						return;
					}
					if (!expansion.ok) {
						renderer.setConnection(expansion.message, "error");
						return;
					}
					const focused = target !== undefined && target !== rootConversationId ? target : undefined;
					return painter.submit(expansion.message, mode, [], focused);
				},
				(error: unknown) => {
					renderer.setConnection(copy("page.commandFailed", { error: message(error) }), "error");
				},
			);
			return;
		}
		void painter.runCommand(name, args).then(
			(result) => {
				renderer.setConnection(result.message, result.ok ? "state" : "error");
			},
			(error: unknown) => {
				renderer.setConnection(copy("page.commandFailed", { error: message(error) }), "error");
			},
		);
	};

	/** The conversation the composer talks to: the focused one, or the root. */
	const targetConversation = (): string | undefined => {
		const conversations = painter.conversations;
		if (conversations === undefined) return undefined;
		rootConversationId = rootId() ?? rootConversationId;
		return conversations.selected;
	};

	renderer.onSubmit = (text) => {
		if (!client.connected || !painter.ready || painter.sessionId !== desiredSessionId) {
			renderer.setDraft(text, false);
			return;
		}
		const line = parseCommandLine(text);
		if (line !== undefined) {
			renderer.setDraft("");
			runCommandLine(line.name, line.args);
			return;
		}
		const submittedSession = draftSessionId;
		const sent = pending;
		const images: AgentPromptImage[] = sent.map((image) => ({
			type: "image",
			data: image.data,
			mimeType: image.mediaType,
		}));
		pending = [];
		saveDraft();
		const target = targetConversation();
		const focused = target !== undefined && target !== rootConversationId ? target : undefined;
		// Input goes to the conversation the page shows. A busy fork steers or queues; it does not reject.
		void painter.submit(text, submitMode, images, focused).catch((error: unknown) => {
			// The prompt never reached the session, so the images stay attached for another try.
			if (submittedSession === draftSessionId) {
				pending = [...sent, ...pending];
				renderer.setDraft(draft.length === 0 ? text : `${text}\n${draft}`);
				paint();
			} else if (submittedSession !== undefined) {
				const saved = sessionDrafts.get(submittedSession);
				sessionDrafts.set(submittedSession, { text: saved?.text ? `${text}\n${saved.text}` : text, images: [...sent, ...(saved?.images ?? [])] });
			}
			renderer.setConnection(copy("page.sendFailed", { error: message(error) }), "error");
		});
	};
	renderer.onAbort = () => {
		const target = targetConversation();
		const focused = target !== undefined && target !== rootConversationId ? target : undefined;
		void painter.abort(focused).catch((error: unknown) => {
			renderer.setConnection(copy("page.abortFailed", { error: message(error) }), "error");
		});
	};

	/**
	 * The control that opened the open modal, so closing it hands the focus back: the element is
	 * looked up again by its action, because a repaint replaces the node the click landed on.
	 */
	let modalOpener: { readonly id: string; readonly data?: string } | undefined;
	/** The management call in flight, and what it last said; a repaint carries both to its panel. */
	let panelPending: { readonly id: string; readonly data?: string } | undefined;
	let panelNotice: PanelNotice | undefined;
	let panelNoticeDock: string | undefined;
	let modalPending = false;
	let modalNotice: PanelNotice | undefined;

	const openModal = (spec: PanelModal, opener?: { readonly id: string; readonly data?: string }): void => {
		if (spec.id !== PROVIDER_AUTH_MODAL) providerAuthView = undefined;
		if (spec.id !== MODEL_SCOPE_MODAL) modelScopeView = undefined;
		if (spec.id !== PLUGIN_MCP_PROJECT_MODAL && spec.id !== PLUGIN_MCP_LOGIN_MODAL) mcpView = undefined;
		modal = spec;
		modalOpener = opener;
		modalPending = false;
		modalNotice = undefined;
		panelNotice = undefined;
		paint();
	};

	const closeModal = (): void => {
		if (modalPending) panelPending = undefined;
		providerAuthView = undefined;
		modelScopeView = undefined;
		mcpView = undefined;
		forkModalOwner = undefined;
		diagnosticRequest += 1;
		diagnosticReport = undefined;
		modal = undefined;
		modalPending = false;
		modalNotice = undefined;
		const opener = modalOpener;
		modalOpener = undefined;
		paint();
		if (opener === undefined) return;
		if (view === CHAT_VIEW && (opener.id === PROVIDER_AUTH_ACTION || opener.id === MODEL_SCOPE_ACTION)) {
			const prompt = document.getElementById("prompt");
			if (prompt instanceof HTMLElement && !prompt.hasAttribute("disabled")) prompt.focus();
			return;
		}
		if (opener.id === CONVERSATION_RENAME_ACTION || opener.id === CONVERSATION_ARCHIVE_ACTION) {
			const controls = [...document.querySelectorAll<HTMLButtonElement>("#dock-body .panel-more, #dock-body [data-action]")];
			controls.find(node => node.dataset.actionData === opener.data && (node.classList.contains("panel-more") || node.dataset.action === CONVERSATION_RESTORE_ACTION))?.focus();
			return;
		}
		if (opener.id === SESSION_RENAME_ACTION || opener.id === SESSION_REMOVE_ACTION) {
			const trigger = [...document.querySelectorAll<HTMLButtonElement>(".session-more")].find((node) => node.dataset.actionData === opener.data);
			trigger?.focus();
			return;
		}
		const attribute = opener.data === undefined ? `[data-action="${opener.id}"]` : `[data-action="${opener.id}"][data-action-data="${opener.data}"]`;
		try {
			const node = document.querySelector(attribute);
			if (node instanceof HTMLElement && node.getClientRects().length > 0) node.focus();
			else if (opener.id === PLUGIN_MCP_PROJECT_ACTION) {
				const row = [...document.querySelectorAll<HTMLElement>("[data-row-id]")].find(control => control.dataset.rowId === `mcp:${opener.data}`);
				row?.querySelector<HTMLElement>("input, select, button")?.focus();
			}
		} catch {
			// A selector the page cannot express leaves the focus where it is.
		}
	};

	/** Report a refused input inside the modal that submitted it, keeping what was typed. */
	const refuseInModal = (text: string): void => {
		modalNotice = { tone: "error", text };
		paint();
	};

	/** What one management call answers: the schedule store's shape, or a plain success. */
	type PanelCallResult = { readonly ok: false; readonly problem: string } | { readonly ok: true; readonly note?: string };
	const scheduleReply = (response: ScheduleResult): PanelCallResult => response.ok
		? { ok: true, note: scheduleActionCopy(locale, response.code) }
		: { ok: false, problem: response.code === undefined ? response.problem : response.code === "timed_out"
			? scheduleActionCopy(locale, response.code) : `${scheduleActionCopy(locale, response.code)}: ${response.problem}` };

	/**
	 * Run one management call: the control that started it reports itself in flight and refuses a
	 * second activation, the surface it changed repaints from the host's state, and a refusal or a
	 * failure lands beside that control instead of only on the header's connection line.
	 */
	let panelCall = 0;
	let panelCurrent: (() => boolean) | undefined;
	const runPanelCall = (request: {
		readonly id: string;
		readonly data?: string;
		readonly inModal?: boolean;
		readonly closeOnSuccess?: boolean;
		readonly sessionId?: string;
		readonly retry?: boolean;
		/** Extra ownership check for an interaction whose modal or binding may have changed. */
		readonly current?: () => boolean;
		readonly call: () => Promise<PanelCallResult | void>;
		readonly afterSuccess?: () => void;
		readonly dock?: string;
	}): void => {
		const invocation = ++panelCall;
		const binding = painter.binding;
		const inModal = request.inModal === true;
		const dialog = inModal && !request.current ? modal : undefined;
		const current = () => invocation === panelCall &&
			(request.sessionId === undefined || (client.connected && request.sessionId === desiredSessionId &&
				request.sessionId === painter.sessionId && binding === painter.binding)) &&
			(dialog === undefined || modal === dialog) && (request.current?.() ?? true);
		if (!current()) return;
		panelCurrent = current;
		panelNoticeDock = request.dock;
		panelPending = request.data === undefined ? { id: request.id } : { id: request.id, data: request.data };
		if (inModal) {
			modalPending = true;
			modalNotice = undefined;
		} else {
			panelNotice = undefined;
		}
		paint();
		void (request.retry === false ? request.call() : retryOnRebind(request.call)).then(
			(result) => {
				if (!current()) return;
				panelCurrent = undefined;
				panelPending = undefined;
				modalPending = false;
				if (result !== undefined && result.ok === false) {
					const notice: PanelNotice = { tone: "error", text: result.problem };
					if (inModal) modalNotice = notice;
					else panelNotice = notice;
					paint();
					return;
				}
				if (inModal && request.closeOnSuccess !== false) {
					closeModal();
					return;
				}
				if (result !== undefined && result.ok && result.note !== undefined) {
					const notice: PanelNotice = { tone: "info", text: result.note };
					if (inModal) modalNotice = notice;
					else panelNotice = notice;
				}
				paint();
				request.afterSuccess?.();
			},
			(error: unknown) => {
				if (!current()) return;
				panelCurrent = undefined;
				panelPending = undefined;
				modalPending = false;
				const notice: PanelNotice = { tone: "error", text: message(error) };
				if (inModal) modalNotice = notice;
				else panelNotice = notice;
				paint();
			},
		);
	};

	/** The call answers nothing but its own completion. */
	const done = (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true });
	const openProviderAuthentication = (): void => {
		const service = painter.modelsService;
		const sessionId = painter.sessionId;
		const state = painter.modelsValue?.authentication;
		if (!service || !sessionId || !state || !client.connected || desiredSessionId !== sessionId) return;
		const login = state.login && ["preparing", "awaiting", "finishing"].includes(state.login.status) ? state.login : null;
		providerAuthView = { service, sessionId, ...(login ? { loginId: login.id } : {}) };
		openModal(providerAuthModal(locale, state), { id: PROVIDER_AUTH_ACTION });
	};
	/** Authentication calls never retry onto a replacement binding, and never echo provider errors. */
	const runProviderAuthCall = (owner: NonNullable<typeof providerAuthView>, call: () => Promise<PanelCallResult>): void => {
		const current = () => providerAuthView === owner && painter.modelsService === owner.service &&
			painter.sessionId === owner.sessionId && desiredSessionId === owner.sessionId && client.connected;
		runPanelCall({ id: PROVIDER_AUTH_MODAL, inModal: true, closeOnSuccess: false, sessionId: owner.sessionId, retry: false, current,
			call: async () => {
				if (!current()) return { ok: false, problem: copy("auth.expired") };
				try { return await call(); }
				catch { owner.starting = false; return { ok: false, problem: copy("auth.failed") }; }
			},
		});
	};

	/**
	 * Run one host call that has no control of its own — the dock's surfaces, the transcript's
	 * ratings, the header's model refresh — reporting a failure on the connection line. A panel row
	 * action or a modal submit goes through `runPanelCall` instead, so its own control answers.
	 */
	const leaveAt = (at: string, summarize: boolean, customInstructions: string | null): void => {
		const service = painter.conversationsService;
		const id = painter.conversations?.selected;
		if (service === undefined || id === undefined || at.length === 0) return;
		history = [];
		historyRequest += 1;
		historyLoading = false;
		historyCursor = null;
		historyLoaded = false;
		dockOpen = true;
		dockTab = "conversations";
		settle(
			service.leave(id, at, { summarize, customInstructions }, BACKGROUND_CONTEXT).then((result) => {
				if (result.error !== null) throw new Error(result.error.message);
				if (result.cancelled && sessionReady() && painter.conversationsService === service) renderer.setConnection("Branch summarization cancelled", "state");
			}),
		);
	};

	const settle = (operation: Promise<unknown> | undefined): void => {
		if (operation === undefined) return;
		const sessionId = painter.sessionId;
		const service = painter.conversationsService;
		void operation.then(
			() => paint(),
			(error: unknown) => {
				if (!sessionReady() || painter.sessionId !== sessionId || painter.conversationsService !== service) return;
				renderer.setConnection(copy("page.panelFailed", { error: message(error) }), "error");
				paint();
			},
		);
	};

	const pluginPackages = (): readonly string[] => plugins.state.value?.packages ?? [];
	const skillOf = (name: string): { readonly editable: boolean } | undefined => skills.state.value?.skills.find((candidate) => candidate.name === name);

	const runWorkspaceCall = (id: string, data: string | undefined, operation: () => Promise<void>): void => {
		const service = painter.workspaceService;
		const sessionId = painter.sessionId;
		if (!service || !sessionId || !sessionReady() || panelPending?.id.startsWith("workspace:")) return;
		const focused = document.activeElement;
		const restore = focused instanceof HTMLButtonElement && focused.dataset.action?.startsWith("workspace:");
		const label = focused?.textContent;
		const previous = painter.workspace;
		const previousPath = previous && workspacePath(previous.cwd, previous.view.path);
		const current = () => client.connected && painter.workspaceService === service && painter.sessionId === sessionId && desiredSessionId === sessionId;
		runPanelCall({ id, ...(data === undefined ? {} : { data }), sessionId, retry: false, current, dock: "files",
			call: () => current() ? operation() : Promise.resolve(),
			afterSuccess: () => {
				// Continue keyboard navigation only if focus has not moved elsewhere during I/O.
				if (!restore || document.activeElement !== document.body || !dockOpen || dockTab !== "files") return;
				if (id === WORKSPACE_PAGE_ACTION) {
					const paging = [...document.querySelectorAll<HTMLButtonElement>(`#dock-body [data-action="${WORKSPACE_PAGE_ACTION}"]`)];
					const continuation = paging.find(button => button.textContent === label) ?? paging[0];
					if (continuation) { continuation.focus(); return; }
				}
				const entries = [...document.querySelectorAll<HTMLButtonElement>("#dock-body .file-entry:not([hidden]):not(:disabled)")];
				const target = entries.find(button => button.dataset.actionData === previousPath) ?? entries[0]
					?? document.querySelector<HTMLElement>("#dock-body .file-source-code")
					?? document.querySelector<HTMLButtonElement>(`#dock-body [data-action="${WORKSPACE_RELOAD_ACTION}"]`);
				target?.focus({ preventScroll: true });
			},
		});
	};

	renderer.onPanelAction = (action: PanelAction): void => {
		const schedule = schedules;
		const mcp = client.connected && painter.sessionId === desiredSessionId ? painter.mcpService : undefined;
		const mcpSession = mcp ? painter.sessionId : undefined;
		const hasMcpServer = (name: string): boolean => mcp !== undefined && painter.mcpValue?.servers.some(server => server.name === name) === true;
		switch (action.kind) {
			case "open":
				if (action.panel === AUTOMATION_VIEW && schedule === undefined) return;
				view = action.panel;
				closeModal();
				return;
			case "modal-close":
				closeModal();
				return;
			case "control":
				if (action.id === MODEL_SELECT_ACTION) {
					const option = renderer.view?.model.groups.flatMap(group => group.options).find(option => JSON.stringify([option.provider, option.modelId]) === action.value);
					if (option) renderer.onSelectModel(option.provider, option.modelId);
					return;
				}
				if (action.id === MODEL_THINKING_ACTION) {
					renderer.onSelectThinking(action.value);
					return;
				}
				if (action.id === WORKSPACE_OPEN_ACTION) {
					runWorkspaceCall(action.id, action.value, () => painter.workspaceOpen(action.value)); return;
				}
				if (action.id === SETTINGS_FIELD_ACTION && action.data !== undefined) {
					const id = action.data;
					const service = painter.settingsService;
					const sessionId = desiredSessionId;
					if (sessionId !== undefined && (!service || !client.connected || painter.sessionId !== sessionId)) return;
					runPanelCall({
						id: action.id, data: id, sessionId, retry: sessionId === undefined,
						call: () => settings.set(id, action.value, BACKGROUND_CONTEXT)
							.then(() => service?.reload(BACKGROUND_CONTEXT)).then(done),
					});
					return;
				}
				if (action.id === PLUGIN_MCP_ENABLED_ACTION && action.data !== undefined) {
					const name = action.data;
					if (desiredSessionId !== undefined && !hasMcpServer(name)) return;
					runPanelCall({
						id: action.id,
						data: name,
						sessionId: mcpSession,
						retry: false,
						call: () => (hasMcpServer(name)
							? mcp!.configure(name, { enabled: action.value === "true" }, false, BACKGROUND_CONTEXT)
							: plugins.setMcpServer(name, { enabled: action.value === "true" }, BACKGROUND_CONTEXT))
							.then(() => plugins.reload(BACKGROUND_CONTEXT)).then(done),
					});
					return;
				}
				if (action.id === PLUGIN_MCP_EXPOSURE_ACTION && action.data !== undefined) {
					const name = action.data;
					if (desiredSessionId !== undefined && !hasMcpServer(name)) return;
					runPanelCall({
						id: action.id,
						data: name,
						sessionId: mcpSession,
						retry: false,
						call: () => (hasMcpServer(name)
							? mcp!.configure(name, { exposure: action.value as McpExposure }, false, BACKGROUND_CONTEXT)
							: plugins.setMcpServer(name, { exposure: action.value }, BACKGROUND_CONTEXT))
							.then(() => plugins.reload(BACKGROUND_CONTEXT)).then(done),
					});
					return;
				}
				if (action.id === SCHEDULE_ENABLED_ACTION && action.data !== undefined && schedule !== undefined) {
					const id = action.data;
					runPanelCall({
						id: action.id,
						data: id,
						call: () => schedule.setEnabled(id, action.value === "true", BACKGROUND_CONTEXT).then(scheduleReply),
					});
				}
				return;
			case "command":
				switch (action.id) {
					case "insights:refresh":
						if (painter.insightsService) { const service = painter.insightsService; runPanelCall({ id: action.id, sessionId: painter.sessionId, retry: false, call: () => service.refresh(BACKGROUND_CONTEXT).then(done) }); } return;
					case "insights:resume":
						if (painter.insightsService && action.data) { const service = painter.insightsService; runPanelCall({ id: action.id, sessionId: painter.sessionId, retry: false, call: () => service.resume(action.data!, BACKGROUND_CONTEXT).then(done) }); } return;
					case "insights:diff": {
						if (!action.data || !painter.insightsService) return;
						const values: unknown = JSON.parse(action.data);
						if (Array.isArray(values) && values.length === 3 && values.every(value => typeof value === "string")) void painter.inspectDiff(values[0], values[1], values[2]).then(paint, report);
						return;
					}
					case SESSION_ARCHIVE_ACTION:
						if (action.data) openModal(archiveSessionModal(locale, action.data), action); return;
					case PROJECT_ADD_ACTION:
						openModal(addProjectModal(locale), action); return;
					case PROJECT_NEW_SESSION_ACTION:
						if (creating || !directoryReady || !client.connected) return;
						selectedProjectId = action.data; rememberSelection(); createSession(); return;
					case PROJECT_EDIT_ACTION: {
						const project = directory.state.value?.projects?.find(project => project.id === action.data);
						if (project) openModal(editProjectModal(locale, project), action); return;
					}
					case PROJECT_RENAME_ACTION: {
						const project = directory.state.value?.projects?.find(project => project.id === action.data);
						if (project) openModal(renameProjectModal(locale, project.id, project.name), action); return;
					}
					case PROJECT_REMOVE_ACTION: {
						const project = directory.state.value?.projects?.find(project => project.id === action.data);
						if (project) openModal(removeProjectModal(locale, project.id, project.name), action); return;
					}
					case PROJECT_SELECT_ACTION: {
						selectedProjectId = action.data;
						const session = rosterItems(locale, directory.state.value, undefined, Date.now(), "", false).find(item => item.projectId === action.data);
						view = CHAT_VIEW;
						void (session ? selectSession(session.id) : clearSession()).catch(report); paint(); return;
					}
					case SESSION_ARCHIVE_OPEN_ACTION: {
						const id = action.data;
						if (!client.connected || !directoryReady || id === undefined) return;
						selectionRevision += 1;
						allowArchivedAttach = true;
						view = CHAT_VIEW;
						providerAuthView = undefined;
						modal = undefined;
						paint();
						void selectSession(id).catch((error: unknown) => {
							renderer.setConnection(
								(language) => translate(language, "page.attachFailed", { error: message(error) }),
								"error",
								(language) => translate(language, "page.attachFailedShort"),
							);
						});
						return;
					}
					case SESSION_RESTORE_ACTION: {
						const selection = selectionRevision;
						runPanelCall({ id: action.id, data: action.data, call: async () => {
							const id = action.data ?? "";
							await archives.set(id, false, BACKGROUND_CONTEXT);
							if (selectionRevision === selection) {
								allowArchivedAttach = false;
								rosterFilter = "";
								view = CHAT_VIEW;
								await selectSession(id);
							}
							return { ok: true as const };
						} }); return;
					}
					case PLUGIN_MCP_PROJECT_ACTION: {
						const runtime = painter.mcpValue;
						const server = runtime?.servers.find(server => server.name === action.data && server.scope === "global");
						if (!mcp || !mcpSession || !server || !runtime?.canOverrideProject || !client.connected || mcpSession !== desiredSessionId) return;
						mcpView = { service: mcp, sessionId: mcpSession, target: server.name };
						openModal(mcpProjectModal(locale, server), action);
						return;
					}
					case MODEL_SCOPE_ACTION: {
						const service = painter.modelsService;
						const sessionId = painter.sessionId;
						if (!service || !sessionId || !client.connected || sessionId !== desiredSessionId || modalPending) return;
						const owner = { service, sessionId };
						modelScopeView = owner;
						openModal({ id: MODEL_SCOPE_MODAL, title: copy("model.scope"), fields: [], submit: copy("model.scopeApply") }, action);
						modalPending = true;
						paint();
						void service.getModelScope(BACKGROUND_CONTEXT).then(scope => {
							if (modelScopeView !== owner || painter.modelsService !== service || painter.sessionId !== sessionId || desiredSessionId !== sessionId || !client.connected) return;
							modal = modelScopeModal(locale, scope);
							modalPending = false;
							paint();
						}, () => {
							if (modelScopeView !== owner) return;
							modalPending = false;
							refuseInModal(copy("model.scopeFailed"));
						});
						return;
					}
					case MODEL_DEFAULTS_ACTION: {
						const service = painter.modelsService;
						const sessionId = painter.sessionId;
						const configuration = painter.modelsValue?.configuration;
						const model = configuration?.model;
						if (!service || !sessionId || !model || !client.connected || desiredSessionId !== sessionId) return;
						runPanelCall({ id: action.id, sessionId, retry: false,
							current: () => painter.modelsService === service && client.connected && desiredSessionId === sessionId,
							call: () => service.saveDefaults(model, configuration.thinkingLevel, BACKGROUND_CONTEXT)
								.then(() => settings.reload(BACKGROUND_CONTEXT))
								.then(() => ({ ok: true as const, note: copy("model.defaultsSaved") }), () => ({ ok: false as const, problem: copy("model.defaultsFailed") })),
						});
						return;
					}
					case SESSION_RELOAD_ACTION: {
						const sessionId = painter.sessionId;
						if (!sessionId || !client.connected || desiredSessionId !== sessionId) return;
						runPanelCall({ id: action.id, sessionId, retry: false, call: async () => {
							const result = await painter.runCommand("reload", "");
							if (!result.ok) return { ok: false as const, problem: result.message };
							await skills.reload(BACKGROUND_CONTEXT);
							return { ok: true as const, note: result.message };
						} });
						return;
					}
					case PROVIDER_AUTH_ACTION:
						openProviderAuthentication(); return;
					case PROVIDER_AUTH_OPEN_ACTION: {
						const owner = providerAuthView;
						const login = painter.modelsValue?.authentication?.login;
						if (!owner || !login || !client.connected || owner.service !== painter.modelsService || owner.sessionId !== painter.sessionId || owner.sessionId !== desiredSessionId || login.id !== owner.loginId || !action.data) return;
						const authorization = login.authorization;
						const urls = [...login.links.map(link => link.url), ...(authorization ? [authorization.type === "auth_url" ? authorization.url : authorization.verificationUri] : [])];
						if (urls.includes(action.data) && URL.canParse(action.data) && ["http:", "https:"].includes(new URL(action.data).protocol)) window.open(action.data, "_blank", "noopener,noreferrer");
						return;
					}
					case PROVIDER_AUTH_CANCEL_ACTION: {
						const owner = providerAuthView;
						if (owner && action.data === owner.loginId) runProviderAuthCall(owner, async () =>
							await owner.service.cancelLogin(action.data!, BACKGROUND_CONTEXT) ? { ok: true } : { ok: false, problem: copy("auth.expired") });
						return;
					}
					case PLUGIN_MCP_RELOAD_ACTION:
						if (mcp) runPanelCall({ id: action.id, sessionId: mcpSession, retry: false, call: () => mcp.reload(BACKGROUND_CONTEXT).then(() => plugins.reload(BACKGROUND_CONTEXT)).then(done) }); return;
					case PLUGIN_MCP_RECONNECT_ACTION: {
						const data = action.data;
						if (data !== undefined && mcp !== undefined) runPanelCall({
							id: action.id, data, sessionId: mcpSession, retry: false,
							call: () => mcp.reconnect(data, BACKGROUND_CONTEXT).then(done),
						});
						return;
					}
					case PLUGIN_MCP_LOGIN_ACTION: {
						const data = action.data;
						if (data !== undefined && mcp !== undefined) runPanelCall({
							id: action.id, data, sessionId: mcpSession, retry: false,
							call: () => mcp.startLogin(data, BACKGROUND_CONTEXT).then(done),
						});
						return;
					}
					case PLUGIN_MCP_LOGIN_OPEN_ACTION:
						if (action.data && URL.canParse(action.data) && ["http:", "https:"].includes(new URL(action.data).protocol)) window.open(action.data, "_blank", "noopener,noreferrer"); return;
					case PLUGIN_MCP_LOGIN_REDIRECT_ACTION:
						if (!mcp || !mcpSession || !action.data || painter.mcpValue?.login?.id !== action.data) return;
						mcpView = { service: mcp, sessionId: mcpSession, target: action.data };
						openModal({
							id: PLUGIN_MCP_LOGIN_MODAL, data: action.data,
							title: copy("panel.plugins.pasteRedirect"), description: copy("panel.plugins.redirectHelp"),
							submit: copy("panel.plugins.login"),
							fields: [{ id: "url", label: copy("panel.plugins.pasteRedirect"), kind: "text", value: "" }],
						}, action);
						return;
					case PLUGIN_MCP_LOGIN_CANCEL_ACTION: {
						const data = action.data;
						if (data !== undefined && mcp !== undefined) runPanelCall({
							id: action.id, data, sessionId: mcpSession, retry: false,
							call: () => mcp.cancelLogin(data, BACKGROUND_CONTEXT).then(done),
						});
						return;
					}
					case COMPACT_ACTION:
						openModal(compactModal(locale), action);
						return;
					case REFRESH_MODELS_ACTION:
						settle(painter.refreshModels());
						return;
					case SUBMIT_MODE_ACTION:
						submitMode = action.data === "steer" ? "steer" : "followUp";
						paint();
						return;
					case WELCOME_SESSION_ACTION:
						createSession();
						return;
					case WELCOME_SETTINGS_ACTION:
						view = SETTINGS_VIEW;
						closeModal();
						return;
					case WELCOME_DISMISS_ACTION:
						runPanelCall({
							id: WELCOME_DISMISS_ACTION,
							call: () => settings.set("showWelcome", "false", BACKGROUND_CONTEXT).then(done),
						});
						return;
					case FEEDBACK_UP_ACTION:
					case FEEDBACK_DOWN_ACTION: {
						const entryId = action.data ?? "";
						const rating = action.id === FEEDBACK_UP_ACTION ? "up" : "down";
						const sessionId = painter.sessionId ?? "";
						const conversationId = targetConversation() ?? "";
						const existing = feedback.state.value?.records.find(
							(record) => record.sessionId === sessionId && record.conversationId === conversationId && record.entryId === entryId,
						);
						if (entryId.length === 0 || sessionId.length === 0) return;
						const operation =
							existing?.rating === rating
								? feedback.retract({ sessionId, conversationId, entryId }, BACKGROUND_CONTEXT)
								: feedback.rate({ sessionId, conversationId, entryId, rating }, BACKGROUND_CONTEXT);
						settle(
							operation.then((result) => {
								if (!result.ok && sessionReady() && painter.sessionId === sessionId && targetConversation() === conversationId) renderer.setConnection(result.problem, "error");
							}),
						);
						return;
					}
					case APPROVAL_APPROVE_ACTION:
					case APPROVAL_DENY_ACTION: {
						const id = action.data ?? "";
						const service = painter.approvalsService;
						settle(
							service?.decide(id, action.id === APPROVAL_APPROVE_ACTION, BACKGROUND_CONTEXT).then((known) => {
								if (!known && sessionReady() && painter.approvalsService === service) {
									renderer.setConnection(copy("page.queueGone"), "error");
								}
							}),
						);
						return;
					}
					case CONVERSATION_RENAME_ACTION:
					case CONVERSATION_ARCHIVE_ACTION: {
						const service = painter.conversationsService;
						const sessionId = painter.sessionId;
						const item = painter.conversations?.conversations.find(item => item.id === action.data);
						if (!sessionReady() || !service || !sessionId || item?.role !== "fork" || item.archivedAt !== undefined
							|| directory.state.value?.sessions.find(item => item.sessionId === sessionId)?.archivedAt !== undefined) return;
						forkModalOwner = { service, sessionId, conversationId: item.id };
						openModal(action.id === CONVERSATION_RENAME_ACTION ? renameForkModal(locale, item.id, item.label) : archiveForkModal(locale, item.id), action);
						return;
					}
					case CONVERSATION_RESTORE_ACTION: {
						const service = painter.conversationsService;
						const sessionId = painter.sessionId;
						const item = painter.conversations?.conversations.find(item => item.id === action.data);
						if (!sessionReady() || !service || !sessionId || item?.role !== "fork" || item.archivedAt === undefined) return;
						const selected = painter.conversations?.selected;
						const current = () => client.connected && painter.conversationsService === service && painter.sessionId === sessionId && desiredSessionId === sessionId;
						runPanelCall({ id: action.id, data: item.id, sessionId, retry: false, current, call: async () => {
							await service.setArchived(item.id, false, BACKGROUND_CONTEXT);
							if (current() && painter.conversations?.selected === selected && selected !== item.id) await service.select(item.id, BACKGROUND_CONTEXT);
							return { ok: true as const };
						} });
						return;
					}
					case CONVERSATION_FORK_ACTION: {
						const id = action.data ?? targetConversation();
						const service = painter.conversationsService;
						if (id === undefined || service === undefined) return;
						history = [];
						historyRequest += 1;
						historyLoading = false;
						historyCursor = null;
						historyLoaded = false;
						dockOpen = true;
						dockTab = "conversations";
						settle(
							service.fork(id, null, BACKGROUND_CONTEXT).then((result) => {
								if (result.error !== null) throw new Error(result.error.message);
							}),
						);
						return;
					}
					case CONVERSATION_SELECT_ACTION: {
						const id = action.data ?? "";
						view = CHAT_VIEW;
						// A page of history belongs to the conversation it was paged from.
						history = [];
						historyRequest += 1;
						historyLoading = false;
						historyCursor = null;
						historyLoaded = false;
						dockOpen = true;
						dockTab = "conversations";
						// An existing conversation: focus only. No summary, no new conversation.
						settle(painter.conversationsService?.select(id, BACKGROUND_CONTEXT));
						return;
					}
					case TASK_RETRY_ACTION:
						settle(painter.conversationsService?.retryTask(action.data ?? "", BACKGROUND_CONTEXT));
						return;
					case LEAVE_ACTION:
					case LEAVE_SUMMARY_ACTION: {
						leaveAt(action.data ?? "", action.id === LEAVE_SUMMARY_ACTION, null);
						return;
					}
					case LEAVE_CUSTOM_ACTION:
						openModal(
							{
								id: LEAVE_CUSTOM_MODAL,
								title: copy("history.customTitle"),
								description: copy("history.customHelp"),
								data: action.data,
								fields: [
									{
										id: "instructions",
										label: copy("modal.compact.instructions"),
										kind: "textarea",
										value: "",
									},
								],
								submit: copy("history.summarize"),
							},
							action,
						);
						return;
					case CONVERSATIONS_REFRESH_ACTION:
						settle(painter.conversationsService?.refresh(BACKGROUND_CONTEXT));
						return;
					case TRANSCRIPT_SEARCH_ACTION: {
						const query = action.data?.trim() ?? "";
						const attached = client.connected && painter.ready && painter.sessionId === desiredSessionId;
						if (query.length === 0 || historyLoading || !attached) return;
						if (historyLoaded && historyCursor === null) return;
						const target = targetConversation();
						const sessionId = painter.sessionId;
						const service = painter.conversationsService;
						if (target === undefined || service === undefined) return;
						const shown = shownTranscript();
						const before = historyLoaded ? null : oldestPresentedEntryId(shown?.entries);
						const cursor = historyLoaded ? historyCursor : null;
						const request = ++historyRequest;
						historyLoading = true;
						paint();
						const sameSearch = (): boolean => request === historyRequest
							&& painter.sessionId === sessionId
							&& painter.conversationsService === service
							&& targetConversation() === target;
						void loadRemainingHistory(
							(conversationId, pageBefore, pageCursor, limit, pageContext) =>
								service.older(conversationId, pageBefore, pageCursor, limit, pageContext),
							target,
							before,
							cursor,
							BACKGROUND_CONTEXT,
						).then(
							(loaded) => {
								if (!sameSearch()) return;
								historyLoading = false;
								historyLoaded = true;
								history = [...loaded.entries, ...history];
								historyCursor = null;
								paint();
								renderer.refreshTranscriptSearch();
							},
							(error: unknown) => {
								if (!sameSearch()) return;
								historyLoading = false;
								paint();
								renderer.setConnection(copy("page.panelFailed", { error: message(error) }), "error");
							},
						);
						return;
					}
					case HISTORY_MORE_ACTION: {
						if (historyLoading || !client.connected || !painter.ready || painter.sessionId !== desiredSessionId) return;
						const target = targetConversation();
						const sessionId = painter.sessionId;
						const service = painter.conversationsService;
						if (target === undefined || service === undefined) return;
						// The first page starts below the oldest entry the transcript shows.
						const shown = shownTranscript();
						const before = historyLoaded ? null : oldestPresentedEntryId(shown?.entries);
						const request = ++historyRequest;
						historyLoading = true;
						paint();
						void service.older(target, before, historyCursor, 20, BACKGROUND_CONTEXT).then(
							(page) => {
								if (request !== historyRequest || painter.sessionId !== sessionId || painter.conversationsService !== service || targetConversation() !== target) return;
								historyLoading = false;
								historyLoaded = true;
								history = [...page.entries, ...history];
								historyCursor = page.cursor ?? null;
								paint();
									renderer.refreshTranscriptSearch({ loadHistory: true });
							},
							(error: unknown) => {
								if (request !== historyRequest || painter.sessionId !== sessionId || painter.conversationsService !== service || targetConversation() !== target) return;
								historyLoading = false;
								paint();
								renderer.setConnection(copy("page.panelFailed", { error: message(error) }), "error");
							},
						);
						return;
					}
					case DOCK_TOGGLE_ACTION:
						dockOpen = !dockOpen;
						paint();
						return;
					case DOCK_TAB_ACTION:
						dockTab = action.data ?? "files";
						dockOpen = true;
						paint();
						return;
					case WORKSPACE_RELOAD_ACTION:
						runWorkspaceCall(action.id, action.data, () => painter.workspaceNavigate(action.data));
						return;
					case WORKSPACE_PAGE_ACTION:
						runWorkspaceCall(action.id, action.data, () => painter.workspaceNavigate(action.data));
						return;
					case WORKSPACE_OPEN_ACTION:
						runWorkspaceCall(action.id, action.data, () => painter.workspaceOpen(action.data ?? "."));
						return;
					case WORKSPACE_READ_ACTION:
						runWorkspaceCall(action.id, action.data, () => painter.workspaceRead(action.data ?? ""));
						return;
					case TERMINAL_RUN_ACTION:
						settle(painter.runTerminal(action.data ?? ""));
						return;
					case TERMINAL_STOP_ACTION:
						settle(painter.stopTerminal());
						return;
					case SESSION_RENAME_ACTION: {
						const sessionId = action.data ?? "";
						const current = directory.state.value?.sessions.find((session) => session.sessionId === sessionId);
						openModal(renameSessionModal(locale, sessionId, current?.name ?? ""), action);
						return;
					}
					case SESSION_REMOVE_ACTION:
						openModal(removeSessionModal(locale, action.data ?? ""), action);
						return;
					case SCHEDULE_ADD_ACTION: {
						if (schedule === undefined) return;
						const sessionId = painter.sessionId;
						// The panel's own footer says what to do; the button is inert without a session.
						if (sessionId === undefined) {
							panelNotice = {
								tone: "error",
								text: copy("panel.automation.noSession"),
							};
							paint();
							return;
						}
						openModal(addScheduleModal(locale, sessionId, painter.conversations?.selected ?? rootConversationId), action);
						return;
					}
					case SCHEDULE_EDIT_ACTION:
					case SCHEDULE_HISTORY_ACTION: {
						const record = schedule?.state.value?.schedules.find((candidate) => candidate.id === action.data);
						if (record !== undefined) openModal(action.id === SCHEDULE_EDIT_ACTION ? editScheduleModal(locale, record) : scheduleHistoryModal(locale, record), action);
						return;
					}

					case SCHEDULE_REMOVE_ACTION:
						if (schedule === undefined) return;
						openModal(removeScheduleModal(locale, action.data ?? ""), action);
						return;
					case SCHEDULE_RUN_ACTION: {
						if (schedule === undefined) return;
						const id = action.data ?? "";
						const requestId = crypto.randomUUID();
						runPanelCall({
							id: action.id,
							data: id,
							call: () => schedule.runNow(id, requestId, BACKGROUND_CONTEXT).then(scheduleReply),
						});
						return;
					}
					case SCHEDULE_CANCEL_ACTION:
						if (schedule !== undefined) runPanelCall({ id: action.id, data: action.data, call: () => schedule.cancel(action.data ?? "", BACKGROUND_CONTEXT).then(scheduleReply) });
						return;
					case SCHEDULE_RELOAD_ACTION:
						if (schedule !== undefined) runPanelCall({ id: action.id, call: () => schedule.reload(BACKGROUND_CONTEXT).then(done) });
						return;
					case ATTACHMENT_REMOVE_ACTION: {
						pending = pending.filter((image) => image.id !== action.data);
						paint();
						return;
					}
					case QUEUE_CANCEL_ACTION: {
						const entryId = action.data ?? "";
						const target = targetConversation();
						const focused = target !== undefined && target !== rootConversationId ? target : undefined;
						settle(painter.cancelQueued(entryId, focused));
						return;
					}
					case SETTINGS_RELOAD_ACTION: {
						const service = painter.settingsService;
						const sessionId = desiredSessionId;
						if (sessionId !== undefined && (!service || !client.connected || painter.sessionId !== sessionId)) return;
						runPanelCall({ id: action.id, sessionId, retry: sessionId === undefined,
							call: () => settings.reload(BACKGROUND_CONTEXT).then(() => service?.reload(BACKGROUND_CONTEXT)).then(done),
						});
						return;
					}
					case DIAGNOSTICS_ACTION: {
						const request = ++diagnosticRequest;
						diagnosticReport = undefined;
						openModal({ id: DIAGNOSTICS_MODAL, title: copy("panel.settings.diagnostics"), fields: [], submit: copy("modal.close") }, action);
						modalPending = true;
						paint();
						void diagnostics.report(BACKGROUND_CONTEXT).then(result => {
							if (request !== diagnosticRequest || modal?.id !== DIAGNOSTICS_MODAL) return;
							diagnosticReport = { ...result, entries: [
								...result.entries,
								{ area: "resources", target: "Web client", code: "clientLoaded", level: "info" },
								...[...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((link, index) => ({ area: "resources" as const, target: `Web stylesheet ${index + 1}`, code: link.sheet === null ? "unreadable" as const : "readable" as const, level: link.sheet === null ? "error" as const : "info" as const })),
							] };
							modalPending = false;
							paint();
						}, () => {
							if (request !== diagnosticRequest || modal?.id !== DIAGNOSTICS_MODAL) return;
							modalPending = false;
							modalNotice = { tone: "error", text: copy("panel.settings.diagnosticsFailed") };
							paint();
						});
						return;
					}
					case SKILL_NEW_ACTION:
						openModal(newSkillModal(locale), action);
						return;
					case SKILL_IMPORT_ACTION:
						openModal(importSkillModal(locale), action);
						return;
					case SKILL_REMOVE_ACTION:
						openModal(removeSkillModal(locale, action.data ?? ""), action);
						return;
					case SKILL_EDIT_ACTION: {
						const name = action.data ?? "";
						// The file is read first; the modal opens with it, and the opener's own row is
						// what takes the focus back when it closes.
						void skills
							.read(name, BACKGROUND_CONTEXT)
							.then((content) => openModal(skillModal(locale, name, content, skillOf(name)?.editable === true), action))
							.catch((error: unknown) => {
								panelNotice = { tone: "error", text: message(error) };
								paint();
							});
						return;
					}
					case PLUGIN_PACKAGE_ADD_ACTION:
						openModal(addPackageModal(locale), action);
						return;
					case PLUGIN_PACKAGE_REMOVE_ACTION: {
						const path = action.data ?? "";
						runPanelCall({
							id: action.id,
							data: path,
							call: () =>
								plugins
									.setPackages(
										pluginPackages().filter((candidate) => candidate !== path),
										BACKGROUND_CONTEXT,
									)
									.then(done),
						});
						return;
					}
					case PLUGIN_MCP_ADD_ACTION:
						openModal(addMcpServerModal(locale), action);
						return;
					case PLUGIN_MCP_REMOVE_ACTION: {
						const name = action.data ?? "";
						const server = desiredSessionId === undefined ? plugins.state.value?.mcp.servers.find(server => server.name === name)
							: mcp ? painter.mcpValue?.servers.find(server => server.name === name) : undefined;
						if (server?.scope !== "global") return;
						runPanelCall({
							id: action.id,
							data: name,
							sessionId: mcpSession,
							retry: false,
							call: () => plugins.removeMcpServer(name, BACKGROUND_CONTEXT).then(() => mcp?.reload(BACKGROUND_CONTEXT)).then(done),
						});
						return;
					}
					default:
						return;
				}
			case "modal-submit": {
				const fields = action.fields;
				switch (action.id) {
					case PROJECT_ADD_MODAL:
					case PROJECT_EDIT_MODAL: {
						if (!fields.name?.trim()) { refuseInModal(copy("project.nameRequired")); return; }
						let workspaces: unknown;
						try { workspaces = JSON.parse(fields.workspaces ?? "[]"); } catch { workspaces = undefined; }
						if (!Array.isArray(workspaces) || workspaces.length === 0 || !workspaces.every((path: unknown): path is string => typeof path === "string" && path.trim().length > 0)) {
							refuseInModal(copy("project.directoryRequired")); return;
						}
						const folders: string[] = workspaces;
						const selection = selectionRevision;
						const dialog = modal;
						runPanelCall({ id: action.id, inModal: true, call: async () => {
							const project = action.id === PROJECT_EDIT_MODAL
								? await projects.update(action.data ?? "", { name: fields.name!.trim(), workspaces: folders }, BACKGROUND_CONTEXT)
								: await projects.create({ cwd: folders[0]!, name: fields.name!.trim(), workspaces: folders }, BACKGROUND_CONTEXT);
							if (action.id === PROJECT_ADD_MODAL && selectionRevision === selection && modal === dialog) {
								selectedProjectId = project.id; allowArchivedAttach = false; await clearSession();
							}
							return { ok: true as const };
						} }); return;
					}
					case PROJECT_RENAME_MODAL:
						if (!fields.name?.trim()) { refuseInModal(copy("project.nameRequired")); return; }
						runPanelCall({ id: action.id, data: action.data, inModal: true, call: () => projects.rename(action.data ?? "", fields.name ?? "", BACKGROUND_CONTEXT).then(done) }); return;
					case PROJECT_REMOVE_MODAL:
						runPanelCall({ id: action.id, data: action.data, inModal: true, call: () => projects.remove(action.data ?? "", BACKGROUND_CONTEXT).then(done) }); return;
					case SESSION_ARCHIVE_MODAL:
						runPanelCall({ id: action.id, data: action.data, inModal: true, retry: false, call: () => archives.set(action.data ?? "", true, BACKGROUND_CONTEXT).then(done) }); return;
					case PLUGIN_MCP_PROJECT_MODAL: {
						const owner = mcpView;
						if (!owner || modal?.id !== action.id || action.data !== owner.target || modalPending) return;
						const current = () => mcpView === owner && painter.mcpService === owner.service && painter.sessionId === owner.sessionId && desiredSessionId === owner.sessionId && client.connected;
						if (!current() || !painter.mcpValue?.canOverrideProject) return;
						const exposure = fields.exposure;
						if (!exposure || !["direct", "codemode", "deferred", "hidden"].includes(exposure)) return;
						runPanelCall({ id: action.id, inModal: true, sessionId: owner.sessionId, retry: false, current,
							call: () => owner.service.configure(owner.target, { enabled: fields.enabled === "true", exposure: exposure as McpExposure }, true, BACKGROUND_CONTEXT)
								.then(() => plugins.reload(BACKGROUND_CONTEXT)).then(done, () => ({ ok: false as const, problem: copy("panel.plugins.projectSettingsFailed") })),
						});
						return;
					}
					case CONVERSATION_RENAME_MODAL:
					case CONVERSATION_ARCHIVE_MODAL: {
						const owner = forkModalOwner;
						if (!owner || modalPending || modal?.id !== action.id || modal.data !== action.data || owner.conversationId !== action.data) return;
						const current = () => forkModalOwner === owner && client.connected && painter.conversationsService === owner.service
							&& painter.sessionId === owner.sessionId && desiredSessionId === owner.sessionId;
						if (!current()) return;
						const name = (fields.name ?? "").replace(/\s+/g, " ").trim();
						if (action.id === CONVERSATION_RENAME_MODAL && (name.length === 0 || name.length > 200)) { refuseInModal(copy("dock.forkNameRequired")); return; }
						runPanelCall({ id: action.id, data: owner.conversationId, sessionId: owner.sessionId, inModal: true, retry: false, current,
							call: () => (action.id === CONVERSATION_RENAME_MODAL
								? owner.service.rename(owner.conversationId, name, BACKGROUND_CONTEXT)
								: owner.service.setArchived(owner.conversationId, true, BACKGROUND_CONTEXT)).then(done),
						});
						return;
					}
					case SESSION_RENAME_MODAL: {
						const name = (fields.name ?? "").trim();
						if (name.length === 0) {
							refuseInModal(copy("page.nameRequired"));
							return;
						}
						runPanelCall({
							id: action.id, data: action.data, inModal: true,
							call: () => management.rename(action.data ?? "", name, BACKGROUND_CONTEXT).then(done),
						});
						return;
					}
					case SESSION_REMOVE_MODAL: {
						const sessionId = action.data ?? "";
						const projectId = selectedProjectId;
						let selection = selectionRevision;
						runPanelCall({
							id: action.id,
							data: sessionId,
							inModal: true,
							call: async () => {
								// A session that was just attached is let go of first, and the removal waits
								// for that to settle: the host releases this attachment either way, and a call
								// in flight across the transition would lose its binding.
								const wasCurrent = desiredSessionId === sessionId;
								if (wasCurrent) {
									const clearing = clearSession();
									selection = selectionRevision;
									await clearing;
								}
								await management.remove(sessionId, BACKGROUND_CONTEXT);
								sessionDrafts.delete(sessionId);
								if (wasCurrent && selectionRevision === selection) {
									const next = rosterItems(locale, directory.state.value, undefined, Date.now(), "", false)
										.find(item => item.id !== sessionId && (projectId === undefined || item.projectId === projectId));
									if (next !== undefined) await selectSession(next.id);
								}
								return { ok: true as const };
							},
						});
						return;
					}
					case LEAVE_CUSTOM_MODAL:
						closeModal();
						leaveAt(action.data ?? "", true, fields.instructions ?? "");
						return;
					case COMPACT_MODAL:
						runPanelCall({
							id: action.id,
							inModal: true,
							call: () => {
								const target = targetConversation();
								const focused = target !== undefined && target !== rootConversationId ? target : undefined;
								return painter.compact(fields.instructions ?? "", focused).then(done);
							},
						});
						return;
					case SKILL_CREATE_MODAL: {
						const name = (fields.name ?? "").trim();
						if (name.length === 0) {
							refuseInModal(copy("page.skillNeedsName"));
							return;
						}
						runPanelCall({
							id: action.id,
							inModal: true,
							call: () =>
								skills
									.write(
										{
											name,
											content: composeSkill(name, fields.description ?? "", fields.body ?? ""),
										},
										BACKGROUND_CONTEXT,
									)
									.then(done),
						});
						return;
					}
					case SKILL_EDIT_MODAL:
						runPanelCall({
							id: action.id,
							inModal: true,
							call: () => skills.write({ name: action.data ?? "", content: fields.content ?? "" }, BACKGROUND_CONTEXT).then(done),
						});
						return;
					case SKILL_REMOVE_MODAL:
						runPanelCall({
							id: action.id,
							data: action.data,
							inModal: true,
							call: () => skills.remove(action.data ?? "", BACKGROUND_CONTEXT).then(done),
						});
						return;
					case SKILL_IMPORT_MODAL:
						runPanelCall({
							id: action.id,
							inModal: true,
							call: () => skills.importSkill(fields.path ?? "", BACKGROUND_CONTEXT).then(done),
						});
						return;
					case PLUGIN_PACKAGE_MODAL: {
						const path = (fields.path ?? "").trim();
						if (path.length === 0) {
							refuseInModal(copy("page.packageNeedsPath"));
							return;
						}
						runPanelCall({
							id: action.id,
							inModal: true,
							call: () => plugins.setPackages([...pluginPackages(), path], BACKGROUND_CONTEXT).then(done),
						});
						return;
					}
					case MODEL_SCOPE_MODAL: {
						const owner = modelScopeView;
						if (!owner || modal?.id !== action.id || modalPending) return;
						const current = () => modelScopeView === owner && painter.modelsService === owner.service && painter.sessionId === owner.sessionId && desiredSessionId === owner.sessionId && client.connected;
						if (!current()) return;
						let selected: unknown;
						try { selected = JSON.parse(fields.models ?? ""); } catch { refuseInModal(copy("model.scopeFailed")); return; }
						if (selected !== null && (!Array.isArray(selected) || selected.some((id: unknown) => typeof id !== "string"))) return;
						runPanelCall({ id: action.id, inModal: true, sessionId: owner.sessionId, retry: false, current,
							call: () => owner.service.setModelScope(selected as string[] | null, fields.persist === "true", BACKGROUND_CONTEXT)
								.then(done, () => ({ ok: false as const, problem: copy("model.scopeFailed") })),
						});
						return;
					}
					case PROVIDER_AUTH_MODAL: {
						const owner = providerAuthView;
						const state = painter.modelsValue?.authentication;
						if (!owner || !state || modal?.id !== action.id || modal.data !== action.data || modalPending) return;
						if (owner.loginId !== undefined || owner.starting) {
							const login = state.login?.id === owner.loginId ? state.login : null;
							const prompt = login?.prompt;
							if (!prompt) { closeModal(); return; }
							if (prompt.type === "secret" && !(fields.value ?? "").trim()) { refuseInModal(copy("auth.required")); return; }
							runProviderAuthCall(owner, async () => await owner.service.submitLoginPrompt(login.id, prompt.id, fields.value ?? "", BACKGROUND_CONTEXT)
								? { ok: true } : { ok: false, problem: copy("auth.expired") });
							return;
						}
						const provider = state.providers.find(entry => entry.id === fields.provider);
						const method = fields[`method:${provider?.id}`];
						if (!provider || !(method === "logout" ? provider.configured : provider.methods.some(entry => entry.type === method))) {
							refuseInModal(copy("auth.invalid")); return;
						}
						if (method === "logout") runProviderAuthCall(owner, async () => {
							await owner.service.logout(provider.id, BACKGROUND_CONTEXT);
							return { ok: true, note: copy("auth.loggedOut") };
						});
						else {
							owner.starting = true;
							runProviderAuthCall(owner, async () => {
								const id = await owner.service.startLogin(provider.id, method as "oauth" | "api_key", BACKGROUND_CONTEXT);
								owner.loginId = id;
								owner.starting = false;
								return { ok: true };
							});
						}
						return;
					}
					case PLUGIN_MCP_LOGIN_MODAL: {
						const owner = mcpView;
						if (!owner || modal?.id !== action.id || action.data !== owner.target || modalPending) return;
						const current = () => mcpView === owner && painter.mcpService === owner.service &&
							painter.sessionId === owner.sessionId && desiredSessionId === owner.sessionId && client.connected;
						if (!current()) return;
						if (painter.mcpValue?.login?.id !== owner.target) { refuseInModal(copy("panel.plugins.loginExpired")); return; }
						runPanelCall({
							id: action.id, inModal: true, sessionId: owner.sessionId, retry: false, current,
							call: async () => {
								if (!await owner.service.submitRedirect(owner.target, fields.url ?? "", BACKGROUND_CONTEXT))
									throw new Error(copy("panel.plugins.loginExpired"));
								return done();
							},
						});
						return;
					}
					case PLUGIN_MCP_MODAL:
						runPanelCall({
							id: action.id,
							inModal: true,
							sessionId: mcpSession,
							retry: false,
							call: () => plugins.addMcpServer((fields.name ?? "").trim(), fields.entry ?? "", BACKGROUND_CONTEXT).then(() => mcp?.reload(BACKGROUND_CONTEXT)).then(done),
						});
						return;
					case SCHEDULE_HISTORY_MODAL:
					case DIAGNOSTICS_MODAL:
						closeModal(); return;
					case SCHEDULE_ADD_MODAL: {
						if (schedule === undefined) return;
						let target: unknown;
						try { target = JSON.parse(action.data ?? "null"); } catch { return; }
						if (typeof target !== "object" || target === null || !("id" in target) || typeof target.id !== "string"
							|| !("sessionId" in target) || typeof target.sessionId !== "string" || !("conversationId" in target) || typeof target.conversationId !== "string") return;
						const prompt = (fields.prompt ?? "").trim();
						if (prompt.length === 0) { refuseInModal(copy("page.scheduleNeedsPrompt")); return; }
						const kind = fields.kind;
						if (!(kind === "interval" || kind === "once" || kind === "cron")) return;
						const busy = fields.busy; const missed = fields.missed;
						if (!(busy === "queue" || busy === "skip") || !(missed === "latest" || missed === "skip")) return;
						const minutes = Number(fields.everyMinutes);
						if (kind === "interval" && (!Number.isInteger(minutes) || minutes < 1)) { refuseInModal(copy("page.scheduleNeedsMinutes")); return; }
						const rule: ScheduleInput["rule"] = kind === "interval" ? { kind, everyMinutes: minutes }
							: kind === "once" ? { kind, at: fields.at ?? "", timeZone: (fields.timeZone ?? "").trim() }
							: { kind, expression: fields.expression ?? "", timeZone: (fields.timeZone ?? "").trim() };
						const input: ScheduleInput = { id: target.id, sessionId: target.sessionId, conversationId: target.conversationId,
							prompt, rule, busy, missed, graceMinutes: Number(fields.graceMinutes), timeoutSeconds: Number(fields.timeoutSeconds) };
						const generation = "expectedGeneration" in target ? target.expectedGeneration : undefined;
						if (generation !== undefined && typeof generation !== "number") return;
						runPanelCall({ id: action.id, inModal: true,
							call: () => (generation === undefined ? schedule.add(input, BACKGROUND_CONTEXT)
								: schedule.update(input, generation, BACKGROUND_CONTEXT)).then(scheduleReply) });
						return;
					}

					case SCHEDULE_REMOVE_MODAL:
						if (schedule === undefined) return;
						runPanelCall({
							id: action.id,
							data: action.data,
							inModal: true,
							call: () => schedule.remove(action.data ?? "", BACKGROUND_CONTEXT).then(done),
						});
						return;
					default:
						// A read-only view submits to close, which is what removing the modal does.
						closeModal();
						return;
				}
			}
		}
	};

	/** Set by the page's unload handler, so a retry loop stops with the page. */
	let leaving = false;
	/**
	 * A host can go away and come back: a restart, a crash, a machine waking up. The page keeps the
	 * session the reader was on, retries the connection with backoff, re-attaches that session, and
	 * repaints. The brand's connection indicator retains each step's details, so a page that cannot
	 * get through says so rather than looking attached.
	 */
	let retrying: Promise<void> | undefined;
	const retryConnection = (): void => {
		if (leaving || retrying !== undefined) return;
		retrying = (async () => {
			let waitMs = 500;
			while (!leaving && !client.connected) {
				await new Promise((resolve) => setTimeout(resolve, waitMs));
				if (leaving) return;
				try {
					await client.reconnect();
				} catch (error: unknown) {
					renderer.setConnectionState(
						(language) => translate(language, "connection.retrying", { error: message(error) }),
						"disconnected",
					);
					waitMs = Math.min(waitMs * 2, 10_000);
				}
			}
			if (!client.connected) return;
			// An attachment lives with the connection, so the reader's session is bound again. The
			// bindings of the old connection are released first: their handles are gone with it.
			for (let attempt = 0; !leaving; attempt += 1) {
				try {
					if (!client.connected) await client.reconnect();
					await serverServices.ready(BACKGROUND_CONTEXT);
					await scheduleDiscovery;
					if (!client.connected || !directoryReady) throw new Error(copy("connection.hostGone"));
					const target = desiredSessionId;
					if (target === undefined || !canResumeSession(target)) {
						await clearSession();
						return;
					}
					await selectSession(target, true);
					if (!client.connected) throw new Error(copy("connection.hostGone"));
					if (painter.sessionId !== desiredSessionId || !painter.ready) continue;
					renderer.setConnectionState(copy("connection.connected"), "connected");
					paint();
					return;
				} catch (error: unknown) {
					if (attempt >= 4 && client.connected) {
						renderer.setConnection(
							(language) => translate(language, "page.attachFailed", { error: message(error) }),
							"error",
							(language) => translate(language, "page.attachFailedShort"),
						);
						return;
					}
					renderer.setConnectionState(
						(language) => translate(language, "connection.retrying", { error: message(error) }),
						client.connected ? "connecting" : "disconnected",
					);
					await new Promise((resolve) => setTimeout(resolve, waitMs));
					waitMs = Math.min(waitMs * 2, 10_000);
				}
			}
		})().finally(() => {
			retrying = undefined;
		});
	};
	client.onConnectionStateChange((change) => {
		directoryReady = false;
		if (change.state === "connected") {
			if (booted) scheduleDiscovery = discoverSchedules().catch(report);
			renderer.setConnectionState((language) => translate(language, "connection.connecting"), "connecting");
			paint();
			return;
		}
		if (change.state === "disconnected") {
			void clearSchedules().catch(report);
			historyRequest += 1;
			historyLoading = false;
			const previous = renderer.view;
			if (previous?.attachedId !== undefined) {
				reconnectTranscript = {
					blocks: previous.blocks,
					history: { ...previous.history, loading: false },
					transcriptScope: previous.transcriptScope,
					sessionLabel: previous.sessionLabel,
					focus: previous.focus,
					lane: previous.lane,
					model: { ...previous.model, disabled: true },
				};
			}
			saveDraft();
			void transition(() => painter.detach()).catch(report);
			renderer.setConnectionState(
				(language) => translate(language, "connection.disconnected", {
					error: change.error?.message ?? translate(language, "connection.hostGone"),
				}),
				"disconnected",
			);
			paint();
			retryConnection();
			return;
		}
		// Any other state the client reports is its own word for an unfinished connection.
		renderer.setConnectionState((language) => translate(language, "connection.connecting"), "connecting");
		paint();
	});
	try {
		await client.connect();
	} catch (error) {
		fail(renderer, error, locale);
		await client.dispose();
		return undefined;
	}
	await serverServices.ready(BACKGROUND_CONTEXT);
	scheduleDiscovery = discoverSchedules();
	await scheduleDiscovery;
	// The tab remains independent. A new origin/window uses the host's last saved selection,
	// unless the URL names a session explicitly.
	const selection = selectionRevision;
	const href = (globalThis as { location?: { href?: string } }).location?.href;
	const linked = href === undefined ? undefined : sessionDeepLink(href);
	let deepLinked = false;
	let remembered: ProjectSelection | undefined;
	if (linked !== undefined) {
		remembered = linked;
		deepLinked = true;
	}
	if (!deepLinked) {
		try {
			const value: unknown = JSON.parse(sessionStorage.getItem(selectionKey) ?? "null");
			if (isProjectSelection(value)) remembered = value;
			else {
				const projectId = sessionStorage.getItem(`amazme.project.${manifest.server.id}`);
				const sessionId = sessionStorage.getItem(`amazme.session.${manifest.server.id}`);
				if (projectId || sessionId) remembered = { ...(projectId ? { projectId } : {}), ...(sessionId ? { sessionId } : {}) };
			}
		} catch { /* The host fallback also works without browser storage. */ }
	}
	remembered ??= await projects.selection(BACKGROUND_CONTEXT).catch((error: unknown) => { report(error instanceof Error ? error : new Error(String(error))); return undefined; });
	booted = true;
	if (selectionRevision === selection) {
		const state = directory.state.value;
		const previous = state?.sessions.find(session => session.sessionId === remembered?.sessionId);
		// A deep link to an archived session opens it read-only instead of refusing the attach.
		const sameArchive = previous?.archivedAt !== undefined
			&& (previous.archivedAt === remembered?.archivedAt || deepLinked);
		allowArchivedAttach = sameArchive;
		const available = state?.projects?.filter(project => !project.removed) ?? [];
		const project = available.find(project => project.id === (remembered?.projectId ?? previous?.projectId))
			?? available.find(project => project.id === state?.defaultProjectId) ?? available[0];
		selectedProjectId = project?.id;
		let initial: string | undefined;
		if (remembered === undefined) initial = rosterItems(locale, state, undefined, Date.now()).find(item => project === undefined || item.projectId === project.id)?.id;
		else if (previous !== undefined && canResumeSession(previous.sessionId)
			&& (previous.archivedAt === undefined || previous.archivedAt === remembered.archivedAt || deepLinked)
			&& (previous.projectId === selectedProjectId || sameArchive)) initial = previous.sessionId;
		if (initial === undefined) await clearSession();
		else await selectSession(initial).catch((error: unknown) => {
			renderer.setConnection(
				(language) => translate(language, "page.attachFailed", { error: message(error) }),
				"error",
				(language) => translate(language, "page.attachFailedShort"),
			);
		});
	} else rememberSelection();
	paint();

	globalThis.addEventListener("pagehide", () => {
		if (leaving) return;
  leaving = true;
  suggestions.update(undefined, false, async () => null);
  void (async () => {
   const views = await Promise.allSettled([clearSchedules(), painter.detach()]);
   const sources = await Promise.allSettled([serverSource.dispose(BACKGROUND_CONTEXT), sessionSource.dispose(BACKGROUND_CONTEXT)]);
   await client.dispose();
   const errors = [...views, ...sources].flatMap(result => result.status === "rejected" ? [result.reason] : []);
   if (errors.length) throw new AggregateError(errors, "Page shutdown failed");
  })().catch(report);
	});
	return client;
}

function fail(renderer: PageRenderer, error: unknown, locale: Locale): void {
	const text = translate(locale, "page.cannotBoot", { error: message(error) });
	renderer.setConnectionState(text, "disconnected");
	renderer.render(failureView(locale, text));
}

/** Entry point referenced by the served document. */
export async function main(): Promise<void> {
	let elements: PageElements;
	let renderer: PageRenderer;
	// The document carries the stored preference; without one this browser's languages decide.
	const manifest = readManifest();
	const locale = resolveLocale(manifest?.preferences?.locale, navigator.languages);
	try {
		followSystemTheme();
		applyTheme(resolveThemePreference(manifest?.preferences?.appearance));
		elements = collectPageElements();
		renderer = createRenderer(
			elements,
			() => {},
			manifest === undefined ? undefined : { name: manifest.app.name, version: manifest.app.version },
		);
	} catch (error) {
		document.body.textContent = translate(locale, "page.cannotBoot", {
			error: message(error),
		});
		return;
	}
	const perf = (() => {
		if (typeof location === "undefined") return undefined;
		try {
			return perfRequest(location.href, globalThis.localStorage);
		} catch {
			return undefined;
		}
	})();
	if (perf !== undefined) {
		// Development measurement route: no host connection, synthetic transcript.
		await runPerfCase(renderer, perf).catch((error: unknown) => {
			console.error(`AMAZME_PERF failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		return;
	}
	try {
		await startPage(renderer);
	} catch (error) {
		fail(renderer, error, locale);
	}
}

// The page runs when the document loads it. An import outside a document — the transition queue's
// test — leaves it alone rather than failing on a missing DOM.
if (typeof document !== "undefined") void main();
