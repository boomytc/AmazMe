/// <reference lib="dom" />
/**
 * Page entry: read the host's boot manifest, dial the loopback byte transport, bind the host's
 * replicated services, and paint them. The page contract, view model, and DOM renderer come from
 * `@amazme/web`; this module owns the client lifecycle, session attachment, and the visible
 * failure states.
 */
import type { ModelThinkingLevel } from "@amazme/ai";
import type { RemoteServices, ReplicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { Client, type ClientOptions } from "@amazme/client";
import { createWebSocketTransportFactory } from "@amazme/client/websocket";
import type { ConversationView, EntryRecord } from "@amazme/durable";
import {
	AUTOMATION_VIEW,
	APPROVAL_APPROVE_ACTION,
	APPROVAL_DENY_ACTION,
	ATTACHMENT_REMOVE_ACTION,
	addMcpServerModal,
	addPackageModal,
	addScheduleModal,
	editScheduleModal,
	scheduleHistoryModal,
	scheduleActionCopy,
	applyTheme,
	attachmentRejection,
	BOOT_GLOBAL,
	buildWebView,
	CHAT_VIEW,
	COMPACT_ACTION,
	COMPACT_MODAL,
	CONVERSATION_FORK_ACTION,
	CONVERSATION_SELECT_ACTION,
	CONVERSATIONS_REFRESH_ACTION,
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
	PLUGIN_MCP_REMOVE_ACTION,
	PLUGIN_PACKAGE_ADD_ACTION,
	PLUGIN_PACKAGE_MODAL,
	PLUGIN_PACKAGE_REMOVE_ACTION,
	panelNav,
	parseCommandLine,
	QUEUE_CANCEL_ACTION,
	REFRESH_MODELS_ACTION,
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
	WELCOME_FILES_ACTION,
	WELCOME_SESSION_ACTION,
	WELCOME_SETTINGS_ACTION,
	type WebBootManifest,
	WORKSPACE_OPEN_ACTION,
	WORKSPACE_READ_ACTION,
	WORKSPACE_RELOAD_ACTION,
	type CommandLike,
} from "@amazme/web";
import { oldestPresentedEntryId } from "../../durable/conversation-view.ts";
import { AgentController, type AgentPromptImage } from "../../core/plugins/agent-controller.ts";
import { Approvals, type Approvals as ApprovalsService, type ApprovalsState } from "../services/approvals.ts";
import { Commands, type Commands as CommandsService, type CommandsState } from "../services/commands.ts";
import { createServerServiceSource, createSessionServiceSource, type SessionServiceSource } from "../services/connection.ts";
import { Conversations, type Conversations as ConversationsService } from "../services/conversations.ts";
import { Feedback, type Feedback as FeedbackService, type FeedbackState } from "../services/feedback.ts";
import { Mcp, type Mcp as McpService } from "../services/mcp.ts";
import type { McpManagementState } from "../../core/mcp/management.ts";
import type { McpExposure } from "../../core/mcp-servers.ts";
import { Models, type ModelsState } from "../services/models.ts";
import { Plugins } from "../services/plugins.ts";
import { type ScheduleInput, type ScheduleResult, Schedules, type Schedules as SchedulesService } from "../../core/plugins/schedules.ts";
import { SessionDirectory, SessionManagement } from "../services/sessions.ts";
import { SessionSettings, Settings } from "../services/settings.ts";
import { Skills } from "../services/skills.ts";
import { Diagnostics } from "../services/diagnostics.ts";
import { formatDiagnosticReport, type DiagnosticReport } from "../../core/diagnostics-types.ts";
import { Terminal, type Terminal as TerminalService, type TerminalState } from "../services/terminal.ts";
import { Transcript } from "../services/transcript.ts";
import { Workspace, type Workspace as WorkspaceService, type WorkspaceState } from "../services/workspace.ts";

function readManifest(): WebBootManifest | undefined {
	const candidate = (globalThis as Record<string, unknown>)[BOOT_GLOBAL];
	if (typeof candidate !== "object" || candidate === null) return undefined;
	const manifest = candidate as Partial<WebBootManifest>;
	if (typeof manifest.server?.id !== "string" || typeof manifest.transport?.url !== "string") return undefined;
	return manifest as WebBootManifest;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	if (view.dock.panel.id !== "conversations" || points.length === 0) return view;
	const actions = (id: string): PanelRow["actions"] =>
		skipPrompt
			? [{ id: LEAVE_ACTION, label: "Return", tone: "default", data: id }]
			: [
					{ id: LEAVE_ACTION, label: "No summary", tone: "default", data: id },
					{ id: LEAVE_SUMMARY_ACTION, label: "Summarize", tone: "default", data: id },
					{ id: LEAVE_CUSTOM_ACTION, label: "Custom", tone: "default", data: id },
				];
	const rows: PanelRow[] = points.map((point) => ({
		id: `return:${point.id}`,
		title: point.label,
		description: "Continue from here",
		actions: actions(point.id),
	}));
	const group: PanelGroup = {
		id: "conversations:return",
		title: "Return to",
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
	#transcript: ReplicatedState<ConversationView> | undefined;
	#controller: AgentController | undefined;
	#models: Models | undefined;
	#mcp: McpService | undefined;
	#sessionSettings: SessionSettings | undefined;
	#commands: CommandsService | undefined;
	#workspace: WorkspaceService | undefined;
	#terminal: TerminalService | undefined;
	#conversations: ConversationsService | undefined;
	#approvals: ApprovalsService | undefined;
	#levels: readonly string[] | undefined;
	#levelsModel: string | undefined;
	#services: ReturnType<SessionServiceSource["open"]> | undefined;
	#sessionId: string | undefined;

	constructor(sessionSource: SessionServiceSource, renderer: PageRenderer) {
		this.#sessionSource = sessionSource;
		this.#renderer = renderer;
	}

	get sessionId(): string | undefined {
		return this.#sessionId;
	}
	get ready(): boolean {
		return this.#services !== undefined && this.#controller !== undefined && this.#conversations !== undefined;
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

	/** The attached model's levels; `undefined` until the host has answered for this model. */
	get levels(): readonly string[] | undefined {
		return this.#levels;
	}

	/** The attached session's working directory, as the host publishes it. */
	get workspace(): WorkspaceState | undefined {
		return this.#workspace?.state.value;
	}

	/** The attached session's shell buffer. */
	get terminal(): TerminalState | undefined {
		return this.#terminal?.state.value;
	}

	async workspaceOpen(path: string): Promise<void> {
		await this.#workspace?.open(path, BACKGROUND_CONTEXT);
	}

	async workspaceRead(path: string): Promise<void> {
		await this.#workspace?.read(path, BACKGROUND_CONTEXT);
	}

	async runTerminal(command: string): Promise<void> {
		const result = await this.#terminal?.run(command, BACKGROUND_CONTEXT);
		if (result !== undefined && !result.ok) {
			this.#renderer.setConnection(
				translate(this.locale, "dock.terminalFailed", {
					error: result.problem,
				}),
				"error",
			);
		}
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
		const result = await commands.run(name, args, BACKGROUND_CONTEXT);
		return result.ok ? { ok: true, message: result.note } : { ok: false, message: result.problem };
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
	 * Make the attached session re-read the settings files, so a change made from the management
	 * panel reaches this running session instead of waiting for its worker to restart.
	 */
	async reloadSettings(): Promise<void> {
		await this.#sessionSettings?.reload(BACKGROUND_CONTEXT);
	}

	/**
	 * Read the levels the host supports for the attached model, once per model. The models state is
	 * replicated, so a switch made anywhere — this page, the TUI, another tab — lands here.
	 */
	async #refreshLevels(paint: () => void): Promise<void> {
		const service = this.#models;
		const configuration = service?.state.value?.configuration.model;
		const model = configuration === undefined || configuration === null ? "" : `${configuration.provider}/${configuration.modelId}`;
		if (service === undefined || model === this.#levelsModel) return;
		this.#levelsModel = model;
		this.#levels = await service.getThinkingLevels(BACKGROUND_CONTEXT);
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
		const hasMcp = (await this.#sessionSource.catalogue(BACKGROUND_CONTEXT)).some(entry => entry.serviceId === Mcp.id);
		const services = this.#sessionSource.open({
			services: [Transcript, AgentController, Models, SessionSettings, Commands, Workspace, Terminal, Conversations, Approvals, ...(hasMcp ? [Mcp] : [])],
			assertAccess(): void {},
			onError: (error: Error) =>
				this.#renderer.setConnection(
					translate(this.locale, "page.streamFailed", {
						error: message(error),
					}),
					"error",
				),
		});
		this.#services = services;
		try {
			await services.ready(BACKGROUND_CONTEXT);
		} catch (error) {
			await this.detach();
			throw error;
		}
		const transcript = services.use(Transcript);
		this.#transcript = transcript.state;
		this.#controller = services.use(AgentController);
		this.#models = services.use(Models);
		this.#mcp = hasMcp ? services.use(Mcp) : undefined;
		this.#mcp?.state.subscribe(() => paint());
		this.#sessionSettings = services.use(SessionSettings);
		this.#commands = services.use(Commands);
		this.#workspace = services.use(Workspace);
		this.#terminal = services.use(Terminal);
		this.#conversations = services.use(Conversations);
		this.#approvals = services.use(Approvals);
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
		await this.#refreshLevels(paint);
		// The catalogue is re-read once per attachment: a plugin that registered a command while this
		// session started is in it, without the reader doing anything.
		await this.refreshCommands().catch(() => undefined);
		paint();
	}

	async detach(): Promise<void> {
		// The bindings go first, then their release: a paint that lands while the release is in
		// flight reads an unattached page instead of a disposed handle.
		const services = this.#services;
		this.#services = undefined;
		this.#transcript = undefined;
		this.#controller = undefined;
		this.#models = undefined;
		this.#mcp = undefined;
		this.#sessionSettings = undefined;
		this.#commands = undefined;
		this.#workspace = undefined;
		this.#terminal = undefined;
		this.#conversations = undefined;
		this.#approvals = undefined;
		this.#levels = undefined;
		this.#levelsModel = undefined;
		this.#sessionId = undefined;
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
	const painter = new SessionPainter(sessionSource, renderer);
	/** The reader's language and palette: the stored preference, or what this browser asks for. */
	let locale: Locale = resolveLocale(manifest.preferences?.locale, navigator.languages);
	let appearance: ThemePreference = resolveThemePreference(manifest.preferences?.appearance);
	const copy = (key: MessageKey, values?: Record<string, string>): string => translate(locale, key, values);
	const serverServices = serverSource.open({
		services: [SessionDirectory, SessionManagement, Settings, Skills, Plugins, Feedback, Diagnostics],
		assertAccess(): void {},
		onError: report,
	});
	const directory = serverServices.use(SessionDirectory);
	const management = serverServices.use(SessionManagement);
	/** The management surface's own services, and the view the main area shows. */
	const settings = serverServices.use(Settings);
	const skills = serverServices.use(Skills);
	const plugins = serverServices.use(Plugins);
	const feedback = serverServices.use(Feedback);
	const diagnostics = serverServices.use(Diagnostics);
	let diagnosticReport: DiagnosticReport | undefined;
	let diagnosticRequest = 0;
	let schedules: SchedulesService | undefined;
	let scheduleServices: RemoteServices | undefined;
	let removeScheduleObserver: (() => void) | undefined;
	let scheduleEpoch = 0;
	let scheduleDiscovery: Promise<void> = Promise.resolve();
	let booted = false;
	const availableViews = (): readonly string[] => ["plugins", "skills", SETTINGS_VIEW, ...(schedules === undefined ? [] : [AUTOMATION_VIEW])];
	let view = CHAT_VIEW;
	let creating = false;
	let modal: PanelModal | undefined;
	/** How the composer submits while a turn runs; the reader picks it in the composer itself. */
	let submitMode: SubmitMode = "followUp";
	/** Images attached but not sent yet, in the order the reader added them. */
	let pending: readonly PendingImage[] = [];
	let attachmentSequence = 0;
	/** The roster's filter text; the page owns it so creating or attaching never clears it. */
	let rosterFilter = "";
	/** The dock: whether it is open, and which tab it shows. Both belong to this page. */
	let dockOpen = false;
	let dockTab = "files";
	/** The stored history the reader paged in, oldest first, above the transcript. */
	let history: readonly EntryRecord[] = [];
	let historyCursor: string | null = null;
	let historyLoading = false;
	let historyRequest = 0;
	/** Whether a page has been asked for; until then "load older" is offered for any history. */
	let historyLoaded = false;
	/** The session's root conversation, once the conversation list has published it. */
	let rootConversationId = "";
	let desiredSessionId: string | undefined;
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

	/**
	 * The commands the composer offers, as the host published them: its own four, the session's
	 * prompt templates, and its skills. `enableSkillCommands` still decides whether skill rows show,
	 * so the switch reaches this page without a worker restart.
	 */
	const composerCommands = (): readonly CommandLike[] => {
		const host = painter.commands;
		const skillsEnabled = settingValue("enableSkillCommands") !== "false";
		const listed = skillsEnabled ? host : host.filter((command) => command.source !== "skill");
		// `/name` is a terminal command in the shared catalogue. This page runs it: the roster reads
		// the name it stores, so the row is runnable here instead of marked terminal-only.
		const rest = listed.filter((command) => command.name !== "name");
		const insertAt = rest.findIndex((command) => command.source !== undefined && command.source !== "builtin");
		const nameCommand: CommandLike = {
			name: "name",
			description: "Set the session display name",
			argumentHint: "[name]",
			source: "builtin",
			availability: "all",
		};
		const index = insertAt === -1 ? rest.length : insertAt;
		return [...rest.slice(0, index), nameCommand, ...rest.slice(index)];
	};

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
	const settingValue = (id: string): string | undefined =>
		settings.state.value?.descriptors.find((descriptor) => descriptor.id === id)?.value;

	/**
	 * The host read the session's command resources when it attached. A skill written, removed, or
	 * imported in the panel, or the skill-command switch, must reach the palette without a worker
	 * restart, so the host re-reads them whenever those inputs move. Templates follow their files:
	 * `/reload` picks up a new one, exactly as the terminal documents it.
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
		// The root id comes from the host's list; the cache keeps submit routing stable across paints.
		rootConversationId = rootId() ?? rootConversationId;
		locale = resolveLocale(settingValue("locale") ?? manifest.preferences?.locale, navigator.languages);
		appearance = resolveThemePreference(settingValue("appearance") ?? manifest.preferences?.appearance);
		painter.locale = locale;
		applyTheme(appearance);
		document.documentElement.lang = documentLanguage(locale);
		refreshCommandResources();
		const built = buildWebView({
					locale,
					creatingSession: creating,
					directory: directory.state.value,
					transcript: shownTranscript(),
					focus: focusedLabel(),
					...(painter.conversations?.lane === undefined ? {} : { lane: painter.conversations.lane }),
					history,
					historyMore: !historyLoaded || historyCursor !== null,
					historyLoading,
					attachedId: client.connected && painter.ready && painter.sessionId === desiredSessionId ? painter.sessionId : undefined,
					now: Date.now(),
					models: painter.modelsValue,
					thinkingLevels: painter.levels,
					submitMode,
					attachments: pending,
					approvals: painter.approvals,
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
						cwd: painter.workspace?.cwd ?? "",
						workspace: painter.workspace,
						terminal: painter.terminal,
						conversations: painter.conversations,
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
						settings: { state: settings.state.value },
						skills: { state: skills.state.value },
						plugins: { state: plugins.state.value, runtime: painter.mcpValue },
						...(schedules === undefined ? {} : { automation: {
							state: schedules.state.value,
							sessionId: painter.sessionId,
							now: Date.now(),
						} }),
						// The page's own management state: what is in flight, and what it last said.
						...(panelPending === undefined ? {} : { pending: panelPending }),
						...(panelNotice === undefined || (view === AUTOMATION_VIEW && schedules?.state.value?.problem) ? {} : { notice: panelNotice }),
						modalPending,
						...(modalNotice === undefined ? {} : { modalNotice }),
					},
				});
		const displayed = reconnectTranscript === undefined ? built : { ...built, ...reconnectTranscript, status: "", busy: false };
		paintSafely(() => renderer.render(withReturnPoints(
			{
				...displayed,
				newSession: { ...displayed.newSession, enabled: client.connected && displayed.newSession.enabled },
			},
			returnPoints,
			painter.conversations?.branchSummarySkipPrompt === true,
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
	directory.state.subscribe(() => paint());
	// A rating given here, or by another tab, repaints the transcript's controls.
	feedback.state.subscribe(() => paint());
	settings.state.subscribe(() => paint());
	skills.state.subscribe(() => paint());
	// The catalogue itself moves when the host re-reads the session's templates and skills.
	painter.commandsState?.subscribe(() => paint());
	plugins.state.subscribe(() => paint());
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
		if (catalogue.some(entry => entry.serviceId === Schedules.id)) {
			const binding = serverSource.open({ services: [Schedules], assertAccess() {}, onError: report });
			scheduleServices = binding;
			try { await binding.ready(BACKGROUND_CONTEXT); }
			catch (error) {
				if (epoch !== scheduleEpoch) { await binding.dispose(BACKGROUND_CONTEXT); return; }
				await clearSchedules(); throw error;
			}
			if (epoch !== scheduleEpoch || leaving || !client.connected) { await binding.dispose(BACKGROUND_CONTEXT); return; }
			schedules = binding.use(Schedules);
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
	const selectSession = (sessionId: string, resume = false): Promise<void> => {
		if (!resume) {
			desiredSessionId = sessionId;
			reconnectTranscript = undefined;
		}
		return transition(async () => {
			if (desiredSessionId !== sessionId) return;
			if (!resume && painter.sessionId === sessionId && painter.ready) {
				paint();
				return;
			}
			saveDraft();
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
				await management.attach(sessionId, BACKGROUND_CONTEXT);
				await sessionSource.whenAttached(sessionId, BACKGROUND_CONTEXT);
				await painter.attach(sessionId, paint);
			});
			if (desiredSessionId !== sessionId) return;
			reconnectTranscript = undefined;
			restoreDraft(sessionId, !resume);
			paint();
			try {
				sessionStorage.setItem(`amazme.session.${manifest.server.id}`, sessionId);
			} catch {
				// Storage may be unavailable in a restricted browser or desktop webview.
			}
		});
	};
	renderer.onSelect = (sessionId) => {
		view = CHAT_VIEW;
		modal = undefined;
		void selectSession(sessionId).catch((error: unknown) => {
			renderer.setConnection(copy("page.attachFailed", { error: message(error) }), "error");
		});
	};
	// The host creates the session; the roster shows it from the replicated directory. A second
	// click while the first create is in flight would make a second session, so this one is one-shot.
	/** Create a session and attach it; one path serves the sidebar's bar and the shortcut. */
	const createSession = (): void => {
		if (creating || !client.connected) return;
		creating = true;
		paint();
		void management
			.create({ reuseEmpty: true }, BACKGROUND_CONTEXT)
			.then(async (created) => {
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
	renderer.onShortcut = (id: ShortcutId) => {
		if (id === "session.new") {
			createSession();
			return;
		}
		if (id === "composer.focus") return;
		// Cycle the main area through the conversation and every management view.
		const views = [CHAT_VIEW, ...panelNav(locale, CHAT_VIEW, availableViews()).map((item) => item.id)];
		const index = views.indexOf(view);
		view = views[(index + 1) % views.length] ?? CHAT_VIEW;
		modal = undefined;
		paint();
	};
	renderer.onSelectModel = (provider, modelId) => {
		void painter.selectModel(provider, modelId).catch((error: unknown) => {
			renderer.setConnection(copy("page.modelChangeFailed", { error: message(error) }), "error");
		});
	};
	renderer.onSelectThinking = (level) => {
		void painter.selectThinking(level).catch((error: unknown) => {
			renderer.setConnection(copy("page.thinkingFailed", { error: message(error) }), "error");
		});
	};
	/**
	 * Add picked, pasted, or dropped images. An image the page cannot send is refused with the
	 * reason instead of being dropped silently, and the rest of the batch still arrives.
	 */
	/**
	 * Follow the draft: a bare `/name` is filtered from the catalogue locally, and an argument is
	 * completed by the host. Answers are sequenced so a slow one cannot land on a newer draft.
	 */
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
	const runNameCommand = (args: string): void => {
		const sessionId = painter.sessionId;
		if (sessionId === undefined) {
			renderer.setConnection(copy("page.nameNeedsSession"), "error");
			return;
		}
		const requested = args.trim();
		if (requested.length === 0) {
			const current = directory.state.value?.sessions.find((session) => session.sessionId === sessionId)?.name;
			const named = current !== undefined && current.length > 0;
			renderer.setConnection(named ? copy("page.sessionName", { name: current }) : copy("page.nameUsage"), named ? "state" : "error");
			return;
		}
		void management.rename(sessionId, requested, BACKGROUND_CONTEXT).then(
			(summary) => {
				const stored = summary.name ?? "";
				renderer.setConnection(
					stored === requested
						? copy("page.sessionNameSet", { name: stored })
						: copy("page.sessionNameNormalized", { from: requested, name: stored }),
					"state",
				);
			},
			(error: unknown) => {
				renderer.setConnection(copy("page.commandFailed", { error: message(error) }), "error");
			},
		);
	};
	const runCommandLine = (name: string, args: string): void => {
		if (name === "name") {
			runNameCommand(args);
			return;
		}
		const command = composerCommands().find((candidate) => candidate.name === name);
		if (command !== undefined && command.source !== "builtin") {
			void painter.expandCommand(name, args).then(
				(expansion) => {
					if (!expansion.ok) {
						renderer.setConnection(expansion.message, "error");
						return;
					}
					const target = targetConversation();
					const focused = target !== undefined && target !== rootConversationId ? target : undefined;
					return painter.submit(expansion.message, submitMode, [], focused);
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
		if (line !== undefined && composerCommands().some((command) => command.name === line.name)) {
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
	let modalPending = false;
	let modalNotice: PanelNotice | undefined;

	const openModal = (spec: PanelModal, opener?: { readonly id: string; readonly data?: string }): void => {
		modal = spec;
		modalOpener = opener;
		modalPending = false;
		modalNotice = undefined;
		panelNotice = undefined;
		paint();
	};

	const closeModal = (): void => {
		diagnosticRequest += 1;
		diagnosticReport = undefined;
		modal = undefined;
		modalPending = false;
		modalNotice = undefined;
		const opener = modalOpener;
		modalOpener = undefined;
		paint();
		if (opener === undefined) return;
		if (opener.id === SESSION_RENAME_ACTION || opener.id === SESSION_REMOVE_ACTION) {
			const trigger = [...document.querySelectorAll<HTMLButtonElement>(".session-more")].find((node) => node.dataset.actionData === opener.data);
			trigger?.focus();
			return;
		}
		const attribute = opener.data === undefined ? `[data-action="${opener.id}"]` : `[data-action="${opener.id}"][data-action-data="${opener.data}"]`;
		try {
			const node = document.querySelector(attribute);
			if (node instanceof HTMLElement) node.focus();
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
	const runPanelCall = (request: {
		readonly id: string;
		readonly data?: string;
		readonly inModal?: boolean;
		readonly closeOnSuccess?: boolean;
		readonly sessionId?: string;
		readonly retry?: boolean;
		readonly call: () => Promise<PanelCallResult | void>;
	}): void => {
		const invocation = ++panelCall;
		const current = () => invocation === panelCall &&
			(request.sessionId === undefined || request.sessionId === painter.sessionId);
		const inModal = request.inModal === true;
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
			},
			(error: unknown) => {
				if (!current()) return;
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
				if (result.cancelled) renderer.setConnection("Branch summarization cancelled", "state");
			}),
		);
	};

	const settle = (operation: Promise<unknown> | undefined): void => {
		if (operation === undefined) return;
		void operation.then(
			() => paint(),
			(error: unknown) => {
				renderer.setConnection(copy("page.panelFailed", { error: message(error) }), "error");
				paint();
			},
		);
	};

	const pluginPackages = (): readonly string[] => plugins.state.value?.packages ?? [];
	const skillOf = (name: string): { readonly editable: boolean } | undefined => skills.state.value?.skills.find((candidate) => candidate.name === name);

	renderer.onPanelAction = (action: PanelAction): void => {
		const schedule = schedules;
		const mcp = painter.mcpService;
		const mcpSession = painter.sessionId;
		const hasMcpServer = (name: string): boolean => mcp !== undefined && painter.mcpValue?.servers.some(server => server.name === name) === true;
		switch (action.kind) {
			case "open":
				if (action.panel === AUTOMATION_VIEW && schedule === undefined) return;
				// The row of the view already open returns to the conversation.
				view = action.panel === view ? CHAT_VIEW : action.panel;
				closeModal();
				return;
			case "modal-close":
				closeModal();
				return;
			case "control":
				if (action.id === SETTINGS_FIELD_ACTION && action.data !== undefined) {
					const id = action.data;
					runPanelCall({
						id: action.id,
						data: id,
						call: () =>
							settings
								.set(id, action.value, BACKGROUND_CONTEXT)
								// A running session holds the settings it loaded, so ask it to re-read them;
								// a session that is already gone is not a settings failure.
								.then(() => painter.reloadSettings().catch(() => undefined))
								.then(() => ({ ok: true as const })),
					});
					return;
				}
				if (action.id === PLUGIN_MCP_ENABLED_ACTION && action.data !== undefined) {
					const name = action.data;
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
					case PLUGIN_MCP_RELOAD_ACTION:
						if (mcp) runPanelCall({ id: action.id, sessionId: mcpSession, retry: false, call: () => mcp.reload(BACKGROUND_CONTEXT).then(done) }); return;
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
						modal = {
							id: PLUGIN_MCP_LOGIN_MODAL, data: action.data,
							title: copy("panel.plugins.pasteRedirect"), description: copy("panel.plugins.redirectHelp"),
							submit: copy("panel.plugins.login"),
							fields: [{ id: "url", label: copy("panel.plugins.pasteRedirect"), kind: "text", value: "" }],
						};
						paint();
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
					case WELCOME_FILES_ACTION:
						dockOpen = true;
						dockTab = "files";
						paint();
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
								if (!result.ok) renderer.setConnection(result.problem, "error");
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
								if (!known) {
									renderer.setConnection(copy("page.queueGone"), "error");
								}
							}),
						);
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
					case LEAVE_ACTION:
					case LEAVE_SUMMARY_ACTION: {
						leaveAt(action.data ?? "", action.id === LEAVE_SUMMARY_ACTION, null);
						return;
					}
					case LEAVE_CUSTOM_ACTION:
						openModal(
							{
								id: LEAVE_CUSTOM_MODAL,
								title: "Summarize branch?",
								description: "Custom instructions are added to the default summary. Leave them empty for the default.",
								data: action.data,
								fields: [
									{
										id: "instructions",
										label: "Custom instructions",
										kind: "textarea",
										value: "",
									},
								],
								submit: "Summarize",
							},
							action,
						);
						return;
					case CONVERSATIONS_REFRESH_ACTION:
						settle(painter.conversationsService?.refresh(BACKGROUND_CONTEXT));
						return;
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
					case WORKSPACE_RELOAD_ACTION: {
						const view = painter.workspace?.view;
						settle(painter.workspaceOpen(view !== undefined && view.kind === "text" ? view.path : (view?.path ?? ".")));
						return;
					}
					case WORKSPACE_OPEN_ACTION:
						settle(painter.workspaceOpen(action.data ?? "."));
						return;
					case WORKSPACE_READ_ACTION:
						settle(painter.workspaceRead(action.data ?? ""));
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
					case SETTINGS_RELOAD_ACTION:
						runPanelCall({
							id: action.id,
							call: () => settings.reload(BACKGROUND_CONTEXT).then(done),
						});
						return;
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
						runPanelCall({
							id: action.id,
							data: sessionId,
							inModal: true,
							call: async () => {
								// A session that was just attached is let go of first, and the removal waits
								// for that to settle: the host releases this attachment either way, and a call
								// in flight across the transition would lose its binding.
								const wasCurrent = painter.sessionId === sessionId;
								if (wasCurrent) {
									saveDraft();
									await painter.detach();
								}
								await management.remove(sessionId, BACKGROUND_CONTEXT);
								sessionDrafts.delete(sessionId);
								if (wasCurrent) {
									draftSessionId = undefined;
									pending = [];
									renderer.setDraft("");
									const next = rosterItems(locale, directory.state.value, undefined, Date.now()).find((item) => item.id !== sessionId);
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
					case PLUGIN_MCP_LOGIN_MODAL: {
						const id = action.data;
						if (id !== undefined && mcp !== undefined) runPanelCall({
							id: action.id, inModal: true, sessionId: mcpSession, retry: false,
							call: async () => {
								if (!await mcp.submitRedirect(id, fields.url ?? "", BACKGROUND_CONTEXT))
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
	 * repaints. Each step is stated on the connection line, so a page that cannot get through says
	 * so rather than looking attached.
	 */
	let retrying: Promise<void> | undefined;
	const retryConnection = (): void => {
		if (leaving || retrying !== undefined) return;
		const wanted = desiredSessionId ?? painter.sessionId;
		retrying = (async () => {
			let waitMs = 500;
			while (!leaving && !client.connected) {
				await new Promise((resolve) => setTimeout(resolve, waitMs));
				if (leaving) return;
				try {
					await client.reconnect();
				} catch (error: unknown) {
					renderer.setConnection(
						(language) => translate(language, "connection.retrying", { error: message(error) }),
						"error",
						(language) => translate(language, "connection.stateDisconnected"),
					);
					waitMs = Math.min(waitMs * 2, 10_000);
				}
			}
			if (!client.connected) return;
			await scheduleDiscovery;
			if (wanted === undefined) return;
			// An attachment lives with the connection, so the reader's session is bound again. The
			// bindings of the old connection are released first: their handles are gone with it.
			for (let attempt = 0; !leaving; attempt += 1) {
				try {
					if (!client.connected) await client.reconnect();
					const target = desiredSessionId ?? wanted;
					await selectSession(target, true);
					if (!client.connected) throw new Error(copy("connection.hostGone"));
					if (painter.sessionId !== desiredSessionId || !painter.ready) continue;
					paint();
					return;
				} catch (error: unknown) {
					if (attempt >= 4 && client.connected) {
						renderer.setConnection(copy("page.attachFailed", { error: message(error) }), "error");
						return;
					}
					renderer.setConnection(
						(language) => translate(language, "connection.retrying", { error: message(error) }),
						"error",
						(language) => translate(language, "connection.stateDisconnected"),
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
		if (change.state === "connected") {
			if (booted) scheduleDiscovery = discoverSchedules().catch(report);
			renderer.setConnection(
				(language) => translate(language, "connection.connected", { id: manifest.server.id }),
				"state",
				(language) => translate(language, "connection.stateConnected"),
			);
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
			renderer.setConnection(
				(language) => translate(language, "connection.disconnected", {
					error: change.error?.message ?? translate(language, "connection.hostGone"),
				}),
				"error",
				(language) => translate(language, "connection.stateDisconnected"),
			);
			paint();
			retryConnection();
			return;
		}
		// Any other state the client reports is its own word for an unfinished connection.
		renderer.setConnection((language) => translate(language, "connection.connecting"), "state");
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
	booted = true;
	// Restore this tab's last selection when it still exists; otherwise use the newest session.
	let remembered: string | null = null;
	try {
		remembered = sessionStorage.getItem(`amazme.session.${manifest.server.id}`);
	} catch {
		// Fall back to the newest session when this browser cannot retain a selection.
	}
	const listed = rosterItems(locale, directory.state.value, undefined, Date.now());
	const initial = listed.find((item) => item.id === remembered) ?? listed[0];
	if (initial !== undefined) {
		await selectSession(initial.id).catch((error: unknown) => {
			renderer.setConnection(copy("page.attachFailed", { error: message(error) }), "error");
		});
	}
	paint();

	globalThis.addEventListener("pagehide", () => {
		leaving = true;
		void clearSchedules().catch(() => {});
		void painter.detach();
		void serverServices.dispose(BACKGROUND_CONTEXT).then(() => client.dispose());
	});
	return client;
}

function fail(renderer: PageRenderer, error: unknown, locale: Locale): void {
	const text = translate(locale, "page.cannotBoot", { error: message(error) });
	renderer.setConnection(text, "error");
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
	if (manifest !== undefined) elements.mode.textContent = `${manifest.mode} · ${manifest.transport.url}`;
	try {
		await startPage(renderer);
	} catch (error) {
		fail(renderer, error, locale);
	}
}

// The page runs when the document loads it. An import outside a document — the transition queue's
// test — leaves it alone rather than failing on a missing DOM.
if (typeof document !== "undefined") void main();
