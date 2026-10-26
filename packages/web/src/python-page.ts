/// <reference lib="dom" />
import * as A from "./actions.ts";
import { commandPalette, parseCommandLine, type CommandLike } from "./commands.ts";
import { dockView, parseWorkspaceAction, type WorkspaceStateLike } from "./dock.ts";
import { documentLanguage, resolveLocale, type Locale } from "./locale.ts";
import { MODEL_ENABLED_ACTION, PROVIDER_EDIT_ACTION, PROVIDER_EDIT_MODAL, PROVIDER_LOGOUT_ACTION, PROVIDER_LOGOUT_MODAL, PROVIDER_SELECT_ACTION, PROVIDER_TEST_ACTION, PROVIDER_TEST_ALL_ACTION, PROVIDER_TEST_MODAL, providerConfigurationModal, providerLogoutModal, providerTestModal, verificationStatusText, type ModelConnectionsLike } from "./model-connections.ts";
import { modelScopeModal } from "./model-scope.ts";
import type { ApprovalPolicy } from "./permission-picker.ts";
import * as P from "./panels.ts";
import * as Projects from "./projects.ts";
import { collectPageElements, createRenderer, type PageRenderer } from "./render.ts";
import { providerAuthModal, providerLoginModal, type ProviderAuthLike } from "./provider-auth.ts";
import { ApiError, definitive, isRecord, parseContract } from "./python-api.ts";
import { PythonClient, type ClientConnection } from "./python-client.ts";
import type { AccountsView, AnswerFeedbackList, ConfigureProvider, CredentialUpdate, HistoryPage, Identity, ImagePart, InterfacePreferences, McpConfiguration, McpState, ModelCatalog, ModelSelection, OAuthView, PluginCallView, PluginPackages, PluginView, ProductSettings, ProjectView, ProviderCheck, ResourceCatalog, ScheduleInput, SchedulesView, ScheduleView, Session, SessionModel, SkillDocument, TerminalView, UsageReport, WorkspaceGrantView } from "./python-contracts.ts";
import { pythonDirectory, pythonView } from "./python-view.ts";
import { PendingWrites, newId } from "./python-writes.ts";
import { seq, settled } from "./python-stream.ts";
import { TerminalInputQueue } from "./python-terminal.ts";
import { followSystemTheme, applyTheme, resolveThemePreference } from "./theme.ts";
import { adjustedFontSizes, DEFAULT_TYPOGRAPHY, FONT_FAMILY_FIELDS, FONT_SIZE_FIELDS, FONT_SIZE_LIMITS, resolveTypography, type Typography } from "./typography.ts";
import { attachmentRejection, attachments, type SubmitMode, type TranscriptBlock } from "./view.ts";
import { toolResultView } from "./tool-results.ts";

const OAUTH_METHODS: Readonly<Record<string, "browser" | "device_code">> = {
	anthropic: "browser", openai: "browser", "openai-codex": "browser", openrouter: "browser", "github-copilot": "device_code", "kimi-coding": "device_code", xai: "device_code", meta: "device_code",
};
interface ImageDraft { readonly id: string; readonly name: string; readonly dataUrl: string; readonly bytes: number; readonly image: ImagePart }
interface Draft { text: string; images: ImageDraft[]; revision: number; submission?: { readonly id: string; readonly revision: number } }
interface ActiveTerminal { readonly connection: ClientConnection; readonly id: string; readonly queue: TerminalInputQueue; view: TerminalView; desiredSize?: { cols: number; rows: number }; resizing: boolean }

function modelReference(value: string): ModelSelection {
	const selected: unknown = JSON.parse(value);
	if (!Array.isArray(selected) || selected.length !== 2) throw new Error("模型选择无效");
	return parseContract("ModelSelection", { provider: selected[0], model: selected[1] });
}

function scheduleRecord(row: ScheduleView): P.ScheduleRecordLike {
	return { id: row.schedule_id, generation: row.generation ?? 1, sessionId: row.session_id, conversationId: "1", prompt: row.text,
		rule: row.rule.kind === "interval" ? { kind: "interval", everyMinutes: row.rule.every_minutes } : row.rule.kind === "once" ? { kind: "once", at: row.rule.at, timeZone: row.rule.time_zone } : { kind: "cron", expression: row.rule.expression, timeZone: row.rule.time_zone },
		busy: row.busy ?? "queue", missed: row.missed ?? "latest", graceMinutes: row.grace_minutes ?? 10, timeoutSeconds: row.timeout_seconds ?? 600,
		enabled: row.enabled ?? true, createdAt: row.created_at, nextRunAt: row.next_run_at,
		pending: row.pending ? { deadlineAt: row.pending.deadline_at, cancelReason: row.pending.cancel_reason ?? null, problem: row.pending.problem ?? null } : null,
		history: row.history?.map(item => ({ startedAt: item.started_at, finishedAt: item.finished_at, scheduledFor: item.scheduled_for ?? null, status: item.status, detail: item.detail ?? null })) ?? [],
	};
}

function pluginPanelState(packages: PluginPackages | undefined, plugins: readonly PluginView[], canLoad: boolean, mcpPath: string): P.PluginsStateLike | undefined {
	if (!packages) return undefined;
	return {
		packages: packages.packages.map(item => item.entry),
		packageDetails: Object.fromEntries(packages.packages.map(item => {
			const runtime = plugins.find(plugin => plugin.package_id === item.package_id);
			const detail = item.phase === "removing" ? "移除等待资源退出，请重试移除"
				: runtime ? `${runtime.phase} · ${runtime.tools?.length ?? 0} 工具${runtime.error ? ` · ${runtime.error}` : ""}`
				: "已配置，将在会话执行时加载";
			return [item.entry, { detail, canLoad: canLoad && item.phase === "installed" }];
		})),
		mcp: { servers: [], errors: [], globalPath: mcpPath },
	};
}

function mcpPanelRuntime(config: McpConfiguration | undefined, state: McpState | undefined, ready: boolean, canConnect: boolean, login?: OAuthView): P.McpRuntimeLike | undefined {
	if (!config) return undefined;
	return { disabled: !ready, canConnect, canOverrideProject: Boolean(config.workspace), errors: [], login: login ? { id: login.login_id, server: login.provider, status: login.phase === "pending" ? login.url ? "awaiting" : "preparing" : login.phase === "complete" ? "done" : "failed", url: login.url || null, error: login.error || null } : null,
		servers: config.servers.map(item => {
			const live = state?.servers.find(server => server.managed_id === item.config_id && server.enabled);
			return { name: item.name, detail: item.detail, state: !item.enabled ? "disabled" : live?.phase === "ready" ? "connected" : live?.phase ?? "disconnected", tools: live?.tools.length ?? 0,
				enabled: item.enabled, exposure: item.exposure, scope: item.scope, canLogin: item.can_login === true, error: live?.phase === "unknown" ? "连接结果待核对；显式重连会先核对原资源退出。" : null };
		}),
	};
}

