/// <reference lib="dom" />
import * as A from "./actions.ts";
import { commandPalette, parseCommandLine, type CommandLike } from "./commands.ts";
import { dockView, type WorkspaceStateLike } from "./dock.ts";
import { documentLanguage, resolveLocale, type Locale } from "./locale.ts";
import { MODEL_ENABLED_ACTION, PROVIDER_EDIT_ACTION, PROVIDER_EDIT_MODAL, PROVIDER_LOGOUT_ACTION, PROVIDER_LOGOUT_MODAL, PROVIDER_SELECT_ACTION, providerConfigurationModal, providerLogoutModal, type ModelConnectionsLike } from "./model-connections.ts";
import { modelScopeModal } from "./model-scope.ts";
import * as P from "./panels.ts";
import * as Projects from "./projects.ts";
import { collectPageElements, createRenderer, type PageRenderer } from "./render.ts";
import { providerLoginModal, type ProviderAuthLike } from "./provider-auth.ts";
import { ApiError, isRecord, parseContract } from "./python-api.ts";
import { PythonClient, type ClientConnection } from "./python-client.ts";
import type { AccountsView, HistoryPage, Identity, ImagePart, InterfacePreferences, ModelCatalog, OAuthView, ProductSettings, ProjectView, ResourceCatalog, Session, SessionModel, SkillDocument, TerminalView, UsageReport, WorkspaceGrantView } from "./python-contracts.ts";
import { pythonDirectory, pythonView } from "./python-view.ts";
import { PendingWrites, newId } from "./python-writes.ts";
import { seq, settled } from "./python-stream.ts";
import { TerminalInputQueue } from "./python-terminal.ts";
import { followSystemTheme, applyTheme, resolveThemePreference } from "./theme.ts";
import { adjustedFontSizes, DEFAULT_TYPOGRAPHY, FONT_FAMILY_FIELDS, FONT_SIZE_FIELDS, FONT_SIZE_LIMITS, resolveTypography, type Typography } from "./typography.ts";
import { attachmentRejection, attachments, type SubmitMode } from "./view.ts";