/** The original DOM surface, driven by the Python HTTP and event boundary. */
export class DesktopPage {
	readonly client: PythonClient;
	readonly renderer: PageRenderer;
	private locale: Locale = resolveLocale("auto", navigator.languages);
	private typography: Typography = { ...DEFAULT_TYPOGRAPHY };
	private sessions: Session[] = [];
	private workspaces: WorkspaceGrantView[] = [];
	private projects: ProjectView[] = [];
	private selectedProject?: string;
	private expandedProjects: readonly string[] = [];
	private sessionEdit?: Session;
	private projectEdit?: ProjectView;
	private skillEdit?: { readonly document: SkillDocument; readonly sessionId: string; readonly modal: P.PanelModal };
	private catalog?: ModelCatalog;
	private accounts: AccountsView = { revision: 0, accounts: [] };
	private settings?: ProductSettings;
	private desktop = false;
	private readonly refreshDesktopPreferences = (): void => {
		if (this.ready) void this.updateSettings(async current => current).catch(() => {});
	};
	private globalModelIds: string[] | null = null;
	private selection?: SessionModel;
	private resources?: ResourceCatalog;
	private usage?: UsageReport;
	private history?: HistoryPage;
	private historyLoading = false;
	private historyGeneration = 0;
	private historyConnection?: ClientConnection;
	private historyLatestRevision = 0n;
	private historyStarted = false;
	private schedules?: SchedulesView;
	private schedulesGeneration = 0;
	private pluginPackages?: PluginPackages;
	private pluginRuntime: PluginView[] = [];
	private pluginsGeneration = 0;
	private mcpConfiguration?: McpConfiguration;
	private mcpRuntime?: McpState;
	private mcpLogin?: OAuthView;
	private mcpLoginTimer?: ReturnType<typeof setTimeout>;
	private mcpLoginGeneration = 0;
	private currentPanel = P.CHAT_VIEW;
	private modal?: P.PanelModal;
	private notice?: P.PanelNotice;
	private pendingModal?: P.PanelModal;
	private get modalPending(): boolean { return this.modal !== undefined && this.pendingModal === this.modal; }
	private rosterFilter = "";
	private draft: Draft = { text: "", images: [], revision: 0 };
	private readonly drafts = new Map<string, Draft>();
	private readonly writes = new Map<string, PendingWrites>();
	private mode: SubmitMode = "followUp";
	private thinking = "off";
	private feedback?: AnswerFeedbackList;
	private readonly providerVerification = new Map<string, ProviderCheck>();
	private readonly checkingProviders = new Set<string>();
	private readonly commandResults = new Map<string, Map<string, { name: string; result: PluginCallView }>>();
	private selectedProvider?: string;
	private enabledModels: string[] | null = null;
	private readonly modelScopes = new Map<string, string[] | null>();
	private providerEdit?: { readonly generation: number; readonly revision: number; readonly configurationRevision: number; configuration?: ConfigureProvider; credentialRevision?: number; credential?: CredentialUpdate };
	private paletteSelection = 0;
	private newSessionPending = false;
	private ready = false;
	private dockOpen = false;
	private dockTab = "files";
	private workspace?: WorkspaceStateLike;
	private oauth?: OAuthView;
	private oauthTimer?: ReturnType<typeof setTimeout>;
	private healthTimer?: ReturnType<typeof setTimeout>;
	private metadataConnection?: ClientConnection;
	private navigationGeneration = 0;
	private modalGeneration = 0;
	private globalLoadGeneration = 0;
	private resourceGeneration = 0;
	private interactionGeneration = 0;
	private selectionGeneration = 0;
	private terminal?: ActiveTerminal;
	private terminalTimer?: ReturnType<typeof setTimeout>;
	private readonly terminalQueues = new Map<string, TerminalInputQueue>();
	private terminalLoadGeneration = 0;
	private workspaceGeneration = 0;
	private settingsQueue = Promise.resolve();
	private get commands(): CommandLike[] {
		const builtins: CommandLike[] = [
			{ name: "new", description: "新建会话", source: "builtin" }, { name: "model", description: "模型与连接", source: "builtin" }, { name: "settings", description: "设置", source: "builtin" },
			{ name: "compact", description: "压缩上下文", source: "builtin" }, { name: "fork", description: "创建分支", source: "builtin" }, { name: "export", description: "导出会话", source: "builtin" },
		];
		const commands = new Map(builtins.map(item => [item.name, item]));
		for (const plugin of this.pluginRuntime) if (plugin.phase === "ready") for (const item of plugin.tools ?? []) if (item.kind === "command" && !commands.has(item.name)) commands.set(item.name, { name: item.name, description: item.description, source: "plugin" });
		for (const item of this.resources?.prompts ?? []) if (!commands.has(item.name)) commands.set(item.name, { name: item.name, description: item.description ?? "", source: "template" });
		for (const item of this.resources?.skills ?? []) commands.set(`skill:${item.name}`, { name: `skill:${item.name}`, description: item.description ?? "", source: "skill" });
		return [...commands.values()];
	}
	constructor(origin = location.origin) {
		this.client = new PythonClient(origin);
		const boot: unknown = Reflect.get(globalThis, "__AMAZME_BOOT__");
		const preferences = parseContract("InterfacePreferences", isRecord(boot) ? boot.preferences ?? {} : {});
		this.applyPreferences(preferences);
		const app = isRecord(boot) && isRecord(boot.app) && typeof boot.app.name === "string" && typeof boot.app.version === "string" ? { name: boot.app.name, version: boot.app.version } : { name: "AmazMe", version: "" };
		this.renderer = createRenderer(collectPageElements(), undefined, app);
		this.client.onStatus = status => {
			this.renderer.setConnectionState({ connecting: "正在连接", connected: "已连接", reconnecting: "正在重连", disconnected: "连接已断开" }[status], status === "connected" ? "connected" : status === "disconnected" ? "disconnected" : "connecting");
		};
		this.client.onError = error => this.error(error);
		this.client.onChange = () => {
			const connection = this.client.connection;
			this.render();
			if (connection?.ready && this.metadataConnection !== connection) {
				this.metadataConnection = connection;
				void this.loadSession(connection).catch(error => { if (connection.active()) this.error(error); });
			}
		};
		const run = (work: () => Promise<void>) => {
			const connection = this.client.connection;
			const generation = ++this.interactionGeneration;
			void work().catch(error => { if (generation === this.interactionGeneration && (!connection || connection.active())) this.error(error); });
		};
		this.renderer.onCreateSession = () => run(() => this.createSession());
		this.renderer.onSelect = id => run(() => this.selectSession(id));
		this.renderer.onSubmit = text => run(() => this.submit(text));
		this.renderer.onAbort = () => run(() => this.cancel());
		this.renderer.onSelectModel = (provider, model) => run(() => this.selectModel(provider, model));
		this.renderer.onSelectThinking = level => { this.thinking = level; this.render(); };
		this.renderer.onSelectPermission = policy => run(async () => {
			const connection = this.requireConnection();
			sessionStorage.setItem(this.permissionKey(connection), policy);
			this.render();
		});
		this.renderer.onDraftChange = text => { this.draft.text = text; this.draft.revision++; this.paletteSelection = 0; this.render(); };
		this.renderer.onPaletteSelection = index => { this.paletteSelection = index; this.render(); };
		this.renderer.onCommandPick = value => { this.draft.text = `/${value} `; this.draft.revision++; this.renderer.setDraft(this.draft.text, true); this.render(); };
		this.renderer.onFilterRoster = text => { this.rosterFilter = text; this.render(); };
		this.renderer.onAttachFiles = files => run(() => this.attachFiles(files));
		this.renderer.onPanelAction = action => run(() => this.action(action));
		this.renderer.onTerminalInput = (id, data) => { const terminal = this.terminal; if (terminal && terminal.id === id && terminal.connection.active()) { try { terminal.queue.enqueue(data); } catch (error) { this.error(error); } } };
		this.renderer.onTerminalResize = (id, cols, rows) => { const terminal = this.terminal; if (terminal && terminal.id === id && terminal.connection.active()) { terminal.desiredSize = { cols, rows }; run(() => this.resizeTerminal(terminal)); } };
		this.renderer.onShortcut = id => {
			if (id === "session.new") run(() => this.createSession());
			else if (id === "run.stop") run(() => this.cancel());
			else if (id.startsWith("font.")) run(() => this.updatePreferences(preferences => ({ ...preferences, ...adjustedFontSizes(resolveTypography(preferences), id === "font.increase" ? "increase" : id === "font.decrease" ? "decrease" : "reset") })));
			else if (id === "view.cycle") { this.dockOpen = !this.dockOpen; this.render(); }
		};
		const bridge: unknown = Reflect.get(globalThis, "amazmeDesktop");
		if (isRecord(bridge) && typeof bridge.pickDirectories === "function") {
			this.desktop = true;
			window.addEventListener("focus", this.refreshDesktopPreferences);
			const pick = bridge.pickDirectories.bind(bridge);
			this.renderer.onPickDirectories = async () => {
				const value: unknown = await pick();
				if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return undefined;
				return value;
			};
		}
		followSystemTheme();
		this.render();
	}
	private error(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.notice = { tone: "error", text: message };
		if (this.modal) this.modal = { ...this.modal, notice: this.notice };
		this.renderer.setConnection(message, "error");
		this.render();
	}
	private requireConnection(): ClientConnection {
		const connection = this.client.connection;
		if (!connection?.ready || !connection.active()) throw new Error("请等待会话连接完成");
		return connection;
	}
	private ledger(connection: ClientConnection): PendingWrites {
		const key = `${connection.identity.profile_id}:${connection.sessionId}`;
		let ledger = this.writes.get(key);
		if (!ledger) { ledger = new PendingWrites(sessionStorage, connection.identity.profile_id, connection.sessionId); this.writes.set(key, ledger); }
		return ledger;
	}
	private hostLedger(identity: Identity): PendingWrites {
		const key = `${identity.profile_id}:`;
		let ledger = this.writes.get(key);
		if (!ledger) { ledger = new PendingWrites(sessionStorage, identity.profile_id, ""); this.writes.set(key, ledger); }
		return ledger;
	}
	async start(): Promise<void> {
		await PendingWrites.restore(sessionStorage);
		await this.client.bootstrap();
		await this.loadGlobal();
		this.ready = true;
		const target = new URLSearchParams(location.search);
		if (target.get("host") && target.get("host") !== this.client.identity?.profile_id) throw new Error("链接属于其他宿主，请从原启动器打开。");
		const sessionId = target.get("session");
		if (sessionId) {
			const session = this.sessions.find(item => item.session_id === sessionId);
			if (!session || (target.get("workspace") && target.get("workspace") !== session.workspace)) throw new Error("链接的会话与工作区不匹配。");
			await this.selectSession(sessionId);
		} else if (target.get("new") === "1") await this.createSession();
		else { const last = this.sessions.find(item => !item.archived); if (last) await this.selectSession(last.session_id); }
		this.render();
	}
	private async loadGlobal(): Promise<void> {
		const generation = ++this.globalLoadGeneration;
		const identity = this.client.identity;
		const connection = this.client.connection, resourcesGeneration = ++this.resourceGeneration;
		const [sessions, workspaces, catalog, accounts, settings, projects, resources] = await Promise.all([
			this.client.call("GET /api/v1/sessions"), this.client.call("GET /api/v1/workspaces"), this.client.call("GET /api/v1/models"), this.client.call("GET /api/v1/accounts"), this.client.call("GET /api/v1/settings"),
			this.client.call("GET /api/v1/projects"),
			this.client.call("GET /api/v1/skills", { query: { session_id: connection?.sessionId ?? "" } }),
		]);
		const globalModelIds = identity ? await this.resolveModelIds(settings.preferences?.enabledModels ?? null, identity, catalog) : null;
		if (generation === this.globalLoadGeneration && identity && this.hostActive(identity)) {
			this.sessions = sessions.sessions; this.workspaces = workspaces.workspaces; this.catalog = catalog; this.accounts = accounts;
			this.projects = projects.projects ?? [];
			if (this.client.connection === connection && resourcesGeneration === this.resourceGeneration) this.resources = resources;
			if ((settings.revision ?? 0) >= (this.settings?.revision ?? 0)) {
				this.settings = settings; this.globalModelIds = globalModelIds; this.applyPreferences(settings.preferences ?? {});
			}
		}
	}
	private async loadSession(connection: ClientConnection): Promise<void> {
		const selectionGeneration = ++this.selectionGeneration;
		const resourceGeneration = ++this.resourceGeneration;
		const [selection, resources, usage, feedback] = await Promise.all([
			this.client.call("GET /api/v1/session-models/{session_id}", { path: { session_id: connection.sessionId } }).catch(error => { if (error instanceof ApiError && error.code === "session_model_missing") return undefined; throw error; }),
			this.client.call("GET /api/v1/sessions/{session}/resources", { path: { session: connection.sessionId } }),
			this.client.call("GET /api/v1/sessions/{session_id}/usage", { path: { session_id: connection.sessionId } }),
			this.client.call("GET /api/v1/sessions/{session}/feedback", { path: { session: connection.sessionId } }),
		]);
		if (!connection.active()) return;
		if (selectionGeneration === this.selectionGeneration) this.selection = selection;
		if (resourceGeneration === this.resourceGeneration) this.resources = resources;
		this.usage = usage;
		this.mergeFeedback(feedback);
		await this.loadPlugins();
		if (!connection.active()) return;
		if (this.pluginPackages?.packages.some(item => item.phase === "installed")) {
			const loaded = await this.client.call("POST /api/v1/sessions/{session_id}/plugin-packages/load", { path: { session_id: connection.sessionId }, connection });
			if (!connection.active()) return;
			this.pluginRuntime = loaded.plugins;
		}
		await this.loadHistory(connection, false);
		if (!connection.active()) return;
		if (this.dockOpen && this.dockTab === "terminal") await this.loadTerminal(connection);
		if (!connection.active()) return;
		this.render();
		clearTimeout(this.healthTimer);
		this.healthTimer = setTimeout(() => { void this.poll(connection); }, 3000);
	}
	private async poll(connection: ClientConnection): Promise<void> {
		if (!connection.active()) return;
		try {
			const health = await this.client.call("GET /api/v1/health");
			if (!connection.active()) return;
			if (health.identity.profile_id !== connection.identity.profile_id) throw new Error("宿主身份已更换");
			if (health.identity.host_epoch !== connection.identity.host_epoch || health.identity.build_id !== connection.identity.build_id) { await this.client.connect(connection.sessionId); return; }
			this.ready = health.state === "ready";
			const feedback = await this.client.call("GET /api/v1/sessions/{session}/feedback", { path: { session: connection.sessionId } });
			if (!connection.active()) return;
			this.mergeFeedback(feedback);
			if (this.currentPanel === P.AUTOMATION_VIEW) await this.loadSchedules();
			if (this.currentPanel === "plugins") await this.loadPlugins();
			this.render();
		} catch (error) { if (connection.active()) this.error(error); }
		finally { if (connection.active()) this.healthTimer = setTimeout(() => { void this.poll(connection); }, 3000); }
	}
	private clearSessionView(): void {
		this.selection = undefined; this.resources = undefined; this.usage = undefined; this.workspace = undefined; this.feedback = undefined;
		this.thinking = this.catalog?.current.thinking ?? "off";
		this.pluginRuntime = []; this.pluginsGeneration++;
		this.mcpConfiguration = undefined; this.mcpRuntime = undefined;
		this.history = undefined; this.historyLatestRevision = 0n; this.historyStarted = false; this.historyGeneration++; this.historyLoading = false;
		this.terminal = undefined; this.terminalLoadGeneration++; clearTimeout(this.terminalTimer);
		this.modal = undefined; this.notice = undefined; this.currentPanel = P.CHAT_VIEW;
		clearTimeout(this.oauthTimer); this.oauth = undefined;
	}
	private async selectSession(id: string): Promise<void> {
		this.navigationGeneration++;
		this.modalGeneration++;
		const session = this.sessions.find(item => item.session_id === id);
		if (!session) throw new Error("会话不存在");
		if (session.prepared === false) throw new Error("分支仍在准备，请先重试原创建请求");
		this.selectedProject = session.project_id || undefined;
		if (this.selectedProject && !this.expandedProjects.includes(this.selectedProject)) this.expandedProjects = [...this.expandedProjects, this.selectedProject];
		const previous = this.client.connection;
		if (previous) this.drafts.set(previous.sessionId, this.draft);
		this.draft = this.drafts.get(id) ?? { text: "", images: [], revision: 0 };
		this.enabledModels = this.sessionModelIds(id);
		this.clearSessionView();
		const url = new URL(location.href);
		url.searchParams.set("host", this.client.identity?.profile_id ?? ""); url.searchParams.set("workspace", session.workspace ?? "primary"); url.searchParams.set("session", id); url.searchParams.delete("new");
		history.replaceState(null, "", url);
		this.renderer.setDraft(this.draft.text);
		await this.client.connect(id);
		if (this.client.connection?.sessionId === id) { this.enabledModels = this.sessionModelIds(id); this.render(); }
	}
	private async createSession(projectId = this.selectedProject): Promise<void> {
		if (this.newSessionPending) return;
		const identity = this.client.identity;
		if (!identity) throw new Error("请先连接后端");
		const navigation = ++this.navigationGeneration;
		const project = this.projects.find(item => item.project_id === projectId && !item.removed);
		const workspace = project?.workspaces?.[0] ?? this.sessions.find(item => item.session_id === this.client.connection?.sessionId)?.workspace ?? new URLSearchParams(location.search).get("workspace") ?? "primary";
		const key = `amazme:create:${identity.profile_id}:${projectId ?? ""}:${workspace}`;
		const id = sessionStorage.getItem(key) ?? newId(); sessionStorage.setItem(key, id);
		this.newSessionPending = true; this.render();
		try {
			const session = await this.client.call("POST /api/v1/sessions", { body: { session_id: id, title: "新会话", workspace, project_id: projectId ?? "" }, identity });
			if (sessionStorage.getItem(key) === id) sessionStorage.removeItem(key);
			await this.loadGlobal();
			if (navigation === this.navigationGeneration) await this.selectSession(session.session_id);
		} finally { this.newSessionPending = false; this.render(); }
	}
	private clearDraft(draft: Draft, revision: number): void {
		if (draft.revision !== revision) return;
		draft.text = ""; draft.images = []; draft.revision++;
		if (this.draft === draft) this.renderer.setDraft("");
	}
	private permissionKey(connection: ClientConnection): string {
		return `amazme:permission:${connection.identity.profile_id}:${connection.sessionId}`;
	}
	private get approvalPolicy(): ApprovalPolicy {
		const connection = this.client.connection;
		const saved = connection ? sessionStorage.getItem(this.permissionKey(connection)) : null;
		return saved === "all" || saved === "mutations" || saved === "auto" ? saved
			: this.client.identity?.approval_policy ?? "mutations";
	}
	private async submit(text: string, expectedRequest?: string): Promise<void> {
		const draft = this.draft, revision = draft.revision, initial = this.client.connection;
		const previous = initial?.ready && initial.active() ? this.ledger(initial).read("submission", "POST /api/v1/sessions/{session}/submissions") : undefined;
		if (expectedRequest && previous?.id !== expectedRequest) throw new Error("原请求已变化，请核对当前记录");
		if (!previous) {
			const command = parseCommandLine(text);
			if (command) {
				const descriptor = this.commands.find(item => item.name === command.name);
				if (!descriptor) throw new Error(`未识别的命令：/${command.name}`);
				if (descriptor.source === "builtin") { await this.command(command.name, command.args); this.clearDraft(draft, revision); this.render(); return; }
				if (descriptor.source === "plugin") { await this.runPluginCommand(command.name, command.args); return; }
			}
		}
		const connection = this.requireConnection(), ledger = this.ledger(connection);
		if (ledger.read("command", "POST /api/v1/sessions/{session_id}/plugins/{plugin_id}/calls")) throw new Error("原插件命令尚未确认，请先重试原命令或核对结果");
		const displayedModel = this.selection ?? this.catalog?.current;
		const root = connection.snapshot?.requests.find(item => item.kind === "root" && !settled.has(item.status));
		const thinking = this.catalog?.models.find(item => item.provider === displayedModel?.provider && item.model === displayedModel.model)?.thinking_levels?.find(level => level === this.thinking);
		const steer = this.mode === "steer" && root?.run_id;
		const record = previous ?? ledger.prepare("submission", "POST /api/v1/sessions/{session}/submissions", id => ({ path: { session: connection.sessionId }, body: {
			request_id: id, text, images: draft.images.map(item => item.image), mode: steer ? "steer" : "queue",
			...(steer ? { target_run_id: steer } : {
				approval_policy: this.approvalPolicy,
				...(displayedModel ? { model_selection: { provider: displayedModel.provider, model: displayedModel.model } } : {}), ...(thinking ? { thinking } : {}),
			}),
		} }));
		if (!previous) draft.submission = { id: record.id, revision };
		const owner = draft.submission?.id === record.id ? draft.submission : undefined;
		this.render();
		try {
			const result = await ledger.send("submission", record, this.client, connection);
			if (owner) this.clearDraft(draft, owner.revision);
			if (result.status !== "unknown" && draft.submission === owner) draft.submission = undefined;
		} finally { if (connection.active()) this.render(); }
	}
	private async cancel(id?: string): Promise<void> {
		const connection = this.requireConnection();
		const request = id ?? connection.snapshot?.requests.find(item => item.kind === "root" && !settled.has(item.status))?.request_id;
		if (!request) return;
		await this.client.call("POST /api/v1/sessions/{session}/requests/{request_id}/cancel", { path: { session: connection.sessionId, request_id: request }, connection });
	}
	private async runPluginCommand(name: string, args: string, expectedCall?: string): Promise<void> {
		const connection = this.requireConnection(), ledger = this.ledger(connection), draft = this.draft;
		let record = ledger.read("command", "POST /api/v1/sessions/{session_id}/plugins/{plugin_id}/calls");
		if (expectedCall && record?.id !== expectedCall) throw new Error("原命令已变化，请核对当前记录");
		if (!record) {
			const plugin = this.pluginRuntime.find(plugin => plugin.phase === "ready" && plugin.tools?.some(tool => tool.kind === "command" && tool.name === name));
			if (!plugin) throw new Error("插件命令尚未加载，请检查插件配置");
			record = ledger.prepare("command", "POST /api/v1/sessions/{session_id}/plugins/{plugin_id}/calls", id => ({ path: { session_id: connection.sessionId, plugin_id: plugin.plugin_id }, body: { kind: "command", call_id: id, name, arguments: { arguments: args }, expected_fingerprint: plugin.fingerprint, expected_load_id: plugin.load_id ?? "" } }));
			draft.submission = { id: record.id, revision: draft.revision };
		}
		const owner = draft.submission?.id === record.id ? draft.submission : undefined;
		this.render();
		const result = await ledger.send("command", record, this.client, connection);
		this.rememberCommand(connection, record.body.name, result);
		if (result.phase === "done" && owner) this.clearDraft(draft, owner.revision);
		if (result.phase !== "unknown" && draft.submission === owner) draft.submission = undefined;
		if (connection.active()) this.render();
	}
	private rememberCommand(connection: ClientConnection, name: string, result: PluginCallView): void {
		const scope = `${connection.identity.profile_id}:${connection.sessionId}`, outputs = this.commandResults.get(scope) ?? new Map<string, { name: string; result: PluginCallView }>();
		outputs.set(result.call_id, { name, result });
		while (outputs.size > 20) { const first = outputs.keys().next().value; if (!first) break; outputs.delete(first); }
		this.commandResults.set(scope, outputs);
	}
	private mergeFeedback(value: AnswerFeedbackList): void {
		if (value.session_id !== this.client.connection?.sessionId) return;
		const records = new Map((this.feedback?.records ?? []).map(record => [record.request_id, record]));
		for (const record of value.records ?? []) if (record.session_id === value.session_id && record.revision >= (records.get(record.request_id)?.revision ?? 0)) records.set(record.request_id, record);
		this.feedback = { session_id: value.session_id, records: [...records.values()] };
	}
	private async selectModel(provider: string, model: string): Promise<void> {
		const connection = this.requireConnection();
		const generation = ++this.selectionGeneration;
		const selection = await this.client.call("PUT /api/v1/session-models/{session_id}", { path: { session_id: connection.sessionId }, body: { session_id: connection.sessionId, provider, model }, connection });
		if (!connection.active() || generation !== this.selectionGeneration) return;
		this.selection = selection; this.thinking = "off"; this.render();
	}
	private async attachFiles(files: readonly File[]): Promise<void> {
		const connection = this.requireConnection(), draft = this.draft;
		for (const file of files) {
			const rejection = attachmentRejection({ mediaType: file.type, bytes: file.size });
			if (rejection) throw new Error(rejection === "composer.attachmentTooLarge" ? "图片不能超过 8 MiB" : "不支持的图片格式");
			const mediaType = file.type;
			if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp" && mediaType !== "image/gif") continue;
			const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败")); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
			draft.images.push({ id: newId(), name: file.name, dataUrl, bytes: file.size, image: { media_type: mediaType, data_base64: dataUrl.slice(dataUrl.indexOf(",") + 1) } });
			draft.revision++;
		}
		if (connection.active() && this.draft === draft) this.render();
	}
	private async command(name: string, args: string): Promise<void> {
		switch (name) {
			case "new": await this.createSession(); break;
			case "model": this.currentPanel = P.SETTINGS_VIEW; this.render(); break;
			case "settings": this.currentPanel = P.SETTINGS_VIEW; this.render(); break;
			case "compact": await this.action({ kind: "command", id: A.COMPACT_ACTION, data: undefined }); break;
			case "fork": await this.fork(); break;
			case "export": {
				const data = await this.client.call("GET /api/v1/export");
				this.download(JSON.stringify(data, null, 2), "amazme-export.json", "application/json"); break;
			}
			default: throw new Error(`未识别的命令：/${name} ${args}`);
		}
	}
	private download(data: string, name: string, type: string): void {
		const url = URL.createObjectURL(new Blob([data], { type })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	private async fork(sessionId = this.requireConnection().sessionId, expectedBranch?: string): Promise<void> {
		const navigation = this.navigationGeneration;
		const session = await this.client.withSession(sessionId, async connection => {
			const ledger = this.ledger(connection);
			let record = ledger.read("branch", "POST /api/v1/sessions/{session}/branches");
			if (expectedBranch && record?.id !== expectedBranch) throw new Error("原分支请求已变化，请核对当前记录");
			if (!record) {
				const snapshot = this.client.connection?.sessionId === sessionId ? this.client.connection.snapshot : await this.client.call("GET /api/v1/sessions/{session}/snapshot", { path: { session: sessionId } });
				const request = snapshot?.requests.findLast(item => item.kind === "root" && item.status === "succeeded");
				if (!request) throw new Error("请先完成一个成功回合");
				record = ledger.prepare("branch", "POST /api/v1/sessions/{session}/branches", id => ({ path: { session: sessionId }, body: { branch_id: id, request_id: request.request_id } }));
			}
			return ledger.send("branch", record, this.client, connection);
		});
		await this.loadGlobal(); if (navigation === this.navigationGeneration) await this.selectSession(session.session_id);
	}
	private async action(action: P.PanelAction): Promise<void> {
		this.notice = undefined;
		if (action.kind === "open" || action.kind === "modal-close" || (action.kind === "command" && ![A.PROVIDER_AUTH_OPEN_ACTION, A.PROVIDER_AUTH_CANCEL_ACTION].includes(action.id))) {
			this.modalGeneration++;
			this.providerEdit = undefined;
			clearTimeout(this.oauthTimer);
		}
		if (action.kind === "open") { this.currentPanel = action.panel; this.modal = undefined; this.render(); if (action.panel === P.AUTOMATION_VIEW) await this.loadSchedules(); if (action.panel === "plugins") await this.loadPlugins(); this.render(); return; }
		if (action.kind === "modal-close") { this.modal = undefined; this.render(); return; }
		const id = action.id, data = action.data;
		const fields = action.kind === "modal-submit" ? action.fields : {};
		const value = action.kind === "control" ? action.value : data ?? "";
		if (await this.managementAction(id, data, fields)) return;
		if (await this.skillAction(action)) return;
		if (await this.scheduleAction(action)) return;
		if (await this.pluginAction(action)) return;
		if (await this.mcpAction(action)) return;
		if (id === A.HISTORY_MORE_ACTION || id === A.TRANSCRIPT_SEARCH_ACTION) {
			await this.loadHistory(this.requireConnection(), true, id === A.TRANSCRIPT_SEARCH_ACTION);
			if (id === A.TRANSCRIPT_SEARCH_ACTION) this.renderer.refreshTranscriptSearch();
			return;
		}
		if (id === A.WELCOME_SESSION_ACTION) { await this.createSession(); return; }
		if (id === A.WELCOME_SETTINGS_ACTION || id === A.MODEL_CONNECTIONS_ACTION) { this.currentPanel = P.SETTINGS_VIEW; this.modal = undefined; this.render(); return; }
		if (id === A.WELCOME_DISMISS_ACTION) { await this.setPreference("showWelcome", "false"); return; }
		if (id === A.DOCK_TOGGLE_ACTION) { this.dockOpen = !this.dockOpen; if (this.dockOpen && this.dockTab === "files" && !this.workspace) await this.openWorkspace(); this.render(); return; }
		if (id === A.DOCK_TAB_ACTION) { this.dockTab = value; this.dockOpen = true; if (value === "files" && !this.workspace) await this.openWorkspace(); if (value === "terminal") await this.loadTerminal(this.requireConnection(), true); this.render(); return; }
		if (id === A.WORKSPACE_OPEN_ACTION || id === A.WORKSPACE_READ_ACTION) { await this.openWorkspace(value, id === A.WORKSPACE_READ_ACTION); return; }
		if (id === A.WORKSPACE_RELOAD_ACTION || id === A.WORKSPACE_PAGE_ACTION) { const target = parseWorkspaceAction(data); await this.openWorkspace(target.path, target.kind === "read", target.offset); return; }
		if (id === A.SUBMIT_MODE_ACTION) { this.mode = value === "steer" ? "steer" : "followUp"; this.render(); return; }
		if (id === A.ATTACHMENT_REMOVE_ACTION) { this.draft.images = this.draft.images.filter(item => item.id !== data); this.draft.revision++; this.render(); return; }
		if (id === A.QUEUE_CANCEL_ACTION) { await this.cancel(data); return; }
		if (id === "effect:cleanup") {
			const connection = this.requireConnection(), target: unknown = JSON.parse(data ?? "null");
			if (!Array.isArray(target) || target[0] !== connection.sessionId || typeof target[1] !== "string" || !/^[a-f0-9]{64}$/.test(target[1])) throw new Error("脚本不属于当前会话");
			const hold = connection.snapshot?.effects?.find(item => item.call_id === target[1] && item.reason === "codemode_outcome_unknown" && !item.reconciled);
			if (!hold) throw new Error("原脚本状态已变化，请核对当前记录");
			await this.client.call("POST /api/v1/sessions/{session_id}/code/{run_id}/cancel", { path: { session_id: connection.sessionId, run_id: hold.call_id.slice(0, 32) }, connection });
			await this.client.call("GET /api/v1/sessions/{session}/snapshot", { path: { session: connection.sessionId } });
			if (connection.active()) this.render(); return;
		}
		if (id === "effect:review" || id === "effect:resolve") {
			const connection = this.requireConnection(), target: unknown = JSON.parse(data ?? "null");
			if (!Array.isArray(target) || target.length !== 2 || target[0] !== connection.sessionId || typeof target[1] !== "string") throw new Error("核对操作不属于当前会话");
			const hold = connection.snapshot?.effects?.find(item => item.call_id === target[1] && !item.reconciled);
			if (!hold || !hold.resource_clean) throw new Error("请先等待原资源退出并核对当前状态");
			if (id === "effect:review") {
				this.modal = { id: "effect:resolve", data, title: "核对执行效果", description: "根据本机文件或外部系统的实际状态填写证据。核对不会重新执行原调用。", submit: "提交核对", fields: [
					{ id: "outcome", label: "实际效果", kind: "select", value: "", options: [{ value: "", label: "请选择核对结果" }, { value: "applied", label: "效果已发生" }, { value: "not_applied", label: "确认效果未发生" }] },
					{ id: "evidence", label: "核对证据", kind: "textarea", value: "" },
				] }; this.render(); return;
			}
			const modal = this.modal;
			if (action.kind !== "modal-submit" || modal?.id !== id || modal.data !== data) return;
			const ledger = this.ledger(connection), key = `resolution:${hold.call_id}`;
			const record = ledger.prepare(key, "POST /api/v1/sessions/{session}/effects/resolve", resolution => ({ path: { session: connection.sessionId }, body: parseContract("EffectResolution", { resolution_id: resolution, call_id: hold.call_id, outcome: fields.outcome, evidence: fields.evidence?.trim() ?? "" }) }));
			await ledger.send(key, record, this.client, connection);
			if (connection.active() && this.modal === modal) { this.modal = undefined; this.render(); }
			return;
		}
		if (id === A.FEEDBACK_UP_ACTION || id === A.FEEDBACK_DOWN_ACTION || id === "write:retry-feedback") {
			const connection = this.requireConnection(), target: unknown = JSON.parse(data ?? "null");
			if (!Array.isArray(target) || target[0] !== connection.sessionId || typeof target[1] !== "string") throw new Error("反馈不属于当前答案，请刷新后重试");
			const ledger = this.ledger(connection), key = `feedback:${target[1]}`;
			let record = ledger.read(key, "POST /api/v1/sessions/{session}/feedback");
			if (id === "write:retry-feedback") {
				if (target.length !== 3 || !record || record.id !== target[2]) throw new Error("原反馈请求已变化，请核对当前记录");
			} else {
				if (target.length !== 4 || ![null, "up", "down"].includes(target[2])) throw new Error("答案反馈无效");
				const rating = id === A.FEEDBACK_UP_ACTION ? "up" : "down";
				const value = parseContract("AnswerFeedbackWrite", { operation_id: newId(), request_id: target[1], rating: target[2] === rating ? null : rating, expected_revision: target[3] });
				record ??= ledger.prepare(key, "POST /api/v1/sessions/{session}/feedback", operation => ({ path: { session: connection.sessionId }, body: { ...value, operation_id: operation } }));
			}
			const result = await ledger.send(key, record, this.client, connection);
			if (connection.active()) { this.mergeFeedback({ session_id: connection.sessionId, records: [result] }); this.render(); }
			return;
		}
		if (id === A.TERMINAL_RUN_ACTION) {
			const connection = this.requireConnection();
			if (!this.terminal || this.terminal.connection !== connection || this.terminal.view.phase !== "running") await this.loadTerminal(connection, true);
			if (value.trim() && this.terminal?.connection === connection) this.terminal.queue.enqueue(value + "\r");
			return;
		}
		if (id === A.TERMINAL_STOP_ACTION && this.terminal) {
			const terminal = this.terminal;
			const view = await this.client.call("POST /api/v1/sessions/{session_id}/terminals/{terminal_id}/close", { path: { session_id: terminal.connection.sessionId, terminal_id: terminal.id }, connection: terminal.connection });
			if (terminal.connection.active() && this.terminal === terminal) { this.observeTerminal(terminal, view); this.render(); } return;
		}
		if (id === "terminal:retry") { this.terminal?.queue.retry(); return; }
		if (id === "terminal:confirm") { this.modal = { id: "terminal:confirm-submit", title: "核对终端输入", description: "确认已经核对终端内容后，清除这些未确认输入；不会重新发送它们。", fields: [], submit: "已核对，继续", data: this.terminal?.id }; this.render(); return; }
		if (id === "terminal:confirm-submit" && this.terminal && data === this.terminal.id) { this.terminal.queue.confirm(); this.modal = undefined; this.render(); return; }
		if (id === "write:retry-submit") { if (!data) throw new Error("缺少原请求编号"); await this.submit(this.draft.text, data); return; }
		if (id === "write:retry-command") { if (!data) throw new Error("缺少原命令编号"); await this.runPluginCommand("", "", data); return; }
		if (id === "write:cancel-command") {
			const connection = this.requireConnection(), ledger = this.ledger(connection), record = ledger.read("command", "POST /api/v1/sessions/{session_id}/plugins/{plugin_id}/calls");
			if (!record || record.id !== data || typeof record.path.plugin_id !== "string") throw new Error("原命令已变化，请核对当前记录");
			const result = await this.client.call("POST /api/v1/sessions/{session_id}/plugins/{plugin_id}/calls/{call_id}/cancel", { path: { session_id: connection.sessionId, plugin_id: record.path.plugin_id, call_id: record.id }, connection });
			this.rememberCommand(connection, record.body.name, result);
			if (result.phase !== "unknown" && result.clean) await ledger.forget("command", record);
			if (connection.active()) this.render(); return;
		}
		if (id === "write:cancel-submit") {
			const connection = this.requireConnection(), ledger = this.ledger(connection);
			const record = ledger.read("submission", "POST /api/v1/sessions/{session}/submissions");
			if (record?.id !== data) throw new Error("原请求已变化，请核对当前记录");
			if (record) { await this.cancel(record.body.request_id); await ledger.forget("submission", record); if (connection.active()) this.render(); }
			return;
		}
		if (id === A.CONVERSATION_FORK_ACTION) { await this.fork(data); return; }
		if (id === "write:retry-branch") { if (!data) throw new Error("缺少原分支编号"); await this.fork(this.requireConnection().sessionId, data); return; }
		if (id === A.COMPACT_ACTION) { this.modal = { ...P.compactModal(this.locale), data: this.requireConnection().sessionId }; this.render(); return; }
		if (id === A.COMPACT_MODAL) {
			const connection = this.requireConnection(), ledger = this.ledger(connection), modal = this.modal;
			if (action.kind !== "modal-submit" || modal?.id !== id || modal.data !== data || data !== connection.sessionId) return;
			let record = ledger.read("compaction", "POST /api/v1/sessions/{session}/compactions");
			if (!record) {
				const through = connection.snapshot?.requests.findLast(item => item.kind === "root" && item.status === "succeeded");
				if (!through) throw new Error("没有可压缩的成功回合");
				record = ledger.prepare("compaction", "POST /api/v1/sessions/{session}/compactions", id => ({ path: { session: connection.sessionId }, body: { compaction_id: id, through_request_id: through.request_id, instructions: fields.instructions ?? "" } }));
			}
			await ledger.send("compaction", record, this.client, connection); if (connection.active() && this.modal === modal) { this.modal = undefined; this.render(); } return;
		}
		if (id === A.APPROVAL_APPROVE_ACTION || id === A.APPROVAL_DENY_ACTION) {
			const connection = this.requireConnection(), ledger = this.ledger(connection);
			const proposal = connection.snapshot?.approvals?.find(item => item.approval_id === data && item.state === "pending");
			if (!proposal) throw new Error("审批提案已变化，请核对当前记录");
			const key = `approval:${proposal.approval_id}`;
			const record = ledger.prepare(key, "POST /api/v1/sessions/{session}/approvals", id => ({ path: { session: connection.sessionId }, body: { decision_id: id, approval_id: proposal.approval_id, expected_revision: proposal.revision, proposal_digest: proposal.proposal_digest, approve: action.id === A.APPROVAL_APPROVE_ACTION } }));
			if (record.body.approve !== (id === A.APPROVAL_APPROVE_ACTION)) throw new Error("原审批决定尚未确认；请先重试原决定。");
			await ledger.send(key, record, this.client, connection); return;
		}
		if (id === A.MODEL_SELECT_ACTION) { const selected = modelReference(value); await this.selectModel(selected.provider, selected.model); return; }
		if (id === A.MODEL_THINKING_ACTION) { this.thinking = value; this.render(); return; }
		if (id === A.REFRESH_MODELS_ACTION || id === P.SETTINGS_RELOAD_ACTION || id === A.SESSION_RELOAD_ACTION) { await this.loadGlobal(); const connection = this.client.connection; if (connection?.ready) await this.loadSession(connection); this.render(); return; }
		if (id === A.MODEL_SCOPE_ACTION) {
			const available = this.connections().enabledModels;
			if (available.length === 0) { this.currentPanel = P.SETTINGS_VIEW; this.modal = undefined; }
			else this.modal = modelScopeModal(this.locale, { allModels: available.map(item => ({ provider: item.provider, id: item.modelId, name: item.name })), enabledModelIds: this.enabledModels });
			this.render(); return;
		}
		if (id === A.MODEL_SCOPE_MODAL) {
			const connection = this.requireConnection(), modal = this.modal;
			if (action.kind !== "modal-submit" || modal?.id !== id || this.modalPending) return;
			const ids = parseContract("InterfacePreferences", { enabledModels: JSON.parse(fields.models || "null") }).enabledModels ?? null;
			this.modelScopes.set(`${connection.identity.profile_id}:${connection.sessionId}`, ids);
			this.enabledModels = ids;
			if (fields.persist !== "true") { if (this.modal === modal) this.modal = undefined; this.render(); return; }
			this.pendingModal = modal; this.render();
			try {
				await this.updatePreferences(current => ({ ...current, enabledModels: ids }));
				if (connection.active() && this.modal === modal) this.modal = undefined;
			} finally {
				if (this.pendingModal === modal) this.pendingModal = undefined;
				if (connection.active()) this.render();
			}
			return;
		}
		if (id === A.MODEL_DEFAULTS_ACTION) {
			const identity = this.client.identity;
			if (!identity || !this.catalog) throw new Error("请先连接后端");
			const selected = data ? modelReference(data) : this.selection ?? this.catalog.current;
			const model = this.catalog.models.find(item => item.provider === selected.provider && item.model === selected.model);
			if (!model) throw new Error("模型不可用");
			const levels = model.thinking_levels ?? ["off"], thinking = levels.find(level => level === this.thinking) ?? levels[0] ?? "off";
			await this.client.call("POST /api/v1/models", { body: parseContract("UpdateModelSettings", { provider: selected.provider, model: selected.model, api: model.api ?? "openai-completions", base_url: model.base_url ?? "", thinking }), identity });
			await this.loadGlobal(); return;
		}
		if (id === PROVIDER_SELECT_ACTION) { this.selectedProvider = data; this.render(); return; }
		if (id === PROVIDER_EDIT_ACTION) {
			this.oauth = undefined;
			const connections = this.connections(), provider = connections.state.providers.find(item => item.id === data);
			this.modal = providerConfigurationModal(this.locale, provider, connections.models, connections.state.authentication.providers, provider ? connections.state.authentication.providers.find(item => item.id === provider.id)?.methods ?? [] : []);
			const identity = this.client.identity, raw = identity && provider ? sessionStorage.getItem(`amazme:provider:${identity.profile_id}:${provider.id}`) : null;
			if (raw) {
				const previous = parseContract("ConfigureProvider", JSON.parse(raw));
				this.modal = { ...this.modal, notice: { tone: "info", text: "上次配置尚待确认；提交将沿用原编号和内容。" }, fields: this.modal.fields.map(field => {
					const values: Readonly<Record<string, string>> = { name: previous.name ?? previous.provider, baseUrl: previous.base_url, api: previous.api, models: previous.model_ids?.join("\n") ?? "" };
					return field.id in values ? { ...field, value: values[field.id], readOnly: true } : field;
				}) };
			}
			this.providerEdit = { generation: this.modalGeneration, revision: this.accounts.revision, configurationRevision: this.catalog?.configuration_revision ?? 0 };
			this.render(); return;
		}
		if (id === PROVIDER_LOGOUT_ACTION) { this.oauth = undefined; this.modal = providerLogoutModal(this.locale, data ?? "", data ?? ""); this.providerEdit = { generation: this.modalGeneration, revision: this.accounts.revision, configurationRevision: this.catalog?.configuration_revision ?? 0 }; this.render(); return; }
		if (id === PROVIDER_EDIT_MODAL || id === PROVIDER_LOGOUT_MODAL) { if (this.modal?.id !== id || this.modal.data !== data) return; await this.saveProvider(data, fields, id === PROVIDER_LOGOUT_MODAL); return; }
		if (id === A.PROVIDER_AUTH_OPEN_ACTION) { if (!data || !/^https?:\/\//.test(data)) throw new Error("授权链接无效"); window.open(data, "_blank", "noopener,noreferrer"); return; }
		if (id === A.PROVIDER_AUTH_ACTION) { this.oauth = undefined; this.modal = providerAuthModal(this.locale, this.authentication(), data); this.providerEdit = { generation: this.modalGeneration, revision: this.accounts.revision, configurationRevision: this.catalog?.configuration_revision ?? 0 }; this.render(); return; }
		if (id === A.PROVIDER_AUTH_CANCEL_ACTION) {
			const login = this.oauth, identity = this.client.identity, generation = this.modalGeneration;
			if (!identity || !login || data !== login.login_id) return;
			const result = await this.client.call("DELETE /api/v1/accounts/oauth/{login_id}", { path: { login_id: login.login_id }, identity });
			if (result.login_id !== login.login_id || result.provider !== login.provider) throw new Error("授权回执归属不匹配，原记录已保留");
			this.forgetOAuth(identity, result);
			if (this.hostActive(identity) && this.oauth === login && generation === this.modalGeneration) {
				if (result.phase === "pending" || result.phase === "unknown") this.showOAuth(identity, result, generation);
				else { this.oauth = undefined; this.modal = undefined; clearTimeout(this.oauthTimer); this.render(); }
			}
			return;
		}
		if (id === A.PROVIDER_AUTH_MODAL) {
			if (this.modal?.id !== id || this.modal.data !== data) return;
			if (this.oauth) { const login = this.oauth, identity = this.client.identity; if (!identity) return; await this.client.call("POST /api/v1/accounts/oauth/{login_id}/input", { path: { login_id: login.login_id }, body: { value: fields.value ?? "" }, identity }); return; }
			const provider = fields.provider, method = fields[`method:${provider}`];
			if (method === "oauth" || method === "logout") { await this.saveProvider(provider, fields, method === "logout"); return; }
			const state = this.connections(), target = state.state.providers.find(item => item.id === provider);
			if (!target) throw new Error("供应商不可用");
			this.modal = providerConfigurationModal(this.locale, target, state.models, state.state.authentication.providers, state.state.authentication.providers.find(item => item.id === provider)?.methods ?? []);
			this.render(); return;
		}
		if (id === MODEL_ENABLED_ACTION) {
			const reference = modelReference(data ?? ""), key = `${reference.provider}/${reference.model}`;
			const all = this.catalog?.models.map(item => `${item.provider}/${item.model}`) ?? [];
			await this.updateSettings(async (current, identity) => {
				const selected = new Set(await this.resolveModelIds(current.preferences?.enabledModels ?? null, identity) ?? all);
				if (value === "true") selected.add(key); else selected.delete(key);
				const preferences = parseContract("InterfacePreferences", { ...current.preferences, enabledModels: [...selected] });
				return this.client.call("PUT /api/v1/settings/preferences", { body: { preferences, expected_revision: current.revision ?? 0 }, identity });
			});
			return;
		}
		if (id === PROVIDER_TEST_ACTION) {
			const state = this.connections(), provider = state.state.providers.find(item => item.id === data);
			if (!provider?.configured) throw new Error("请先配置供应商账号");
			const models = (this.catalog?.models ?? []).filter(item => item.provider === provider.id).map(item => ({ provider: item.provider, modelId: item.model, name: item.label, available: true }));
			const modal = providerTestModal(this.locale, models, true);
			this.modal = { ...modal, data: provider.id, actions: modal.actions?.map(action => ({ ...action, data: provider.id })) }; this.render(); return;
		}
		if (id === PROVIDER_TEST_MODAL || id === PROVIDER_TEST_ALL_ACTION) { await this.checkProvider(data, id === PROVIDER_TEST_ALL_ACTION ? undefined : fields.model); return; }
		if (id === P.SETTINGS_FIELD_ACTION) { await this.setPreference(data ?? "", value); return; }
		if (id === P.DIAGNOSTICS_ACTION) { const connection = this.requireConnection(); const report = await this.client.call("GET /api/v1/sessions/{session_id}/diagnostics", { path: { session_id: connection.sessionId } }); if (connection.active()) { this.modal = { id: "diagnostics:close", title: "诊断", fields: [{ id: "report", label: "会话诊断", kind: "textarea", readOnly: true, value: JSON.stringify(report, null, 2) }] }; this.render(); } return; }
		throw new Error(`入口尚未接通：${id}`);
	}
	private async managementAction(id: string, data: string | undefined, fields: Readonly<Record<string, string>>): Promise<boolean> {
		const session = this.sessions.find(item => item.session_id === data);
		const project = this.projects.find(item => item.project_id === data);
		if (id === A.SESSION_COPY_ID_ACTION && data) { await navigator.clipboard.writeText(data); return true; }
		if (id === A.SESSION_REMOVE_ACTION) {
			if (!session) throw new Error("会话不存在");
			this.modal = P.removeSessionModal(this.locale, session.session_id); this.render(); return true;
		}
		if (id === A.SESSION_REMOVE_MODAL && data) {
			const identity = this.client.identity, modal = this.modal, navigation = this.navigationGeneration;
			if (!identity || modal?.id !== id || modal.data !== data) return true;
			await this.client.call("DELETE /api/v1/sessions/{session}", { path: { session: data }, identity });
			if (!this.hostActive(identity)) return true;
			this.globalLoadGeneration++;
			this.sessions = this.sessions.filter(item => item.session_id !== data);
			this.drafts.delete(data);
			const url = new URL(location.href);
			const removedCurrent = this.client.connection?.sessionId === data || url.searchParams.get("session") === data;
			if (removedCurrent) {
				this.modalGeneration++;
				this.client.retire(); clearTimeout(this.healthTimer); this.clearSessionView();
				this.draft = { text: "", images: [], revision: 0 }; this.renderer.setDraft("");
				url.searchParams.delete("session"); history.replaceState(null, "", url);
			}
			if (this.modal === modal) this.modal = undefined;
			this.render();
			await this.loadGlobal();
			if (navigation === this.navigationGeneration && removedCurrent && !this.client.connection) {
				const next = this.sessions.findLast(item => !item.archived && item.project_id === session?.project_id);
				if (next) await this.selectSession(next.session_id);
			}
			this.render(); return true;
		}
		if (id === A.SESSION_RENAME_ACTION || id === A.CONVERSATION_RENAME_ACTION) {
			if (!session) throw new Error("会话不存在");
			this.sessionEdit = session; this.modal = P.renameSessionModal(this.locale, session.session_id, session.title); this.render(); return true;
		}
		if (id === A.SESSION_RENAME_MODAL) {
			const original = this.sessionEdit, modal = this.modal;
			if (!original || original.session_id !== data || modal?.id !== id) return true;
			await this.client.withSession(original.session_id, connection => this.client.call("PUT /api/v1/sessions/{session}/title", {
				path: { session: original.session_id }, body: { title: fields.name ?? "", expected_title: original.title }, connection,
			}));
			await this.loadGlobal(); if (this.modal === modal) this.modal = undefined; this.render(); return true;
		}
		if (id === Projects.SESSION_ARCHIVE_ACTION || id === A.CONVERSATION_ARCHIVE_ACTION) {
			if (!session) throw new Error("会话不存在");
			this.modal = Projects.archiveSessionModal(this.locale, session.session_id); this.render(); return true;
		}
		if (id === Projects.SESSION_ARCHIVE_MODAL || id === Projects.SESSION_RESTORE_ACTION || id === A.CONVERSATION_RESTORE_ACTION) {
			if (!session) throw new Error("会话不存在");
			const modal = this.modal;
			await this.client.withSession(session.session_id, connection => this.client.call("POST /api/v1/sessions/{session}/archive", {
				path: { session: session.session_id }, body: { archived: id === Projects.SESSION_ARCHIVE_MODAL }, connection,
			}));
			await this.loadGlobal(); if (this.modal === modal) this.modal = undefined; this.render(); return true;
		}
		if (id === Projects.SESSION_ARCHIVE_OPEN_ACTION || id === A.CONVERSATION_SELECT_ACTION) { if (data) await this.selectSession(data); return true; }
		if (id === A.CONVERSATIONS_REFRESH_ACTION) { await this.loadGlobal(); this.render(); return true; }
		if (id === Projects.PROJECT_SELECT_ACTION) { if (!project) throw new Error("项目不存在"); this.selectedProject = project.project_id; this.expandedProjects = Projects.toggleExpandedProjects(this.expandedProjects, project.project_id); this.render(); return true; }
		if (id === Projects.PROJECT_NEW_SESSION_ACTION) { await this.createSession(data); return true; }
		if (id === Projects.PROJECT_ADD_ACTION) { this.projectEdit = undefined; this.modal = Projects.addProjectModal(this.locale); this.render(); return true; }
		if (id === Projects.PROJECT_EDIT_ACTION || id === Projects.PROJECT_RENAME_ACTION || id === Projects.PROJECT_REMOVE_ACTION) {
			if (!project) throw new Error("项目不存在");
			this.projectEdit = project;
			const paths = project.workspaces?.map(name => this.workspaces.find(item => item.name === name)?.host_path ?? "") ?? [];
			this.modal = id === Projects.PROJECT_EDIT_ACTION ? Projects.editProjectModal(this.locale, { id: project.project_id, name: project.name, cwd: paths[0] ?? "", workspaces: paths }) : id === Projects.PROJECT_RENAME_ACTION ? Projects.renameProjectModal(this.locale, project.project_id, project.name) : Projects.removeProjectModal(this.locale, project.project_id, project.name);
			this.render(); return true;
		}
		if ([Projects.PROJECT_ADD_MODAL, Projects.PROJECT_EDIT_MODAL, Projects.PROJECT_RENAME_MODAL, Projects.PROJECT_REMOVE_MODAL].includes(id)) {
			const identity = this.client.identity, modal = this.modal, original = this.projectEdit;
			if (!identity || modal?.id !== id || (id !== Projects.PROJECT_ADD_MODAL && (!original || original.project_id !== data))) return true;
			let workspaces = original?.workspaces ?? ["primary"];
			if (id === Projects.PROJECT_ADD_MODAL || id === Projects.PROJECT_EDIT_MODAL) {
				const paths: unknown = JSON.parse(fields.workspaces ?? "[]");
				if (!Array.isArray(paths) || !paths.length || !paths.every(item => typeof item === "string" && item.startsWith("/"))) throw new Error("请选择项目目录");
				workspaces = [];
				for (const path of paths) { const grant = await this.client.call("POST /api/v1/workspaces/select", { body: { host_path: path }, identity }); workspaces.push(grant.name); }
			}
			if (id === Projects.PROJECT_ADD_MODAL) {
				const key = `amazme:project:${identity.profile_id}`, previous = sessionStorage.getItem(key);
				const record = parseContract("ProjectWrite", previous ? JSON.parse(previous) : { project_id: newId(), name: fields.name ?? "", workspaces });
				sessionStorage.setItem(key, JSON.stringify(record));
				const created = await this.client.call("POST /api/v1/projects", { body: record, identity });
				if (sessionStorage.getItem(key) === JSON.stringify(record)) sessionStorage.removeItem(key);
				if (this.modal === modal) { this.selectedProject = created.project_id; this.expandedProjects = [...this.expandedProjects, created.project_id]; }
			} else if (original) await this.client.call("PUT /api/v1/projects/{project_id}", { path: { project_id: original.project_id }, body: {
				name: fields.name ?? original.name, workspaces, expected_revision: original.revision ?? 0, removed: id === Projects.PROJECT_REMOVE_MODAL,
			}, identity });
			await this.loadGlobal(); if (this.modal === modal) this.modal = undefined; this.render(); return true;
		}
		return false;
	}
	private async skillAction(action: P.PanelAction): Promise<boolean> {
		if (action.kind === "open" || action.kind === "modal-close") return false;
		const { id, data } = action, fields = action.kind === "modal-submit" ? action.fields : {};
		const connection = this.client.connection, identity = this.client.identity, navigation = this.navigationGeneration;
		const query = { session_id: connection?.sessionId ?? "" }, modal = this.modal;
		const current = () => this.client.identity === identity && navigation === this.navigationGeneration && this.modal === modal;
		if (id === P.SKILL_NEW_ACTION) { this.skillEdit = undefined; this.modal = P.newSkillModal(this.locale); this.render(); return true; }
		if (id === P.SKILL_IMPORT_ACTION) { this.skillEdit = undefined; this.modal = P.importSkillModal(this.locale); this.render(); return true; }
		if ((id === P.SKILL_EDIT_ACTION || id === P.SKILL_REMOVE_ACTION) && action.kind === "command") {
			const document = await this.client.call("GET /api/v1/skills/{name}", { path: { name: data ?? "" }, query });
			if (!current()) return true;
			this.modal = id === P.SKILL_REMOVE_ACTION ? P.removeSkillModal(this.locale, document.name) : P.skillModal(this.locale, document.name, document.content, document.editable);
			this.skillEdit = { document, sessionId: query.session_id, modal: this.modal }; this.render(); return true;
		}
		if (id === P.SKILL_VIEW_MODAL) { this.modal = undefined; this.render(); return true; }
		if (action.kind !== "modal-submit" || ![P.SKILL_CREATE_MODAL, P.SKILL_EDIT_MODAL, P.SKILL_REMOVE_MODAL, P.SKILL_IMPORT_MODAL].includes(id)) return false;
		if (!identity || !modal || this.modalPending) return true;
		const original = this.skillEdit;
		if ((id === P.SKILL_EDIT_MODAL || id === P.SKILL_REMOVE_MODAL) && (!original || original.modal !== modal || original.document.name !== data)) return true;
		this.pendingModal = modal; this.render();
		try {
			if (id === P.SKILL_CREATE_MODAL) {
				const name = (fields.name ?? "").trim();
				await this.client.call("POST /api/v1/skills", { body: { name, content: P.composeSkill(name, fields.description ?? "", fields.body ?? "") }, query, identity });
			} else if (id === P.SKILL_IMPORT_MODAL) await this.client.call("POST /api/v1/skills/import", { body: { path: fields.path ?? "" }, query, identity });
			else if (original) {
				const scope = { session_id: original.sessionId };
				if (id === P.SKILL_EDIT_MODAL) await this.client.call("POST /api/v1/skills", { body: { name: original.document.name, content: fields.content ?? "", expected_digest: original.document.digest }, query: scope, identity });
				else await this.client.call("DELETE /api/v1/skills/{name}", { path: { name: original.document.name }, body: { expected_digest: original.document.digest }, query: scope, identity });
			}
			const generation = ++this.resourceGeneration;
			const resources = await this.client.call("GET /api/v1/skills", { query });
			if (current() && generation === this.resourceGeneration) { this.resources = resources; this.modal = undefined; }
		} finally { if (this.pendingModal === modal) this.pendingModal = undefined; if (navigation === this.navigationGeneration) this.render(); }
		return true;
	}
	private async loadPlugins(): Promise<void> {
		const connection = this.client.connection, identity = this.client.identity, generation = ++this.pluginsGeneration;
		const [packages, runtime, config, mcp] = await Promise.all([
			this.client.call("GET /api/v1/plugin-packages", { identity }),
			connection ? this.client.call("GET /api/v1/plugins", { query: { session_id: connection.sessionId } }) : undefined,
			connection ? this.client.call("GET /api/v1/sessions/{session_id}/mcp-configuration", { path: { session_id: connection.sessionId } }) : this.client.call("GET /api/v1/mcp-configuration"),
			connection ? this.client.call("GET /api/v1/sessions/{session_id}/mcp", { path: { session_id: connection.sessionId } }) : undefined,
		]);
		if (identity !== this.client.identity || generation !== this.pluginsGeneration || connection !== this.client.connection) return;
		this.pluginPackages = packages; this.pluginRuntime = runtime?.plugins ?? [];
		this.mcpConfiguration = config; this.mcpRuntime = mcp;
	}
	private async mcpAction(action: P.PanelAction): Promise<boolean> {
		if (action.kind === "open" || action.kind === "modal-close") return false;
		const { id, data } = action, fields = action.kind === "modal-submit" ? action.fields : {};
		if ([P.PLUGIN_MCP_LOGIN_ACTION, P.PLUGIN_MCP_LOGIN_OPEN_ACTION, P.PLUGIN_MCP_LOGIN_REDIRECT_ACTION, P.PLUGIN_MCP_LOGIN_CANCEL_ACTION, P.PLUGIN_MCP_LOGIN_MODAL].includes(id)) { await this.mcpLoginAction(action); return true; }
		if (![P.PLUGIN_MCP_ADD_ACTION, P.PLUGIN_MCP_MODAL, P.PLUGIN_MCP_ENABLED_ACTION, P.PLUGIN_MCP_EXPOSURE_ACTION, P.PLUGIN_MCP_REMOVE_ACTION, P.PLUGIN_MCP_RELOAD_ACTION, P.PLUGIN_MCP_RECONNECT_ACTION, P.PLUGIN_MCP_PROJECT_ACTION, P.PLUGIN_MCP_PROJECT_MODAL, "plugins:mcp-remove-confirm"].includes(id)) return false;
		const connection = this.client.connection, identity = this.client.identity, modal = this.modal;
		if (!identity) throw new Error("请先连接后端");
		if (connection && !connection.ready) throw new Error("请等待原会话重新连接");
		const ledger = connection ? this.ledger(connection) : this.hostLedger(identity), binding = connection ?? identity;
		const path = connection ? { session_id: connection.sessionId } : {}, config = this.mcpConfiguration;
		const globalLedger = this.hostLedger(identity);
		if (!config) throw new Error("请等待 MCP 配置加载完成");
		const target = config.servers.find(item => item.name === data);
		if (id === P.PLUGIN_MCP_ADD_ACTION) {
			const previous = globalLedger.read("mcp:save", "POST /api/v1/mcp-configuration");
			this.modal = P.addMcpServerModal(this.locale);
			if (previous) this.modal = { ...this.modal, notice: { tone: "info", text: "上次配置尚待确认；提交将沿用原编号和内容。" }, fields: this.modal.fields.map(field => ({ ...field, value: field.id === "name" ? previous.body.name : JSON.stringify(previous.body.entry, null, 2), readOnly: true })) };
			this.render(); return true;
		}
		if (id === P.PLUGIN_MCP_PROJECT_ACTION) {
			if (!connection) throw new Error("请先选择项目会话");
			if (!target) throw new Error("MCP 配置不存在");
			this.modal = P.mcpProjectModal(this.locale, target);
			this.modal = { ...this.modal, data: JSON.stringify({ name: target.name, revision: config.revision }) };
			this.render(); return true;
		}
		if (id === P.PLUGIN_MCP_REMOVE_ACTION) {
			if (!target) throw new Error("MCP 配置不存在");
			this.modal = { id: "plugins:mcp-remove-confirm", title: "移除 MCP 服务", description: `停止配置所属连接并移除 ${target.name}，原调用结果保留。`, fields: [], danger: true, submit: "移除", data: JSON.stringify({ name: target.name, revision: config.revision }) };
			this.render(); return true;
		}
		if (id === P.PLUGIN_MCP_MODAL) {
			if (modal?.id !== id) return true;
			const record = globalLedger.prepare("mcp:save", "POST /api/v1/mcp-configuration", operationId => ({ path: {}, body: parseContract("McpConfigWrite", { operation_id: operationId, expected_revision: config.revision, name: fields.name ?? "", entry: JSON.parse(fields.entry ?? "null") }) }));
			await globalLedger.send("mcp:save", record, this.client, identity);
		} else if (id === P.PLUGIN_MCP_RELOAD_ACTION) { if (connection) await this.client.call("POST /api/v1/sessions/{session_id}/mcp-configuration/reload", { path: { session_id: connection.sessionId }, connection }); }
		else if (id === P.PLUGIN_MCP_RECONNECT_ACTION) {
			if (!connection) throw new Error("请先选择会话，再连接 MCP 服务");
			if (!target) throw new Error("MCP 配置不存在");
			const key = `mcp:reconnect:${target.name}`;
			await ledger.send(key, ledger.prepare(key, "POST /api/v1/sessions/{session_id}/mcp-configuration/reconnect", operationId => ({ path: { session_id: connection.sessionId }, body: { operation_id: operationId, name: target.name } })), this.client, connection);
		} else {
			let name = target?.name, revision = config.revision, scope: "global" | "project" = "global";
			if (id === P.PLUGIN_MCP_PROJECT_MODAL || id === "plugins:mcp-remove-confirm") {
				if (modal?.id !== id || modal.data !== data) return true;
				const original: unknown = JSON.parse(data ?? "null");
				if (!isRecord(original) || typeof original.name !== "string" || typeof original.revision !== "number") throw new Error("MCP 配置归属损坏");
				name = original.name; revision = original.revision; scope = id === P.PLUGIN_MCP_PROJECT_MODAL ? "project" : "global";
			}
			if (!name) throw new Error("MCP 配置不存在");
			if (scope === "project" && !connection) throw new Error("请先选择项目会话");
			const enabled = id === P.PLUGIN_MCP_ENABLED_ACTION ? action.kind === "control" && action.value === "true" : id === P.PLUGIN_MCP_PROJECT_MODAL ? fields.enabled === "true" : undefined;
			const exposure = id === P.PLUGIN_MCP_EXPOSURE_ACTION ? action.kind === "control" ? action.value : undefined : id === P.PLUGIN_MCP_PROJECT_MODAL ? fields.exposure : undefined;
			const key = `mcp:patch:${scope}:${name}:${id}`;
			const patchLedger = scope === "project" ? ledger : globalLedger;
			const patchOperation = scope === "project" ? "PATCH /api/v1/sessions/{session_id}/mcp-configuration" : "PATCH /api/v1/mcp-configuration";
			const record = patchLedger.prepare(key, patchOperation, operationId => ({ path: scope === "project" ? path : {}, body: parseContract("McpConfigPatch", { operation_id: operationId, expected_revision: revision, name, scope,
				...(enabled === undefined ? {} : { enabled }), ...(exposure === undefined ? {} : { exposure }), remove: id === "plugins:mcp-remove-confirm" }) }));
			await patchLedger.send(key, record, this.client, scope === "project" ? binding : identity);
		}
		await this.loadPlugins(); if (this.modal === modal) this.modal = undefined; this.render(); return true;
	}
	private async mcpLoginAction(action: P.PanelAction): Promise<void> {
		if (action.kind === "open" || action.kind === "modal-close") return;
		const identity = this.client.identity, { id, data } = action;
		if (!identity) throw new Error("请先连接后端");
		if (id === P.PLUGIN_MCP_LOGIN_OPEN_ACTION) {
			if (!data || data !== this.mcpLogin?.url || !/^https?:\/\//.test(data)) throw new Error("授权链接已变化");
			window.open(data, "_blank", "noopener,noreferrer"); return;
		}
		if (id === P.PLUGIN_MCP_LOGIN_ACTION) {
			const config = this.mcpConfiguration, server = config?.servers.find(item => item.name === data);
			if (!config || !server?.can_login) throw new Error("MCP 未配置 OAuth");
			const key = `amazme:mcp-login:${identity.profile_id}:${server.name}`, raw = sessionStorage.getItem(key);
			const request = raw ? parseContract("McpLoginRequest", JSON.parse(raw)) : { login_id: newId(), name: server.name, expected_revision: config.revision };
			if (!raw) sessionStorage.setItem(key, JSON.stringify(request));
			const generation = ++this.mcpLoginGeneration;
			clearTimeout(this.mcpLoginTimer);
			const result = await this.client.call("POST /api/v1/mcp-configuration/logins", { body: request, identity });
			this.showMcpLogin(identity, request.name, request.login_id, result, generation); return;
		}
		const login = this.mcpLogin, generation = this.mcpLoginGeneration;
		if (!login || data !== login.login_id) throw new Error("原授权已变化，请核对当前记录");
		if (id === P.PLUGIN_MCP_LOGIN_REDIRECT_ACTION) {
			this.modal = { id: P.PLUGIN_MCP_LOGIN_MODAL, title: "完成 MCP 登录", description: "粘贴浏览器中的完整回调地址。", fields: [{ id: "value", label: "回调地址", kind: "text", value: "" }], submit: "确认", data: login.login_id };
			this.render(); return;
		}
		if (id === P.PLUGIN_MCP_LOGIN_MODAL && action.kind === "modal-submit") {
			const modal = this.modal;
			if (modal?.id !== id || modal.data !== data) return;
			const result = await this.client.call("POST /api/v1/mcp-configuration/logins/{login_id}/input", { path: { login_id: login.login_id }, body: { value: action.fields.value ?? "" }, identity });
			this.showMcpLogin(identity, login.provider, login.login_id, result, generation);
			if (this.hostActive(identity) && generation === this.mcpLoginGeneration && this.modal === modal) { this.modal = undefined; this.render(); } return;
		}
		if (id === P.PLUGIN_MCP_LOGIN_CANCEL_ACTION) {
			const result = await this.client.call("DELETE /api/v1/mcp-configuration/logins/{login_id}", { path: { login_id: login.login_id }, identity });
			this.showMcpLogin(identity, login.provider, login.login_id, result, generation);
		}
	}
	private showMcpLogin(identity: Identity, name: string, loginId: string, result: OAuthView, generation: number): void {
		if (result.login_id !== loginId || result.provider !== name) throw new Error("MCP 授权回执归属不匹配；原编号已保留");
		const key = `amazme:mcp-login:${identity.profile_id}:${name}`, raw = sessionStorage.getItem(key);
		if (raw && parseContract("McpLoginRequest", JSON.parse(raw)).login_id === loginId && result.phase !== "pending" && result.phase !== "unknown") sessionStorage.removeItem(key);
		if (!this.hostActive(identity) || generation !== this.mcpLoginGeneration) return;
		this.mcpLogin = result; clearTimeout(this.mcpLoginTimer); this.render();
		if (result.phase === "pending") this.mcpLoginTimer = setTimeout(() => {
			if (!this.hostActive(identity) || generation !== this.mcpLoginGeneration || this.mcpLogin?.login_id !== loginId) return;
			void this.client.call("GET /api/v1/mcp-configuration/logins/{login_id}", { path: { login_id: loginId }, identity }).then(value => this.showMcpLogin(identity, name, loginId, value, generation)).catch(error => { if (this.hostActive(identity) && generation === this.mcpLoginGeneration) this.error(error); });
		}, 1000);
	}
	private async pluginAction(action: P.PanelAction): Promise<boolean> {
		if (action.kind === "open" || action.kind === "modal-close") return false;
		const { id, data } = action, fields = action.kind === "modal-submit" ? action.fields : {};
		if (![P.PLUGIN_PACKAGE_ADD_ACTION, P.PLUGIN_PACKAGE_MODAL, P.PLUGIN_PACKAGE_REMOVE_ACTION, "plugins:package-remove-confirm", "plugins:package-reload"].includes(id)) return false;
		const identity = this.client.identity, connection = this.client.connection, modal = this.modal;
		if (!identity) throw new Error("请先连接后端");
		const key = `amazme:plugin-package:${identity.profile_id}`, raw = sessionStorage.getItem(key);
		if (id === P.PLUGIN_PACKAGE_ADD_ACTION) {
			this.modal = P.addPackageModal(this.locale);
			this.modal = { ...this.modal, description: "选择 Python 插件入口文件，或含 extension.py 的目录。", fields: this.modal.fields.map(field => field.id === "path" ? { ...field, value: raw ? parseContract("PluginPackageAdd", JSON.parse(raw)).entry : "", placeholder: "/path/to/extension.py" } : field),
				...(raw ? { notice: { tone: "info", text: "上次添加尚待确认；提交将沿用原路径与编号。" } } : {}) };
			this.render(); return true;
		}
		const target = this.pluginPackages?.packages.find(item => item.entry === data);
		if (id === P.PLUGIN_PACKAGE_REMOVE_ACTION) {
			if (!target || !this.pluginPackages) throw new Error("插件配置不存在");
			this.modal = { id: "plugins:package-remove-confirm", title: "移除插件", description: `停止此配置在各会话中的插件进程并移除配置：${target.entry}`, fields: [], submit: "移除", danger: true, data: JSON.stringify({ id: target.package_id, revision: this.pluginPackages.revision }) };
			this.render(); return true;
		}
		if (id === P.PLUGIN_PACKAGE_MODAL) {
			if (modal?.id !== id) return true;
			const request = raw ?? JSON.stringify({ package_id: newId(), entry: fields.path ?? "", expected_revision: this.pluginPackages?.revision ?? 0 });
			const body = parseContract("PluginPackageAdd", JSON.parse(request));
			sessionStorage.setItem(key, request);
			try {
				await this.client.call("POST /api/v1/plugin-packages", { body, identity });
				if (sessionStorage.getItem(key) === request) { sessionStorage.removeItem(key); sessionStorage.removeItem(key + ":uncertain"); }
			} catch (error) {
				if (sessionStorage.getItem(key) === request) {
					if (!definitive(error)) sessionStorage.setItem(key + ":uncertain", body.package_id);
					else if (sessionStorage.getItem(key + ":uncertain") !== body.package_id) sessionStorage.removeItem(key);
				}
				throw error;
			}
			if (connection?.active()) await this.client.call("POST /api/v1/sessions/{session_id}/plugin-packages/load", { path: { session_id: connection.sessionId }, connection });
		} else if (id === "plugins:package-remove-confirm") {
			if (modal?.id !== id || modal.data !== data) return true;
			const target: unknown = JSON.parse(data ?? "null");
			if (!isRecord(target) || typeof target.id !== "string" || typeof target.revision !== "number") throw new Error("插件配置归属损坏");
			await this.client.call("POST /api/v1/plugin-packages/{package_id}/remove", { path: { package_id: target.id }, body: { expected_revision: target.revision }, identity });
		} else if (id === "plugins:package-reload") {
			if (!target) throw new Error("插件配置不存在");
			const selected = this.requireConnection(), runtime = this.pluginRuntime.find(item => item.package_id === target.package_id);
			if (runtime) {
				const ledger = this.ledger(selected), key = `plugin:reload:${runtime.plugin_id}`;
				await ledger.send(key, ledger.prepare(key, "POST /api/v1/plugins/{plugin_id}/reload", reloadId => ({ path: { plugin_id: runtime.plugin_id }, body: { session_id: selected.sessionId, reload_id: reloadId } })), this.client, selected);
			} else await this.client.call("POST /api/v1/sessions/{session_id}/plugin-packages/load", { path: { session_id: selected.sessionId }, connection: selected });
		}
		await this.loadPlugins(); if (this.modal === modal) this.modal = undefined; this.render(); return true;
	}
	private async loadSchedules(): Promise<void> {
		const generation = ++this.schedulesGeneration, identity = this.client.identity;
		const state = await this.client.call("GET /api/v1/schedules", { identity });
		if (generation === this.schedulesGeneration && identity === this.client.identity) this.schedules = state;
	}
	private async scheduleAction(action: P.PanelAction): Promise<boolean> {
		if (action.kind === "open" || action.kind === "modal-close") return false;
		const { id, data } = action, fields = action.kind === "modal-submit" ? action.fields : {};
		const row = this.schedules?.schedules.find(item => item.schedule_id === data), modal = this.modal;
		if (id === A.SCHEDULE_RELOAD_ACTION) { await this.loadSchedules(); this.render(); return true; }
		if (id === A.SCHEDULE_ADD_ACTION) {
			const connection = this.requireConnection(), pending = this.ledger(connection).read("schedule:create", "POST /api/v1/schedules");
			this.modal = P.addScheduleModal(this.locale, connection.sessionId, "1", pending?.body.schedule_id ?? newId());
			if (pending) {
				const body = pending.body, rule = body.rule;
				const values: Readonly<Record<string, string>> = { prompt: body.text, kind: rule.kind, everyMinutes: rule.kind === "interval" ? String(rule.every_minutes) : "15", at: rule.kind === "once" ? rule.at : "", expression: rule.kind === "cron" ? rule.expression : "", timeZone: rule.kind === "interval" ? "" : rule.time_zone, busy: body.busy ?? "queue", missed: body.missed ?? "latest", graceMinutes: String(body.grace_minutes ?? 10), timeoutSeconds: String(body.timeout_seconds ?? 600) };
				this.modal = { ...this.modal, notice: { tone: "info", text: "上次创建尚待确认；本次提交沿用原编号和输入。" }, fields: this.modal.fields.map(field => ({ ...field, value: values[field.id] ?? field.value, readOnly: true })) };
			}
			this.render(); return true;
		}
		if ([A.SCHEDULE_EDIT_ACTION, A.SCHEDULE_REMOVE_ACTION, A.SCHEDULE_HISTORY_ACTION].includes(id)) {
			if (!row) throw new Error("定时计划不存在");
			const record = scheduleRecord(row);
			this.modal = id === A.SCHEDULE_EDIT_ACTION ? P.editScheduleModal(this.locale, record) : id === A.SCHEDULE_REMOVE_ACTION ? P.removeScheduleModal(this.locale, row.schedule_id) : P.scheduleHistoryModal(this.locale, record);
			if (id === A.SCHEDULE_REMOVE_ACTION) this.modal = { ...this.modal, data: JSON.stringify({ id: row.schedule_id, generation: row.generation, request_id: row.pending?.request_id ?? "" }) };
			this.render(); return true;
		}
		if (id === A.SCHEDULE_HISTORY_MODAL) { this.modal = undefined; this.render(); return true; }
		if (id === A.SCHEDULE_ADD_MODAL) {
			if (modal?.id !== id || modal.data !== data) return true;
			const target: unknown = JSON.parse(data ?? "null");
			if (!isRecord(target) || typeof target.id !== "string" || typeof target.sessionId !== "string") throw new Error("定时计划归属损坏");
			const scheduleId = target.id, sessionId = target.sessionId;
			const kind = fields.kind;
			const rule: ScheduleInput["rule"] = kind === "interval" ? { kind, every_minutes: Number(fields.everyMinutes) } : kind === "once" ? { kind, at: fields.at ?? "", time_zone: fields.timeZone ?? "" } : { kind: "cron", expression: fields.expression ?? "", time_zone: fields.timeZone ?? "" };
			if (fields.busy !== "queue" && fields.busy !== "skip" || fields.missed !== "latest" && fields.missed !== "skip") throw new Error("请选择运行策略");
			const body: ScheduleInput = { schedule_id: scheduleId, session_id: sessionId, text: fields.prompt ?? "", rule, busy: fields.busy, missed: fields.missed, grace_minutes: Number(fields.graceMinutes), timeout_seconds: Number(fields.timeoutSeconds), expected_generation: typeof target.expectedGeneration === "number" ? target.expectedGeneration : 0 };
			await this.client.withSession(sessionId, connection => {
				const ledger = this.ledger(connection), key = body.expected_generation ? `schedule:save:${scheduleId}` : "schedule:create";
				return ledger.send(key, ledger.prepare(key, "POST /api/v1/schedules", () => ({ path: {}, body })), this.client, connection);
			});
		} else if (id === A.SCHEDULE_REMOVE_MODAL) {
			if (modal?.id !== id || modal.data !== data) return true;
			const target: unknown = JSON.parse(data ?? "null");
			if (!isRecord(target) || typeof target.id !== "string" || typeof target.generation !== "number" || typeof target.request_id !== "string") throw new Error("定时计划归属损坏");
			await this.client.call("POST /api/v1/schedules/{schedule_id}/remove", { path: { schedule_id: target.id }, body: { expected_generation: target.generation, request_id: target.request_id } });
		} else if ([A.SCHEDULE_RUN_ACTION, A.SCHEDULE_CANCEL_ACTION, A.SCHEDULE_ENABLED_ACTION].includes(id)) {
			if (!row) throw new Error("定时计划不存在");
			if (id === A.SCHEDULE_RUN_ACTION) await this.client.withSession(row.session_id, connection => {
				const ledger = this.ledger(connection), key = `schedule:run:${row.schedule_id}`;
				return ledger.send(key, ledger.prepare(key, "POST /api/v1/schedules/{schedule_id}/run", operationId => ({ path: { schedule_id: row.schedule_id }, body: { operation_id: operationId, expected_generation: row.generation ?? 1 } })), this.client, connection);
			});
			else if (id === A.SCHEDULE_CANCEL_ACTION) await this.client.call("POST /api/v1/schedules/{schedule_id}/cancel", { path: { schedule_id: row.schedule_id }, body: { expected_generation: row.generation ?? 1, request_id: row.pending?.request_id ?? "" } });
			else await this.client.call("POST /api/v1/schedules/{schedule_id}/enabled", { path: { schedule_id: row.schedule_id }, body: { expected_generation: row.generation ?? 1, enabled: action.kind === "control" && action.value === "true" } });
		} else return false;
		await this.loadSchedules(); if (this.modal === modal) this.modal = undefined; this.render(); return true;
	}
	private latestTranscriptRevision(connection: ClientConnection): bigint {
		return (connection.snapshot?.requests ?? []).filter(row => row.kind === "root").reduce((latest, row) => {
			const revision = seq(row.accepted_revision ?? "0"); return revision > latest ? revision : latest;
		}, 0n);
	}
	private async loadHistory(connection: ClientConnection, older: boolean, all = false): Promise<void> {
		if (!older && this.history && this.historyConnection === connection) return;
		if (this.historyConnection !== connection) { this.historyConnection = connection; this.historyGeneration++; this.historyLoading = false; }
		if (this.historyLoading) return;
		const generation = ++this.historyGeneration;
		this.historyLoading = true; this.render();
		const current = () => connection.active() && generation === this.historyGeneration;
		const merge = (page: HistoryPage, prepend: boolean) => {
			if (page.session_id !== connection.sessionId) throw new Error("历史记录的会话归属不匹配");
			const previous = this.history;
			const ordered = prepend ? [...page.requests, ...(previous?.requests ?? [])] : [...(previous?.requests ?? []), ...page.requests];
			const rows = new Map<string, HistoryPage["requests"][number]>();
			for (const row of ordered) { const previous = rows.get(row.request_id); if (!previous || seq(row.revision ?? "0") >= seq(previous.revision ?? "0")) rows.set(row.request_id, row); }
			const events = new Map([...(previous?.events ?? []), ...page.events].map(event => [`${event.request_id}:${event.kind}:${event.message?.key ?? event.text}`, event]));
			this.history = { ...page, requests: [...rows.values()], events: [...events.values()], truncated: page.truncated || previous?.truncated,
				...(!prepend && this.historyStarted && previous ? { cursor: previous.cursor, more: previous.more } : {}),
			};
		};
		try {
			if (!older || !this.historyStarted || this.latestTranscriptRevision(connection) > this.historyLatestRevision) {
				const page = await this.client.call("GET /api/v1/sessions/{session}/history", { path: { session: connection.sessionId } });
				if (!current()) return;
				merge(page, false);
				this.historyLatestRevision = page.requests.reduce((latest, row) => { const revision = seq(row.accepted_revision ?? "0"); return revision > latest ? revision : latest; }, 0n);
			}
			if (!older) return;
			this.historyStarted = true;
			do {
				if (!this.history?.more || !this.history.cursor) break;
				const before = this.history.cursor;
				const page = await this.client.call("GET /api/v1/sessions/{session}/history", { path: { session: connection.sessionId }, query: { before } });
				if (!current()) return;
				if (page.more && (!page.cursor || page.cursor === before)) throw new Error("历史游标未前进");
				merge(page, true);
				this.render();
			} while (all && current());
		} finally { if (current()) { this.historyLoading = false; this.render(); } }
	}
	private observeTerminal(terminal: ActiveTerminal, view: TerminalView): void {
		if (view.terminal_id !== terminal.id || (view.session_id && view.session_id !== terminal.connection.sessionId)) throw new Error("终端归属不匹配");
		if ((view.output_seq ?? 0) < (terminal.view.output_seq ?? 0) || (terminal.view.phase === "exited" && view.phase === "running")) return;
		terminal.view = view;
	}
	private async loadTerminal(connection: ClientConnection, open = false): Promise<void> {
		if (!connection.active()) return;
		const generation = ++this.terminalLoadGeneration;
		const list = await this.client.call("GET /api/v1/sessions/{session_id}/terminals", { path: { session_id: connection.sessionId } });
		if (!connection.active() || generation !== this.terminalLoadGeneration || this.dockTab !== "terminal") return;
		let view = list.terminals.findLast(item => item.phase === "running") ?? list.terminals.at(-1);
		if ((!view || view.phase === "exited") && open) {
			const ledger = this.ledger(connection), key = "terminal:open";
			const record = ledger.prepare(key, "POST /api/v1/sessions/{session_id}/terminals", id => ({ path: { session_id: connection.sessionId }, body: { terminal_id: id, command: "/bin/zsh -il", cols: 80, rows: 24 } }));
			view = await ledger.send(key, record, this.client, connection);
		}
		if (!view || !connection.active() || generation !== this.terminalLoadGeneration || this.dockTab !== "terminal") return;
		const key = `amazme:terminal:${connection.identity.profile_id}:${connection.sessionId}:${view.terminal_id}`;
		let queue = this.terminalQueues.get(key);
		if (!queue) { queue = new TerminalInputQueue(sessionStorage, key); this.terminalQueues.set(key, queue); }
		const terminal: ActiveTerminal = { connection, id: view.terminal_id, view, queue, resizing: false };
		this.terminal = terminal;
		queue.bind({ active: () => connection.active() && this.terminal === terminal,
			send: async input => {
				const result = await this.client.call("POST /api/v1/sessions/{session_id}/terminals/{terminal_id}/input", { path: { session_id: connection.sessionId, terminal_id: terminal.id }, body: input, connection });
				if (connection.active() && this.terminal === terminal) { this.observeTerminal(terminal, result); this.render(); }
				return result;
			}, error: error => this.error(error), changed: () => { if (connection.active() && this.terminal === terminal) this.render(); },
		});
		this.render(); clearTimeout(this.terminalTimer); void this.pollTerminal(terminal);
	}
	private async pollTerminal(terminal: ActiveTerminal): Promise<void> {
		if (!terminal.connection.active() || this.terminal !== terminal) return;
		try {
			const view = await this.client.call("POST /api/v1/sessions/{session_id}/terminals/{terminal_id}/read", { path: { session_id: terminal.connection.sessionId, terminal_id: terminal.id }, connection: terminal.connection });
			if (!terminal.connection.active() || this.terminal !== terminal) return;
			this.observeTerminal(terminal, view); this.render();
		} catch (error) { if (terminal.connection.active() && this.terminal === terminal) this.error(error); }
		finally { if (terminal.connection.active() && this.terminal === terminal && terminal.view.phase === "running" && this.dockOpen && this.dockTab === "terminal") this.terminalTimer = setTimeout(() => { void this.pollTerminal(terminal); }, 250); }
	}
	private async resizeTerminal(terminal: ActiveTerminal): Promise<void> {
		if (terminal.resizing) return;
		terminal.resizing = true;
		try {
			while (terminal.desiredSize && terminal.connection.active() && this.terminal === terminal) {
				const size = terminal.desiredSize; terminal.desiredSize = undefined;
				const view = await this.client.call("POST /api/v1/sessions/{session_id}/terminals/{terminal_id}/resize", { path: { session_id: terminal.connection.sessionId, terminal_id: terminal.id }, body: size, connection: terminal.connection });
				if (terminal.connection.active() && this.terminal === terminal) { this.observeTerminal(terminal, view); this.render(); }
			}
		} finally { terminal.resizing = false; }
	}
	private async openWorkspace(path?: string, file = false, offset?: number): Promise<void> {
		const connection = this.requireConnection(), generation = ++this.workspaceGeneration;
		const session = this.sessions.find(item => item.session_id === connection.sessionId);
		const project = this.projects.find(item => item.project_id === session?.project_id);
		const names = project?.workspaces ?? [session?.workspace ?? "primary"];
		const roots = this.workspaces.filter(item => names.includes(item.name));
		let root = roots.find(item => item.host_path === this.workspace?.cwd) ?? roots.find(item => item.name === session?.workspace) ?? roots[0];
		if (!root) throw new Error("工作区目录不可用");
		this.dockOpen = true; this.dockTab = "files"; this.render();
		if (path?.startsWith("/")) {
			const matched = [...roots].sort((a, b) => b.host_path.length - a.host_path.length).find(item => path === item.host_path || path.startsWith(item.host_path + "/"));
			if (!matched) { this.workspace = { cwd: root.host_path, workspaces: roots.map(item => item.host_path), view: { kind: "denied", path, reason: "目录不属于当前项目" } }; this.render(); return; }
			root = matched;
		}
		const relative = path?.startsWith("/") ? path.slice(root.host_path.length).replace(/^\/+/, "") || "." : path || ".";
		const previous = this.workspace?.cwd === root.host_path && this.workspace.view.kind === "listing" && this.workspace.view.path === relative ? this.workspace.view.page : undefined;
		const pageOffset = offset ?? previous?.offset ?? 0;
		const prefix = root.name === "primary" ? "" : `grant/${root.name}`;
		const target = relative === "." ? prefix : prefix ? `${prefix}/${relative}` : relative;
		let view: WorkspaceStateLike["view"];
		try {
			if (file) {
				const result = await this.client.call("GET /api/v1/files/content", { query: { path: target } });
				view = { kind: "text", path: relative, text: result.content, truncated: result.truncated ?? false };
			} else {
				const result = await this.client.call("GET /api/v1/files", { query: { path: target, offset: pageOffset } });
				view = { kind: "listing", path: relative, parent: relative === "." ? null : relative.includes("/") ? relative.split("/").slice(0, -1).join("/") : ".",
					entries: result.entries.map(item => ({ ...item, kind: item.kind === "dir" ? "dir" : "file" })), page: { offset: result.offset ?? pageOffset, limit: result.limit ?? 200, total: result.total ?? result.entries.length } };
			}
		} catch (error) {
			if (!(error instanceof ApiError)) throw error;
			if (error.code === "file_not_text") view = { kind: "binary", path: relative };
			else if (error.code === "workspace_missing") view = { kind: "missing", path: relative };
			else if (["workspace_permission", "workspace_path_escape", "workspace_not_file", "workspace_not_directory", "workspace_not_found", "invalid_workspace_path"].includes(error.code)) view = { kind: "denied", path: relative, reason: error.message };
			else throw error;
		}
		if (!connection.active() || generation !== this.workspaceGeneration) return;
		this.workspace = { cwd: root.host_path, workspaces: roots.map(item => item.host_path), view }; this.render();
	}
	private hostActive(identity: Identity): boolean {
		const current = this.client.identity;
		return current?.profile_id === identity.profile_id && current.instance_id === identity.instance_id && current.host_epoch === identity.host_epoch && current.build_id === identity.build_id;
	}
	private authentication(): ProviderAuthLike {
		const ids = [...new Set([...(this.catalog?.models.map(item => item.provider) ?? []), ...Object.keys(OAUTH_METHODS)])];
		const current = this.catalog?.current;
		const providers: ProviderAuthLike["providers"] = ids.map(id => ({ id, name: this.catalog?.providers?.find(item => item.provider === id)?.name || id,
			configured: this.accounts.accounts.some(item => item.provider === id) || current?.provider === id && (id === "faux" || current.key_configured),
			methods: [{ type: "api_key", label: "API Key" }, ...(OAUTH_METHODS[id] ? [{ type: "oauth" as const, label: "登录" }] : [])] }));
		const login = this.oauth;
		return { providers, login: login ? { id: login.login_id, provider: login.provider, status: login.phase === "pending" ? "awaiting" : login.phase === "complete" ? "done" : login.phase === "cancelled" ? "cancelled" : "error", authorization: login.url ? login.user_code ? { type: "device_code", userCode: login.user_code, verificationUri: login.url } : { type: "auth_url", url: login.url } : null, message: null, links: [], prompt: login.phase === "pending" && !login.user_code ? { id: login.login_id, type: "secret", message: "回调地址或授权码" } : null, error: login.error ?? null } : null };
	}
	private connections(): ModelConnectionsLike {
		const authentication = this.authentication(), current = this.catalog?.current;
		const availableProviders = new Set(authentication.providers.filter(provider => provider.configured &&
			!this.accounts.accounts.some(account => account.provider === provider.id && account.login_required)).map(provider => provider.id));
		const models = this.catalog?.models.map(item => ({ provider: item.provider, modelId: item.model, name: item.label,
			available: availableProviders.has(item.provider) })) ?? [];
		const selected = authentication.providers.some(provider => provider.id === this.selectedProvider && provider.configured)
			? this.selectedProvider : authentication.providers.find(provider => provider.configured)?.id;
		const enabled = this.globalModelIds;
		return { state: { providers: authentication.providers.map(provider => {
			const model = this.catalog?.models.find(item => item.provider === provider.id), definition = this.catalog?.providers?.find(item => item.provider === provider.id);
			return { id: provider.id, name: provider.name, configured: provider.configured, available: availableProviders.has(provider.id), baseUrl: definition?.base_url ?? (current?.provider === provider.id ? current.base_url : model?.base_url ?? ""),
				api: definition?.api ?? (current?.provider === provider.id ? current.api ?? "openai-completions" : model?.api ?? "openai-completions"),
				modelCount: models.filter(item => item.provider === provider.id).length, custom: definition?.model_ids != null, modelIds: definition?.model_ids ?? undefined, verification: this.verification(provider.id) };
		}), authentication, enabledModelIds: enabled, defaults: current ? { model: { provider: current.provider, modelId: current.model }, thinkingLevel: current.thinking ?? "off" } : null, error: null, refresh: { status: "idle" } },
		selected, models: models.filter(item => item.provider === selected), enabledModels: models.filter(item => item.available && (enabled === null || enabled.includes(`${item.provider}/${item.modelId}`))), loading: false, disabled: !this.ready };
	}
	private verification(provider: string): ModelConnectionsLike["state"]["providers"][number]["verification"] {
		if (this.checkingProviders.has(provider)) return { status: "checking" };
		const result = this.providerVerification.get(provider);
		if (!result || result.configuration_revision !== (this.catalog?.configuration_revision ?? 0) || result.credential_revision !== this.accounts.revision) return { status: "idle" };
		return { status: result.phase === "done" && !result.failed?.length ? "success" : "error", checkedAt: result.checked_at || undefined };
	}
	private async checkProvider(provider: string | undefined, model: string | undefined): Promise<void> {
		const identity = this.client.identity, modal = this.modal;
		if (!identity || !provider || modal?.id !== PROVIDER_TEST_MODAL || modal.data !== provider || this.modalPending || this.checkingProviders.has(provider)) return;
		const key = `amazme:provider-check:${identity.profile_id}:${provider}`, stored = sessionStorage.getItem(key);
		const body = parseContract("ProviderCheckRequest", stored ? JSON.parse(stored) : { operation_id: newId(), provider, model_ids: model === undefined ? this.catalog?.models.filter(item => item.provider === provider).map(item => item.model) ?? [] : [model] });
		if (body.provider !== provider) throw new Error("原检查不属于此供应商");
		const serialized = JSON.stringify(body); sessionStorage.setItem(key, serialized);
		this.checkingProviders.add(provider); this.pendingModal = modal; this.render();
		try {
			const result = await this.client.call("POST /api/v1/providers/{provider}/check", { path: { provider }, body, identity });
			if (result.operation_id !== body.operation_id || result.provider !== provider) throw new Error("检查回执编号不匹配；原编号已保留");
			if (result.phase === "done" && sessionStorage.getItem(key) === serialized) sessionStorage.removeItem(key);
			if (!this.hostActive(identity)) return;
			this.providerVerification.set(provider, result);
			if (this.modal === modal) {
				const current = result.configuration_revision === (this.catalog?.configuration_revision ?? 0) && result.credential_revision === this.accounts.revision;
				this.modal = { ...modal, notice: { tone: result.phase === "done" && !result.failed?.length && current ? "info" : "error", text: !current ? "供应商配置已变化；这是原配置的检查结果。" : result.phase !== "done" ? "原检查尚未确认；再次提交仅核对原编号，不会重新请求模型。" : verificationStatusText(this.locale, { status: result.failed?.length ? "error" : "success", checkedAt: result.checked_at || undefined }, result.failed?.join(", ")) } };
			}
		} finally { this.checkingProviders.delete(provider); if (this.pendingModal === modal) this.pendingModal = undefined; if (this.hostActive(identity)) this.render(); }
	}
	private async saveProvider(data: string | undefined, fields: Readonly<Record<string, string>>, clear: boolean): Promise<void> {
		if (this.modalPending) return;
		const identity = this.client.identity, provider = data ?? fields.id, modal = this.modal, generation = this.modalGeneration;
		if (!identity || !modal || !provider) throw new Error("请选择供应商并连接后端");
		const owner = this.providerEdit?.generation === generation ? this.providerEdit : { generation, revision: this.accounts.revision, configurationRevision: this.catalog?.configuration_revision ?? 0 };
		this.providerEdit = owner;
		const current = () => this.hostActive(identity) && generation === this.modalGeneration;
		this.pendingModal = modal; this.render();
		try {
			if (clear) await this.client.call("POST /api/v1/accounts/{provider}", { path: { provider }, body: { expected_revision: owner.revision, clear: true }, identity });
			else {
				if (fields.baseUrl !== undefined) {
					const storageKey = `amazme:provider:${identity.profile_id}:${provider}`;
					const saved = sessionStorage.getItem(storageKey);
					owner.configuration ??= saved ? parseContract("ConfigureProvider", JSON.parse(saved)) : parseContract("ConfigureProvider", {
						operation_id: newId(), expected_revision: owner.configurationRevision, provider, name: fields.name || provider, base_url: fields.baseUrl, api: fields.api,
						...(fields.models === undefined ? {} : { model_ids: fields.models.split("\n").map(item => item.trim()).filter(Boolean) }),
					});
					if (owner.configuration.provider !== provider) throw new Error("配置归属不匹配，原记录已保留");
					sessionStorage.setItem(storageKey, JSON.stringify(owner.configuration));
					const result = await this.client.call("PUT /api/v1/providers/{provider}", { path: { provider }, body: owner.configuration, identity });
					if (result.operation_id !== owner.configuration.operation_id || result.provider !== provider) throw new Error("配置回执归属不匹配，原记录已保留");
					owner.credentialRevision = result.credential_revision;
					const stored = sessionStorage.getItem(storageKey);
					if (stored && parseContract("ConfigureProvider", JSON.parse(stored)).operation_id === owner.configuration.operation_id) sessionStorage.removeItem(storageKey);
					if (this.hostActive(identity)) await this.loadGlobal();
				}
				const revision = owner.credentialRevision ?? owner.revision;
				if (fields[`method:${provider}`] === "oauth") {
					if (!OAUTH_METHODS[provider]) throw new Error("供应商不支持此登录方式");
					const storageKey = `amazme:oauth:${identity.profile_id}:${provider}`, saved = sessionStorage.getItem(storageKey);
					const request = saved ? parseContract("OAuthStart", JSON.parse(saved)) : { login_id: newId(), provider, expected_revision: revision, method: OAUTH_METHODS[provider] };
					if (request.provider !== provider) throw new Error("授权归属不匹配，原记录已保留");
					sessionStorage.setItem(storageKey, JSON.stringify(request));
					const login = await this.client.call("POST /api/v1/accounts/oauth", { body: request, identity });
					if (current()) { this.oauth = login; this.showOAuth(identity, login, generation); } return;
				}
				const key = fields[`key:${provider}`] ?? "";
				if (key || owner.credential) {
					owner.credential ??= { expected_revision: revision, api_key: key };
					await this.client.call("POST /api/v1/accounts/{provider}", { path: { provider }, body: owner.credential, identity });
				}
				else if (!this.accounts.accounts.some(item => item.provider === provider) && !(this.catalog?.current.provider === provider && this.catalog.current.key_configured)) throw new Error("请输入密钥或选择登录方式");
			}
			if (this.hostActive(identity)) await this.loadGlobal();
			if (current()) { this.modal = undefined; this.render(); }
		} finally { if (this.pendingModal === modal) this.pendingModal = undefined; if (current()) this.render(); }
	}
	private showOAuth(identity: Identity, login: OAuthView, generation: number): void {
		const current = () => this.hostActive(identity) && generation === this.modalGeneration && this.oauth?.login_id === login.login_id;
		if (!current()) return;
		this.oauth = login;
		const auth = this.authentication(); this.modal = providerLoginModal(this.locale, auth, auth.login); this.render();
		clearTimeout(this.oauthTimer);
		if (login.phase === "pending") this.oauthTimer = setTimeout(() => {
			if (!current()) return;
			void this.client.call("GET /api/v1/accounts/oauth/{login_id}", { path: { login_id: login.login_id }, identity }).then(value => this.showOAuth(identity, value, generation)).catch(error => { if (current()) this.error(error); });
		}, 750);
		else {
			this.forgetOAuth(identity, login);
			void this.loadGlobal().catch(error => { if (current()) this.error(error); });
		}
	}
	private forgetOAuth(identity: Identity, login: OAuthView): void {
		if (login.phase === "pending" || login.phase === "unknown") return;
		const key = `amazme:oauth:${identity.profile_id}:${login.provider}`, stored = sessionStorage.getItem(key);
		if (stored && parseContract("OAuthStart", JSON.parse(stored)).login_id === login.login_id) sessionStorage.removeItem(key);
	}
	private async resolveModelIds(patterns: readonly string[] | null, identity: Identity, catalog: ModelCatalog | undefined = this.catalog): Promise<string[] | null> {
		if (patterns === null) return null;
		const known = new Set(catalog?.models.map(model => `${model.provider}/${model.model}`));
		if (patterns.every(pattern => known.has(pattern))) return [...patterns];
		const scope = await this.client.call("POST /api/v1/models/scope", { body: { patterns: [...patterns] }, identity });
		return scope.models.map(item => `${item.model.provider}/${item.model.model}`);
	}
	private sessionModelIds(sessionId: string): string[] | null {
		const key = `${this.client.identity?.profile_id}:${sessionId}`;
		return (this.modelScopes.has(key) ? this.modelScopes.get(key) : this.globalModelIds) ?? null;
	}
	private applyPreferences(preferences: InterfacePreferences): void {
		this.locale = resolveLocale(preferences.locale ?? "auto", navigator.languages);
		this.typography = resolveTypography(preferences);
		applyTheme(resolveThemePreference(preferences.appearance));
		const session = this.client.connection?.sessionId;
		this.enabledModels = session ? this.sessionModelIds(session) : this.globalModelIds;
	}
	private updateSettings(update: (current: ProductSettings, identity: Identity) => Promise<ProductSettings>): Promise<void> {
		const identity = this.client.identity;
		if (!identity) return Promise.reject(new Error("请先连接后端"));
		const task = this.settingsQueue.catch(() => {}).then(async () => {
			const current = await this.client.call("GET /api/v1/settings");
			const settings = await update(current, identity);
			if (!this.hostActive(identity) || (settings.revision ?? 0) < (this.settings?.revision ?? 0)) return;
			const globalModelIds = await this.resolveModelIds(settings.preferences?.enabledModels ?? null, identity);
			if (!this.hostActive(identity) || (settings.revision ?? 0) < (this.settings?.revision ?? 0)) return;
			this.settings = settings; this.globalModelIds = globalModelIds; this.applyPreferences(settings.preferences ?? {}); this.render();
		}).catch(error => {
			if (this.hostActive(identity)) {
				this.notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
				this.render();
			}
			throw error;
		});
		this.settingsQueue = task;
		return task;
	}
	private updatePreferences(update: (current: InterfacePreferences) => InterfacePreferences): Promise<void> {
		return this.updateSettings((current, identity) => this.client.call("PUT /api/v1/settings/preferences", {
			body: { preferences: parseContract("InterfacePreferences", update(current.preferences ?? {})), expected_revision: current.revision ?? 0 }, identity,
		}));
	}
	private async setPreference(id: string, value: string): Promise<void> {
		if (id === "display_name") {
			await this.updateSettings((current, identity) => this.client.call("POST /api/v1/settings", { body: { display_name: value, expected_revision: current.revision ?? 0 }, identity }));
			return;
		}
		const typed = id === "showWelcome" || id === "closeWindowPrompt" ? value === "true" : FONT_SIZE_FIELDS.some(field => field === id) ? Number(value) : value;
		await this.updatePreferences(current => parseContract("InterfacePreferences", { ...current, [id]: typed }));
	}
	private preferenceDescriptors(): P.SettingDescriptorLike[] {
		const preferences = this.settings?.preferences ?? {};
		const descriptor = { group: "interface", explicit: true };
		const desktopDescriptor = { group: "desktop", explicit: true };
		return [
			{ ...descriptor, id: "appearance", field: "appearance", kind: "enum", options: ["system", "light", "dark"], value: preferences.appearance ?? "system" },
			{ ...descriptor, id: "locale", field: "locale", kind: "enum", options: ["auto", "zh", "en"], value: preferences.locale ?? "auto" },
			...FONT_FAMILY_FIELDS.map(field => ({ ...descriptor, id: field, field, kind: "string" as const, value: preferences[field] ?? "" })),
			...FONT_SIZE_FIELDS.map(field => ({ ...descriptor, id: field, field, kind: "number" as const, value: String(this.typography[field]), ...FONT_SIZE_LIMITS[field], step: 1 })),
			{ ...descriptor, id: "showWelcome", field: "showWelcome", kind: "boolean", value: String(preferences.showWelcome ?? true) },
			{ ...descriptor, id: "display_name", field: "display_name", kind: "string", value: this.settings?.display_name ?? "" },
			...(this.desktop ? [
				{ ...desktopDescriptor, id: "closeWindow", field: "closeWindow", kind: "enum" as const, options: ["background", "quit"], value: preferences.closeWindow ?? "background" },
				{ ...desktopDescriptor, id: "closeWindowPrompt", field: "closeWindowPrompt", kind: "boolean" as const, value: String(preferences.closeWindowPrompt ?? true) },
			] : []),
		];
	}
	private render(): void {
		document.documentElement.lang = documentLanguage(this.locale);
		const connection = this.client.connection, session = this.sessions.find(item => item.session_id === connection?.sessionId);
		const directory = pythonDirectory(this.sessions, this.projects, this.workspaces);
		const picker = pythonView({ locale: this.locale, typography: this.typography, sessions: this.sessions, projects: this.projects, selectedProject: this.selectedProject, expandedProjects: this.expandedProjects, workspaces: this.workspaces, connection, catalog: this.catalog, selection: this.selection, thinking: this.thinking, enabledModels: this.enabledModels,
			rosterFilter: this.rosterFilter, draft: this.draft.text, paletteSelection: this.paletteSelection, commands: this.commands, attachments: attachments(this.locale, this.draft.images), approvalPolicy: this.approvalPolicy,
			panel: P.panelView({ locale: this.locale, current: this.currentPanel, modal: this.modal, modalPending: this.modalPending, notice: this.notice,
				plugins: { state: pluginPanelState(this.pluginPackages, this.pluginRuntime, connection?.ready === true, this.mcpConfiguration?.path ?? "AmazMe"), runtime: mcpPanelRuntime(this.mcpConfiguration, this.mcpRuntime, this.ready && (!connection || connection.ready), connection?.ready === true, this.mcpLogin) },
				automation: { state: this.schedules ? { path: this.schedules.path, tickMs: this.schedules.tick_ms ?? 5000, schedules: this.schedules.schedules.map(scheduleRecord) } : undefined, sessionId: connection?.sessionId },
				settings: { hostModels: true, state: { paths: { global: "AmazMe" }, projectTrusted: true, errors: [], descriptors: this.preferenceDescriptors() }, archives: { sessions: directory.sessions, projects: directory.projects ?? [], retentionDays: 0, now: Date.now() } },
				skills: { state: { directory: this.resources?.skill_directory ?? "", skills: this.resources?.skills.map(item => ({ name: item.name, description: item.description ?? "", filePath: item.path, scope: item.scope ?? "user", disableModelInvocation: item.disable_model_invocation ?? false, editable: item.editable ?? false })) ?? [], diagnostics: this.resources?.diagnostics.map(message => ({ message })) ?? [] } },
			}), connections: this.connections(), mode: this.mode, usage: this.usage, history: this.history, feedback: this.feedback, historyLoading: this.historyLoading,
			historyMore: this.history?.more === true || Boolean(connection && (connection.snapshot?.requests.filter(row => row.kind === "root" && settled.has(row.status)).length ?? 0) >= 20 && this.latestTranscriptRevision(connection) > this.historyLatestRevision),
			welcomeDismissed: this.settings?.preferences?.showWelcome === false, newSessionPending: this.newSessionPending, ready: this.ready });
		const cwd = this.workspaces.find(item => item.name === session?.workspace)?.host_path ?? "";
		let pendingError: string | undefined;
		const pending = (() => {
			try { return connection ? this.ledger(connection).read("submission", "POST /api/v1/sessions/{session}/submissions") : undefined; }
			catch (error) { pendingError = error instanceof Error ? error.message : String(error); return undefined; }
		})();
		let branchPending: string | undefined;
		const commandPending: Array<{ id: string; text: string; retry: P.PanelButton; cancel: P.PanelButton }> = [];
		try { branchPending = connection ? this.ledger(connection).read("branch", "POST /api/v1/sessions/{session}/branches")?.id : undefined; }
		catch (error) { pendingError = error instanceof Error ? error.message : String(error); }
		try {
			const command = connection ? this.ledger(connection).read("command", "POST /api/v1/sessions/{session_id}/plugins/{plugin_id}/calls") : undefined;
			if (command) commandPending.push({ id: command.id, text: `插件命令尚未确认：/${command.body.name}`, retry: { id: "write:retry-command", data: command.id, label: "重试原命令", weight: "line" }, cancel: { id: "write:cancel-command", data: command.id, label: "取消原命令", weight: "text" } });
		} catch (error) { pendingError = error instanceof Error ? error.message : String(error); }
		const feedbackPending: Array<{ id: string; text: string; retry: P.PanelButton }> = [];
		try {
			if (connection) for (const request of new Set([...(connection.snapshot?.requests ?? []), ...(this.history?.requests ?? [])].map(item => item.request_id))) {
				const record = this.ledger(connection).read(`feedback:${request}`, "POST /api/v1/sessions/{session}/feedback");
				if (record) feedbackPending.push({ id: record.id, text: "答案反馈尚未确认", retry: { id: "write:retry-feedback", data: JSON.stringify([connection.sessionId, request, record.id]), label: "重试原反馈", weight: "line" } });
			}
		} catch (error) { pendingError = error instanceof Error ? error.message : String(error); }
		const terminal = this.terminal?.connection === connection ? this.terminal : undefined;
		const commandBlocks: TranscriptBlock[] = [...(this.commandResults.get(`${connection?.identity.profile_id}:${connection?.sessionId}`)?.values() ?? [])].map(({ name, result }) => {
			const content = result.result?.content ?? [], text = content.filter(item => item.type === "text" && typeof item.text === "string").map(item => item.text).join("\n") || result.error || result.phase;
			const error = result.phase === "failed" || result.phase === "conflict" || result.result?.is_error === true;
			return { id: `command:${result.call_id}`, kind: "tool", title: `/${name}`, toolName: name, text, running: false, tone: error ? "error" : "plain",
				images: content.flatMap(item => item.type === "image" && typeof item.mimeType === "string" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.mimeType) && typeof item.data === "string" ? [{ dataUrl: `data:${item.mimeType};base64,${item.data}`, alt: name }] : []),
				result: toolResultView(this.locale, name, {}, { content: [{ type: "text", text }], isError: error, details: result.result?.details }),
			};
		});
		const dock = dockView(this.locale, { open: this.dockOpen, tab: this.dockTab, cwd, workspace: this.workspace, terminal: terminal ? { status: terminal.view.phase === "running" ? "running" : "done", command: "/bin/zsh -il", exitCode: terminal.view.exit_code ?? null, output: "", truncated: false, error: null } : undefined, conversations: { selected: connection?.sessionId ?? "", conversations: this.sessions.filter(item => item.session_id === connection?.sessionId || item.session_id === session?.parent_id || item.parent_id === connection?.sessionId || Boolean(session?.parent_id && item.parent_id === session.parent_id)).map(item => ({ id: item.session_id, label: item.title, root: !item.parent_id, role: item.parent_id ? "fork" as const : "main" as const, parentConversationId: item.parent_id || undefined, children: this.sessions.filter(child => child.parent_id === item.session_id).length, hasEntries: true, ...(item.archived ? { archivedAt: item.updated_ms ?? 0 } : {}) })), tasks: (connection?.snapshot?.requests ?? []).map(item => ({ id: item.request_id, kind: item.kind ?? "root", conversationId: connection?.sessionId ?? "", background: item.kind === "child", status: item.status, phase: item.status, waitsOn: item.children ?? [], conversations: [] })) } });
		this.renderer.render({ ...picker, blocks: [...picker.blocks, ...commandBlocks], readOnly: picker.readOnly || Boolean(pendingError), queue: [...picker.queue, ...commandPending, ...feedbackPending, ...(branchPending ? [{ id: branchPending, text: "分支创建尚未确认", retry: { id: "write:retry-branch", data: branchPending, label: "重试原分支", weight: "line" as const } }] : []), ...(pending ? [{ id: pending.id, text: `请求尚未确认：${pending.body.text}`, retry: { id: "write:retry-submit", data: pending.id, label: "重试原请求", weight: "line" as const }, cancel: { id: "write:cancel-submit", data: pending.id, label: "取消原请求", weight: "text" as const } }] : [])],
			dock: terminal && this.dockTab === "terminal" ? { ...dock, panel: { ...dock.panel, texts: [], notices: terminal.queue.paused ? [{ tone: "warning", text: "终端输入尚未确认；请重试原输入或核对后继续。" }] : dock.panel.notices, actions: [
				{ id: "terminal:retry", label: "重试原输入", weight: "line", disabled: terminal.queue.busy || !terminal.queue.items.length },
				{ id: "terminal:confirm", label: "核对后继续", weight: "text", disabled: terminal.queue.busy || !terminal.queue.items.length },
			] }, pty: { id: terminal.id, cols: terminal.view.cols, rows: terminal.view.rows, output: terminal.view.output, outputSeq: terminal.view.output_seq ?? terminal.view.output.length, fontFamily: this.typography.terminalFont, fontSize: this.typography.terminalSize, inputEnabled: connection?.ready === true && terminal.view.phase === "running" && !terminal.queue.paused } } : dock });
		if (pendingError) this.renderer.setConnection(pendingError, "error");
	}
	dispose(): void { window.removeEventListener("focus", this.refreshDesktopPreferences); clearTimeout(this.healthTimer); clearTimeout(this.oauthTimer); clearTimeout(this.mcpLoginTimer); clearTimeout(this.terminalTimer); this.client.retire(); }
}