const OAUTH_METHODS: Readonly<Record<string, "browser" | "device_code">> = {
	anthropic: "browser", openai: "browser", "openai-codex": "browser", openrouter: "browser", "github-copilot": "device_code", "kimi-coding": "device_code", xai: "device_code", meta: "device_code",
};
interface ImageDraft { readonly id: string; readonly name: string; readonly dataUrl: string; readonly bytes: number; readonly image: ImagePart }
interface Draft { text: string; images: ImageDraft[] }
interface ActiveTerminal { readonly connection: ClientConnection; readonly id: string; readonly queue: TerminalInputQueue; view: TerminalView; desiredSize?: { cols: number; rows: number }; resizing: boolean }

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
	private selection?: SessionModel;
	private resources?: ResourceCatalog;
	private usage?: UsageReport;
	private history?: HistoryPage;
	private historyLoading = false;
	private historyGeneration = 0;
	private historyConnection?: ClientConnection;
	private historyLatestRevision = 0n;
	private historyStarted = false;
	private currentPanel = P.CHAT_VIEW;
	private modal?: P.PanelModal;
	private notice?: P.PanelNotice;
	private pendingModal?: P.PanelModal;
	private get modalPending(): boolean { return this.modal !== undefined && this.pendingModal === this.modal; }
	private rosterFilter = "";
	private draft: Draft = { text: "", images: [] };
	private readonly drafts = new Map<string, Draft>();
	private readonly writes = new Map<string, PendingWrites>();
	private mode: SubmitMode = "followUp";
	private thinking = "off";
	private selectedProvider?: string;
	private enabledModels: string[] | null = null;
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
	private readonly commands: CommandLike[] = [
		{ name: "new", description: "新建会话" }, { name: "model", description: "模型与连接" }, { name: "settings", description: "设置" },
		{ name: "compact", description: "压缩上下文" }, { name: "fork", description: "创建分支" }, { name: "export", description: "导出会话" },
	];
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
		this.renderer.onDraftChange = text => { this.draft.text = text; this.paletteSelection = 0; this.render(); };
		this.renderer.onPaletteSelection = index => { this.paletteSelection = index; this.render(); };
		this.renderer.onCommandPick = value => { this.draft.text = `/${value} `; this.renderer.setDraft(this.draft.text, true); this.render(); };
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
	async start(): Promise<void> {
		const token = new URLSearchParams(location.hash.slice(1)).get("token");
		if (token) {
			const response = await fetch("/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
			if (!response.ok) throw new ApiError(response.status, await response.json());
			history.replaceState(null, "", location.pathname + location.search);
		}
		try { await this.client.bootstrap(); }
		catch (error) {
			if (!(error instanceof ApiError) || error.status !== 401) throw error;
			this.modal = { id: "auth:pair", title: "连接 AmazMe", description: "输入本机启动器提供的配对令牌。", fields: [{ id: "token", label: "配对令牌", kind: "text", inputType: "password", value: "" }], submit: "连接" };
			this.render(); return;
		}
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
		const connection = this.client.connection, resourcesGeneration = ++this.resourceGeneration;
		const [sessions, workspaces, catalog, accounts, settings, projects, resources] = await Promise.all([
			this.client.call("GET /api/v1/sessions"), this.client.call("GET /api/v1/workspaces"), this.client.call("GET /api/v1/models"), this.client.call("GET /api/v1/accounts"), this.client.call("GET /api/v1/settings"),
			this.client.call("GET /api/v1/projects"),
			this.client.call("GET /api/v1/skills", { query: { session_id: connection?.sessionId ?? "" } }),
		]);
		if (generation === this.globalLoadGeneration) {
			this.sessions = sessions.sessions; this.workspaces = workspaces.workspaces; this.catalog = catalog; this.accounts = accounts; this.settings = settings;
			this.projects = projects.projects ?? [];
			if (this.client.connection === connection && resourcesGeneration === this.resourceGeneration) this.resources = resources;
			this.applyPreferences(settings.preferences ?? {});
		}
	}
	private async loadSession(connection: ClientConnection): Promise<void> {
		const selectionGeneration = ++this.selectionGeneration;
		const resourceGeneration = ++this.resourceGeneration;
		const [selection, resources, usage] = await Promise.all([
			this.client.call("GET /api/v1/session-models/{session_id}", { path: { session_id: connection.sessionId } }).catch(error => { if (error instanceof ApiError && error.code === "session_model_missing") return undefined; throw error; }),
			this.client.call("GET /api/v1/sessions/{session}/resources", { path: { session: connection.sessionId } }),
			this.client.call("GET /api/v1/sessions/{session_id}/usage", { path: { session_id: connection.sessionId } }),
		]);
		if (!connection.active()) return;
		if (selectionGeneration === this.selectionGeneration) this.selection = selection;
		if (resourceGeneration === this.resourceGeneration) this.resources = resources;
		this.usage = usage;
		await this.loadHistory(connection, false);
		if (this.dockOpen && this.dockTab === "terminal") await this.loadTerminal(connection);
		this.render();
		clearTimeout(this.healthTimer);
		this.healthTimer = setTimeout(() => { void this.poll(connection); }, 3000);
	}
	private async poll(connection: ClientConnection): Promise<void> {
		try {
			const health = await this.client.call("GET /api/v1/health");
			if (!connection.active()) return;
			if (health.identity.profile_id !== connection.identity.profile_id) throw new Error("宿主身份已更换");
			if (health.identity.host_epoch !== connection.identity.host_epoch || health.identity.build_id !== connection.identity.build_id) { await this.client.connect(connection.sessionId); return; }
			this.ready = health.state === "ready";
			this.render();
		} catch (error) { if (connection.active()) this.error(error); }
		finally { if (connection.active()) this.healthTimer = setTimeout(() => { void this.poll(connection); }, 3000); }
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
		this.draft = this.drafts.get(id) ?? { text: "", images: [] };
		this.selection = undefined; this.resources = undefined; this.usage = undefined; this.workspace = undefined;
		this.history = undefined; this.historyLatestRevision = 0n; this.historyStarted = false; this.historyGeneration++; this.historyLoading = false;
		this.terminal = undefined; this.terminalLoadGeneration++; clearTimeout(this.terminalTimer);
		this.modal = undefined; this.notice = undefined; this.currentPanel = P.CHAT_VIEW;
		clearTimeout(this.oauthTimer); this.oauth = undefined;
		const url = new URL(location.href);
		url.searchParams.set("host", this.client.identity?.profile_id ?? ""); url.searchParams.set("workspace", session.workspace ?? "primary"); url.searchParams.set("session", id); url.searchParams.delete("new");
		history.replaceState(null, "", url);
		this.renderer.setDraft(this.draft.text);
		await this.client.connect(id);
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
	private async submit(text: string): Promise<void> {
		const command = parseCommandLine(text);
		if (command && this.commands.some(item => item.name === command.name)) {
			await this.command(command.name, command.args); this.draft.text = ""; this.renderer.setDraft(""); this.render(); return;
		}
		const connection = this.requireConnection(), ledger = this.ledger(connection), draft = this.draft;
		const displayedModel = this.selection ?? this.catalog?.current;
		const root = connection.snapshot?.requests.find(item => item.kind === "root" && !settled.has(item.status));
		const thinking = this.catalog?.models.find(item => item.provider === this.selection?.provider && item.model === this.selection.model)?.thinking_levels?.find(level => level === this.thinking);
		const record = ledger.prepare("submission", "POST /api/v1/sessions/{session}/submissions", id => ({ path: { session: connection.sessionId }, body: {
			request_id: id, text, images: draft.images.map(item => item.image), mode: this.mode === "steer" ? "steer" : "queue",
			...(this.mode === "steer" ? { target_run_id: root?.run_id } : {
				...(displayedModel ? { model_selection: { provider: displayedModel.provider, model: displayedModel.model } } : {}), ...(thinking ? { thinking } : {}),
			}),
		} }));
		this.render();
		try {
			await ledger.send("submission", record, this.client, connection);
			if (connection.active() && this.draft === draft && draft.text.trim() === record.body.text.trim() && JSON.stringify(draft.images.map(item => item.image)) === JSON.stringify(record.body.images ?? [])) {
				this.draft = { text: "", images: [] }; this.renderer.setDraft("");
			}
		} finally { if (connection.active()) this.render(); }
	}
	private async cancel(id?: string): Promise<void> {
		const connection = this.requireConnection();
		const request = id ?? connection.snapshot?.requests.find(item => item.kind === "root" && !settled.has(item.status))?.request_id;
		if (!request) return;
		await this.client.call("POST /api/v1/sessions/{session}/requests/{request_id}/cancel", { path: { session: connection.sessionId, request_id: request }, connection });
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
	private async fork(sessionId = this.requireConnection().sessionId): Promise<void> {
		const navigation = this.navigationGeneration;
		const session = await this.client.withSession(sessionId, async connection => {
			const ledger = this.ledger(connection);
			let record = ledger.read("branch", "POST /api/v1/sessions/{session}/branches");
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
			clearTimeout(this.oauthTimer);
		}
		if (action.kind === "open") { this.currentPanel = action.panel; this.modal = undefined; this.render(); return; }
		if (action.kind === "modal-close") { this.modal = undefined; this.render(); return; }
		const id = action.id, data = action.data;
		const fields = action.kind === "modal-submit" ? action.fields : {};
		const value = action.kind === "control" ? action.value : data ?? "";
		if (await this.managementAction(id, data, fields)) return;
		if (await this.skillAction(action)) return;
		if (id === A.HISTORY_MORE_ACTION || id === A.TRANSCRIPT_SEARCH_ACTION) {
			await this.loadHistory(this.requireConnection(), true, id === A.TRANSCRIPT_SEARCH_ACTION);
			if (id === A.TRANSCRIPT_SEARCH_ACTION) this.renderer.refreshTranscriptSearch();
			return;
		}
		if (id === "auth:pair") {
			const response = await fetch("/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: fields.token }) });
			if (!response.ok) throw new ApiError(response.status, await response.json()); this.modal = undefined; await this.start(); return;
		}
		if (id === A.WELCOME_SESSION_ACTION) { await this.createSession(); return; }
		if (id === A.WELCOME_SETTINGS_ACTION || id === A.MODEL_CONNECTIONS_ACTION) { this.currentPanel = P.SETTINGS_VIEW; this.modal = undefined; this.render(); return; }
		if (id === A.WELCOME_DISMISS_ACTION) { await this.setPreference("showWelcome", "false"); return; }
		if (id === A.DOCK_TOGGLE_ACTION) { this.dockOpen = !this.dockOpen; this.render(); return; }
		if (id === A.DOCK_TAB_ACTION) { this.dockTab = value; this.dockOpen = true; if (value === "files") await this.openWorkspace(); if (value === "terminal") await this.loadTerminal(this.requireConnection(), true); this.render(); return; }
		if (id === A.WORKSPACE_OPEN_ACTION || id === A.WORKSPACE_READ_ACTION) { await this.openWorkspace(value, id === A.WORKSPACE_READ_ACTION); return; }
		if (id === A.SUBMIT_MODE_ACTION) { this.mode = value === "steer" ? "steer" : "followUp"; this.render(); return; }
		if (id === A.ATTACHMENT_REMOVE_ACTION) { this.draft.images = this.draft.images.filter(item => item.id !== data); this.render(); return; }
		if (id === A.QUEUE_CANCEL_ACTION) { await this.cancel(data); return; }
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
		if (id === "write:retry-submit") { await this.submit(this.draft.text); return; }
		if (id === "write:cancel-submit") {
			const connection = this.requireConnection(), ledger = this.ledger(connection);
			const record = ledger.read("submission", "POST /api/v1/sessions/{session}/submissions");
			if (record) { await this.cancel(record.body.request_id); ledger.forget("submission", record); if (connection.active()) this.render(); }
			return;
		}
		if (id === A.CONVERSATION_FORK_ACTION || id === "write:retry-branch") { await this.fork(data); return; }
		if (id === A.COMPACT_ACTION) { this.modal = P.compactModal(this.locale); this.render(); return; }
		if (id === A.COMPACT_MODAL) {
			const connection = this.requireConnection(), ledger = this.ledger(connection);
			const through = connection.snapshot?.requests.findLast(item => item.kind === "root" && settled.has(item.status));
			if (!through) throw new Error("没有可压缩的已完成回合");
			const record = ledger.prepare("compaction", "POST /api/v1/sessions/{session}/compactions", id => ({ path: { session: connection.sessionId }, body: { compaction_id: id, through_request_id: through.request_id } }));
			await ledger.send("compaction", record, this.client, connection); if (connection.active()) { this.modal = undefined; this.render(); } return;
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
		if (id === A.MODEL_SELECT_ACTION) { const selected: unknown = JSON.parse(value); if (!Array.isArray(selected) || selected.length !== 2 || !selected.every(item => typeof item === "string")) throw new Error("模型选择无效"); await this.selectModel(selected[0], selected[1]); return; }
		if (id === A.MODEL_THINKING_ACTION) { this.thinking = value; this.render(); return; }
		if (id === A.REFRESH_MODELS_ACTION || id === P.SETTINGS_RELOAD_ACTION || id === A.SESSION_RELOAD_ACTION) { await this.loadGlobal(); const connection = this.client.connection; if (connection?.ready) await this.loadSession(connection); this.render(); return; }
		if (id === A.MODEL_SCOPE_ACTION) { this.modal = modelScopeModal(this.locale, { allModels: this.catalog?.models.map(item => ({ provider: item.provider, id: item.model, name: item.label })) ?? [], enabledModelIds: this.enabledModels }); this.render(); return; }
		if (id === A.MODEL_SCOPE_MODAL) { const ids: unknown = JSON.parse(fields.models || "null"); if (ids !== null && (!Array.isArray(ids) || !ids.every(item => typeof item === "string"))) throw new Error("模型范围无效"); this.enabledModels = ids; this.modal = undefined; this.render(); return; }
		if (id === PROVIDER_SELECT_ACTION) { this.selectedProvider = data; this.render(); return; }
		if (id === PROVIDER_EDIT_ACTION) {
			const connections = this.connections(), provider = connections.state.providers.find(item => item.id === data);
			this.modal = providerConfigurationModal(this.locale, provider, connections.models, connections.state.authentication.providers, provider ? connections.state.authentication.providers.find(item => item.id === provider.id)?.methods ?? [] : []);
			this.render(); return;
		}
		if (id === PROVIDER_LOGOUT_ACTION) { this.modal = providerLogoutModal(this.locale, data ?? "", data ?? ""); this.render(); return; }
		if (id === PROVIDER_EDIT_MODAL || id === PROVIDER_LOGOUT_MODAL) { await this.saveProvider(data, fields, id === PROVIDER_LOGOUT_MODAL); return; }
		if (id === A.PROVIDER_AUTH_OPEN_ACTION) { if (!data || !/^https?:\/\//.test(data)) throw new Error("授权链接无效"); window.open(data, "_blank", "noopener,noreferrer"); return; }
		if (id === A.PROVIDER_AUTH_CANCEL_ACTION && this.oauth) { const login = this.oauth, connection = this.requireConnection(); await this.client.call("DELETE /api/v1/accounts/oauth/{login_id}", { path: { login_id: login.login_id }, connection }); if (connection.active() && this.oauth === login) { this.oauth = undefined; this.modal = undefined; clearTimeout(this.oauthTimer); this.render(); } return; }
		if (id === A.PROVIDER_AUTH_MODAL && this.oauth) { const login = this.oauth, connection = this.requireConnection(); await this.client.call("POST /api/v1/accounts/oauth/{login_id}/input", { path: { login_id: login.login_id }, body: { value: fields.value ?? "" }, connection }); return; }
		if (id === MODEL_ENABLED_ACTION) { const all = this.catalog?.models.map(item => `${item.provider}/${item.model}`) ?? []; const selected = new Set(this.enabledModels ?? all); if (value === "true") selected.add(data ?? ""); else selected.delete(data ?? ""); this.enabledModels = [...selected]; this.render(); return; }
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
			this.drafts.delete(data);
			await this.loadGlobal();
			if (this.modal === modal) this.modal = undefined;
			if (navigation === this.navigationGeneration && this.client.connection?.sessionId === data) {
				this.client.retire(); this.draft = { text: "", images: [] }; this.renderer.setDraft("");
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
			const events = new Map([...(previous?.events ?? []), ...page.events].map(event => [`${event.request_id}:${event.kind}:${event.text}`, event]));
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
	private async openWorkspace(path?: string, file = false): Promise<void> {
		const connection = this.requireConnection();
		const generation = ++this.workspaceGeneration;
		const session = this.sessions.find(item => item.session_id === connection.sessionId);
		const cwd = this.workspaces.find(item => item.name === session?.workspace)?.host_path ?? "";
		const name = session?.workspace ?? "primary", prefix = name === "primary" ? "" : `grant/${name}/`;
		const relative = path ? path.startsWith(cwd + "/") ? prefix + path.slice(cwd.length + 1) : path === cwd ? prefix : path : prefix;
		if (file) { const result = await this.client.call("GET /api/v1/files/content", { query: { path: relative } }); if (!connection.active() || generation !== this.workspaceGeneration) return; this.workspace = { cwd, view: { kind: "text", path: result.absolute_path ?? result.path, text: result.content, truncated: result.truncated ?? false } }; }
		else { const result = await this.client.call("GET /api/v1/files", { query: { path: relative } }); if (!connection.active() || generation !== this.workspaceGeneration) return; this.workspace = { cwd, view: { kind: "listing", path: result.absolute_path ?? cwd, parent: (result.absolute_path ?? cwd) === cwd ? null : (result.absolute_path ?? cwd).split("/").slice(0, -1).join("/"), entries: result.entries.map(item => ({ ...item, kind: item.kind === "dir" ? "dir" : "file" })) } }; }
		this.dockOpen = true; this.dockTab = "files"; this.render();
	}
	private authentication(): ProviderAuthLike {
		const ids = [...new Set([...(this.catalog?.models.map(item => item.provider) ?? []), ...Object.keys(OAUTH_METHODS)])];
		const providers: ProviderAuthLike["providers"] = ids.map(id => ({ id, name: id, configured: this.accounts.accounts.some(item => item.provider === id), methods: [{ type: "api_key", label: "API Key" }, ...(OAUTH_METHODS[id] ? [{ type: "oauth" as const, label: "登录" }] : [])] }));
		const login = this.oauth;
		return { providers, login: login ? { id: login.login_id, provider: login.provider, status: login.phase === "pending" ? "awaiting" : login.phase === "complete" ? "done" : login.phase === "cancelled" ? "cancelled" : "error", authorization: login.url ? login.user_code ? { type: "device_code", userCode: login.user_code, verificationUri: login.url } : { type: "auth_url", url: login.url } : null, message: null, links: [], prompt: login.phase === "pending" && !login.user_code ? { id: login.login_id, type: "secret", message: "回调地址或授权码" } : null, error: login.error ?? null } : null };
	}
	private connections(): ModelConnectionsLike {
		const authentication = this.authentication();
		const current = this.catalog?.current;
		const models = this.catalog?.models.map(item => ({ provider: item.provider, modelId: item.model, name: item.label, available: this.accounts.accounts.some(account => account.provider === item.provider) || (current?.provider === item.provider && current.key_configured) })) ?? [];
		return { state: { providers: authentication.providers.map(provider => { const model = this.catalog?.models.find(item => item.provider === provider.id); return { id: provider.id, name: provider.name, configured: provider.configured, baseUrl: current?.provider === provider.id ? current.base_url : model?.base_url ?? "", api: current?.provider === provider.id ? current.api ?? "openai-completions" : model?.api ?? "openai-completions", modelCount: models.filter(item => item.provider === provider.id).length, custom: false, verification: { status: "idle" } }; }), authentication, enabledModelIds: this.enabledModels, defaults: current ? { model: { provider: current.provider, modelId: current.model }, thinkingLevel: "off" } : null, error: null, refresh: { status: "idle" } }, selected: this.selectedProvider, models, enabledModels: models.filter(item => this.enabledModels === null || this.enabledModels.includes(`${item.provider}/${item.modelId}`)), loading: false, disabled: !this.ready };
	}
	private async saveProvider(data: string | undefined, fields: Readonly<Record<string, string>>, clear: boolean): Promise<void> {
		if (this.modalPending) return;
		const connection = this.requireConnection(), provider = data ?? fields.id;
		if (!provider) throw new Error("请选择供应商");
		const modal = this.modal;
		const generation = this.modalGeneration;
		this.pendingModal = modal; this.render();
		try {
			const latest = await this.client.call("GET /api/v1/accounts");
			if (!connection.active()) return;
			if (clear) await this.client.call("POST /api/v1/accounts/{provider}", { path: { provider }, body: { expected_revision: latest.revision, clear: true }, connection });
			else if (fields[`method:${provider}`] === "oauth" || (!fields[`key:${provider}`] && OAUTH_METHODS[provider] && !latest.accounts.some(item => item.provider === provider))) {
				const key = `amazme:oauth:${connection.identity.profile_id}:${provider}`;
				const id = sessionStorage.getItem(key) ?? newId(); sessionStorage.setItem(key, id);
				const login = await this.client.call("POST /api/v1/accounts/oauth", { body: { login_id: id, provider, expected_revision: latest.revision, method: OAUTH_METHODS[provider] ?? "browser" }, connection });
				if (connection.active() && this.modal === modal) { this.oauth = login; this.showOAuth(connection, login, generation); } return;
			} else {
				const key = fields[`key:${provider}`] ?? "";
				if (key) await this.client.call("POST /api/v1/accounts/{provider}", { path: { provider }, body: { expected_revision: latest.revision, api_key: key }, connection });
				const model = this.catalog?.models.find(item => item.provider === provider);
				if (model && fields.baseUrl) await this.client.call("POST /api/v1/models", { body: { provider, model: model.model, base_url: fields.baseUrl }, connection });
			}
			const accounts = await this.client.call("GET /api/v1/accounts");
			if (connection.active() && this.modal === modal) { this.accounts = accounts; this.modal = undefined; this.render(); }
		} finally { if (this.pendingModal === modal) this.pendingModal = undefined; if (connection.active() && generation === this.modalGeneration) this.render(); }
	}
	private showOAuth(connection: ClientConnection, login: OAuthView, generation: number): void {
		if (!connection.active() || generation !== this.modalGeneration || this.oauth?.login_id !== login.login_id) return;
		this.oauth = login;
		const auth = this.authentication(); this.modal = providerLoginModal(this.locale, auth, auth.login); this.render();
		clearTimeout(this.oauthTimer);
		if (login.phase === "pending") this.oauthTimer = setTimeout(() => { void this.client.call("GET /api/v1/accounts/oauth/{login_id}", { path: { login_id: login.login_id } }).then(value => this.showOAuth(connection, value, generation)).catch(error => { if (connection.active() && generation === this.modalGeneration) this.error(error); }); }, 750);
		else { const key = `amazme:oauth:${connection.identity.profile_id}:${login.provider}`; if (sessionStorage.getItem(key) === login.login_id && login.phase !== "unknown") sessionStorage.removeItem(key); void this.client.call("GET /api/v1/accounts").then(accounts => { if (connection.active()) { this.accounts = accounts; this.render(); } }); }
	}
	private applyPreferences(preferences: InterfacePreferences): void {
		this.locale = resolveLocale(preferences.locale ?? "auto", navigator.languages);
		this.typography = resolveTypography(preferences);
		applyTheme(resolveThemePreference(preferences.appearance));
	}
	private updateSettings(update: (current: ProductSettings, identity: Identity) => Promise<ProductSettings>): Promise<void> {
		const identity = this.client.identity;
		if (!identity) return Promise.reject(new Error("请先连接后端"));
		const task = this.settingsQueue.catch(() => {}).then(async () => {
			const current = await this.client.call("GET /api/v1/settings");
			const settings = await update(current, identity);
			if (this.client.identity?.instance_id !== identity.instance_id) return;
			this.settings = settings; this.applyPreferences(settings.preferences ?? {}); this.render();
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
		const typed = id === "showWelcome" ? value === "true" : FONT_SIZE_FIELDS.some(field => field === id) ? Number(value) : value;
		await this.updatePreferences(current => parseContract("InterfacePreferences", { ...current, [id]: typed }));
	}
	private preferenceDescriptors(): P.SettingDescriptorLike[] {
		const preferences = this.settings?.preferences ?? {};
		const descriptor = { group: "interface", explicit: true };
		return [
			{ ...descriptor, id: "appearance", field: "appearance", kind: "enum", options: ["system", "light", "dark"], value: preferences.appearance ?? "system" },
			{ ...descriptor, id: "locale", field: "locale", kind: "enum", options: ["auto", "zh", "en"], value: preferences.locale ?? "auto" },
			...FONT_FAMILY_FIELDS.map(field => ({ ...descriptor, id: field, field, kind: "string" as const, value: preferences[field] ?? "" })),
			...FONT_SIZE_FIELDS.map(field => ({ ...descriptor, id: field, field, kind: "number" as const, value: String(this.typography[field]), ...FONT_SIZE_LIMITS[field], step: 1 })),
			{ ...descriptor, id: "showWelcome", field: "showWelcome", kind: "boolean", value: String(preferences.showWelcome ?? true) },
			{ ...descriptor, id: "display_name", field: "display_name", kind: "string", value: this.settings?.display_name ?? "" },
		];
	}
	private render(): void {
		document.documentElement.lang = documentLanguage(this.locale);
		const connection = this.client.connection, session = this.sessions.find(item => item.session_id === connection?.sessionId);
		const directory = pythonDirectory(this.sessions, this.projects, this.workspaces);
		const picker = pythonView({ locale: this.locale, typography: this.typography, sessions: this.sessions, projects: this.projects, selectedProject: this.selectedProject, expandedProjects: this.expandedProjects, workspaces: this.workspaces, connection, catalog: this.catalog, selection: this.selection, thinking: this.thinking, enabledModels: this.enabledModels,
			rosterFilter: this.rosterFilter, draft: this.draft.text, paletteSelection: this.paletteSelection, commands: this.commands, attachments: attachments(this.locale, this.draft.images),
			panel: P.panelView({ locale: this.locale, current: this.currentPanel, modal: this.modal, modalPending: this.modalPending, notice: this.notice,
				settings: { hostModels: true, state: { paths: { global: "AmazMe" }, projectTrusted: true, errors: [], descriptors: this.preferenceDescriptors() }, archives: { sessions: directory.sessions, projects: directory.projects ?? [], retentionDays: 0, now: Date.now() } },
				skills: { state: { directory: this.resources?.skill_directory ?? "", skills: this.resources?.skills.map(item => ({ name: item.name, description: item.description ?? "", filePath: item.path, scope: item.scope ?? "user", disableModelInvocation: item.disable_model_invocation ?? false, editable: item.editable ?? false })) ?? [], diagnostics: this.resources?.diagnostics.map(message => ({ message })) ?? [] } },
			}), connections: this.connections(), mode: this.mode, usage: this.usage, history: this.history, historyLoading: this.historyLoading,
			historyMore: this.history?.more === true || Boolean(connection && (connection.snapshot?.requests.filter(row => row.kind === "root" && settled.has(row.status)).length ?? 0) >= 20 && this.latestTranscriptRevision(connection) > this.historyLatestRevision),
			welcomeDismissed: this.settings?.preferences?.showWelcome === false, newSessionPending: this.newSessionPending, ready: this.ready });
		const cwd = this.workspaces.find(item => item.name === session?.workspace)?.host_path ?? "";
		let pendingError: string | undefined;
		const pending = (() => {
			try { return connection ? this.ledger(connection).read("submission", "POST /api/v1/sessions/{session}/submissions") : undefined; }
			catch (error) { pendingError = error instanceof Error ? error.message : String(error); return undefined; }
		})();
		let branchPending: string | undefined;
		try { branchPending = connection ? this.ledger(connection).read("branch", "POST /api/v1/sessions/{session}/branches")?.id : undefined; }
		catch (error) { pendingError = error instanceof Error ? error.message : String(error); }
		const terminal = this.terminal?.connection === connection ? this.terminal : undefined;
		const dock = dockView(this.locale, { open: this.dockOpen, tab: this.dockTab, cwd, workspace: this.workspace, terminal: terminal ? { status: terminal.view.phase === "running" ? "running" : "done", command: "/bin/zsh -il", exitCode: terminal.view.exit_code ?? null, output: "", truncated: false, error: null } : undefined, conversations: { selected: connection?.sessionId ?? "", conversations: this.sessions.filter(item => item.session_id === connection?.sessionId || item.session_id === session?.parent_id || item.parent_id === connection?.sessionId || Boolean(session?.parent_id && item.parent_id === session.parent_id)).map(item => ({ id: item.session_id, label: item.title, root: !item.parent_id, role: item.parent_id ? "fork" as const : "main" as const, parentConversationId: item.parent_id || undefined, children: this.sessions.filter(child => child.parent_id === item.session_id).length, hasEntries: true, ...(item.archived ? { archivedAt: item.updated_ms ?? 0 } : {}) })), tasks: (connection?.snapshot?.requests ?? []).map(item => ({ id: item.request_id, kind: item.kind ?? "root", conversationId: connection?.sessionId ?? "", background: item.kind === "child", status: item.status, phase: item.status, waitsOn: item.children ?? [], conversations: [] })) } });
		this.renderer.render({ ...picker, readOnly: picker.readOnly || Boolean(pendingError), queue: [...picker.queue, ...(branchPending ? [{ id: branchPending, text: "分支创建尚未确认", retry: { id: "write:retry-branch", label: "重试原分支", weight: "line" as const } }] : []), ...(pending ? [{ id: pending.id, text: `请求尚未确认：${pending.body.text}`, retry: { id: "write:retry-submit", label: "重试原请求", weight: "line" as const }, cancel: { id: "write:cancel-submit", label: "取消原请求", weight: "text" as const } }] : [])],
			dock: terminal && this.dockTab === "terminal" ? { ...dock, panel: { ...dock.panel, texts: [], notices: terminal.queue.paused ? [{ tone: "warning", text: "终端输入尚未确认；请重试原输入或核对后继续。" }] : dock.panel.notices, actions: [
				{ id: "terminal:retry", label: "重试原输入", weight: "line", disabled: terminal.queue.busy || !terminal.queue.items.length },
				{ id: "terminal:confirm", label: "核对后继续", weight: "text", disabled: terminal.queue.busy || !terminal.queue.items.length },
			] }, pty: { id: terminal.id, cols: terminal.view.cols, rows: terminal.view.rows, output: terminal.view.output, outputSeq: terminal.view.output_seq ?? terminal.view.output.length, fontFamily: this.typography.terminalFont, fontSize: this.typography.terminalSize, inputEnabled: connection?.ready === true && terminal.view.phase === "running" && !terminal.queue.paused } } : dock });
		if (pendingError) this.renderer.setConnection(pendingError, "error");
	}
	dispose(): void { clearTimeout(this.healthTimer); clearTimeout(this.oauthTimer); clearTimeout(this.terminalTimer); this.client.retire(); }
}
