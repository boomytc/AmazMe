/// <reference lib="dom" />
import * as A from "../actions.ts";
import { type CommandLike, parseCommandLine } from "../commands.ts";
import { dockView, parseWorkspaceAction } from "../dock.ts";
import type {
	AnswerFeedbackList,
	GitDiff,
	Identity,
	PluginCallView,
	ProjectView,
	ResourceCatalog,
	Session,
	SessionModel,
	SkillDocument,
	UsageReport,
	WorkspaceGrantView,
} from "../generated/contracts.ts";
import { documentLanguage, type Locale } from "../locale.ts";
import {
	MODEL_ENABLED_ACTION,
	PROVIDER_EDIT_ACTION,
	PROVIDER_EDIT_MODAL,
	PROVIDER_LOGOUT_ACTION,
	PROVIDER_LOGOUT_MODAL,
	PROVIDER_SELECT_ACTION,
	PROVIDER_TEST_ACTION,
	PROVIDER_TEST_ALL_ACTION,
	PROVIDER_TEST_MODAL,
	providerConfigurationModal,
	providerLogoutModal,
	providerTestModal,
} from "../model-connections.ts";
import { modelScopeModal } from "../model-scope.ts";
import * as P from "../panels.ts";
import type { ApprovalPolicy } from "../permission-picker.ts";
import * as Projects from "../projects.ts";
import { providerAuthModal } from "../provider-auth.ts";
import type { PageRenderer } from "../render.ts";
import { translate } from "../strings.ts";
import { followSystemTheme } from "../theme.ts";
import { toolResultView } from "../tool-results.ts";
import { ApiError, isRecord, parseContract } from "../transport/api.ts";
import { type ClientConnection, PythonClient } from "../transport/client.ts";
import { settled } from "../transport/stream.ts";
import { adjustedFontSizes, resolveTypography } from "../typography.ts";
import { USAGE_ACTION, USAGE_REFRESH_ACTION } from "../usage.ts";
import { attachments, type SubmitMode, type TranscriptBlock } from "../view.ts";
import { Automation, scheduleRecord } from "./automation.ts";
import { type Draft, DraftBook } from "./drafts.ts";
import { HistoryCache } from "./history-cache.ts";
import { Integrations } from "./integrations.ts";
import { InterfaceSettings } from "./interface-settings.ts";
import { modelReference } from "./model-reference.ts";
import { PanelsState } from "./panels-state.ts";
import { newId, PendingWrites } from "./pending/writes.ts";
import { Providers } from "./providers.ts";
import type { PageServices } from "./services.ts";
import { pythonDirectory, pythonView } from "./view.ts";
import { WorkspaceController } from "./workspace-controller.ts";

const connectedCopy = (locale: Locale): string =>
	translate(locale, "connection.stateConnected");
const connectingCopy = (locale: Locale): string =>
	translate(locale, "connection.connecting");
const disconnectedCopy = (locale: Locale): string =>
	translate(locale, "connection.stateDisconnected");

/** One window owns command admission, protocol callbacks and feature controllers. */
export class PageRuntime {
	readonly client: PythonClient;
	private readonly providers: Providers;
	private readonly automation: Automation;
	private readonly integrations: Integrations;
	private readonly services: PageServices;
	private readonly preferences: InterfaceSettings;
	private readonly dock: WorkspaceController;
	private readonly transcript: HistoryCache;
	readonly renderer: PageRenderer;
	private disposed = false;
	private starting?: Promise<void>;
	private readonly stopTheme: () => void;
	private sessions: Session[] = [];
	private workspaces: WorkspaceGrantView[] = [];
	private projects: ProjectView[] = [];
	private selectedProject?: string;
	private expandedProjects: readonly string[] = [];
	private sessionEdit?: Session;
	private projectEdit?: ProjectView;
	private skillEdit?: {
		readonly document: SkillDocument;
		readonly sessionId: string;
		readonly modal: P.PanelModal;
	};
	private desktop = false;
	private readonly refreshDesktopPreferences = (): void => {
		if (this.ready)
			void this.preferences
				.updateSettings(async (current) => current)
				.catch(() => {});
	};
	private selection?: SessionModel;
	private resources?: ResourceCatalog;
	private usage?: UsageReport;
	private usageGeneration = 0;
	private readonly panels = new PanelsState();
	private rosterFilter = "";
	private readonly drafts = new DraftBook();
	private readonly writes = new Map<string, PendingWrites>();
	private mode: SubmitMode = "followUp";
	private thinking = "off";
	private feedback?: AnswerFeedbackList;
	private readonly commandResults = new Map<
		string,
		Map<string, { name: string; result: PluginCallView }>
	>();
	private enabledModels: string[] | null = null;
	private readonly modelScopes = new Map<string, string[] | null>();
	private paletteSelection = 0;
	private newSessionPending = false;
	private permissionWrites = new Map<string, Promise<void>>();
	private confirmedPermissions = new Map<string, ApprovalPolicy>();
	private ready = false;
	private healthTimer?: ReturnType<typeof setTimeout>;
	private metadataConnection?: ClientConnection;
	private navigationGeneration = 0;
	private globalLoadGeneration = 0;
	private resourceGeneration = 0;
	private interactionGeneration = 0;
	private selectionGeneration = 0;
	private get commands(): CommandLike[] {
		const builtins: CommandLike[] = [
			{ name: "new", description: "新建会话", source: "builtin" },
			{ name: "model", description: "模型与连接", source: "builtin" },
			{ name: "settings", description: "设置", source: "builtin" },
			{ name: "compact", description: "压缩上下文", source: "builtin" },
			{ name: "fork", description: "创建分支", source: "builtin" },
			{ name: "export", description: "导出会话", source: "builtin" },
			{
				name: "diff",
				description: "只读审阅本地 Git 变更",
				argumentHint: "[uncommitted|unstaged|staged]",
				source: "builtin",
			},
		];
		const commands = new Map(builtins.map((item) => [item.name, item]));
		for (const plugin of this.integrations.pluginRuntime)
			if (plugin.phase === "ready")
				for (const item of plugin.tools ?? [])
					if (item.kind === "command" && !commands.has(item.name))
						commands.set(item.name, {
							name: item.name,
							description: item.description,
							source: "plugin",
						});
		for (const item of this.resources?.prompts ?? [])
			if (!commands.has(item.name))
				commands.set(item.name, {
					name: item.name,
					description: item.description ?? "",
					source: "template",
				});
		for (const item of this.resources?.skills ?? [])
			commands.set(`skill:${item.name}`, {
				name: `skill:${item.name}`,
				description: item.description ?? "",
				source: "skill",
			});
		return [...commands.values()];
	}
	constructor(renderer: PageRenderer, origin = location.origin) {
		this.renderer = renderer;
		this.client = new PythonClient(origin);
		this.services = {
			client: this.client,
			panels: this.panels,
			locale: () => this.preferences.locale,
			changed: () => this.render(),
			error: (error) => this.error(error),
			hostActive: (identity) => this.hostActive(identity),
			connection: () => this.requireConnection(),
			ledger: (connection) => this.ledger(connection),
			hostLedger: (identity) => this.hostLedger(identity),
		};
		this.integrations = new Integrations(this.services);
		this.providers = new Providers({
			...this.services,
			refresh: () => this.loadGlobal(),
			ready: () => this.ready,
			globalModels: () => this.preferences.globalModelIds,
		});
		this.automation = new Automation({
			...this.services,
			context: () => ({
				sessions: this.sessions,
				workspaces: this.workspaces,
				catalog: this.providers.catalog,
				selection: this.selection,
			}),
			openSession: async (id) => {
				const identity = this.client.identity,
					navigation = this.navigationGeneration;
				await this.loadGlobal();
				if (
					identity &&
					this.hostActive(identity) &&
					navigation === this.navigationGeneration &&
					this.panels.current === P.AUTOMATION_VIEW
				)
					await this.selectSession(id);
			},
		});
		this.preferences = new InterfaceSettings({
			client: this.client,
			active: (identity) => this.hostActive(identity),
			catalog: () => this.providers.catalog,
			applied: () => {
				const session = this.client.connection?.sessionId;
				this.enabledModels = session
					? this.sessionModelIds(session)
					: this.preferences.globalModelIds;
			},
			changed: () => this.render(),
			error: (error) => this.error(error),
		});
		this.transcript = new HistoryCache(this.client, () => this.render());
		this.dock = new WorkspaceController({
			client: this.client,
			connection: () => this.requireConnection(),
			ledger: (connection) => this.ledger(connection),
			changed: () => this.render(),
			error: (error) => this.error(error),
			context: () => ({
				sessions: this.sessions,
				projects: this.projects,
				workspaces: this.workspaces,
				locale: this.preferences.locale,
			}),
		});
		const boot: unknown = Reflect.get(globalThis, "__AMAZME_BOOT__");
		const preferences = parseContract(
			"InterfacePreferences",
			isRecord(boot) ? (boot.preferences ?? {}) : {},
		);
		this.preferences.applyPreferences(preferences);
		this.client.onStatus = (status) => {
			this.renderer.setConnectionState(
				status === "connected"
					? connectedCopy
					: status === "disconnected"
						? disconnectedCopy
						: connectingCopy,
				status === "connected"
					? "connected"
					: status === "disconnected"
						? "disconnected"
						: "connecting",
			);
		};
		this.client.onError = (error) => this.error(error);
		this.client.onChange = () => {
			const connection = this.client.connection;
			this.render();
			if (connection?.ready && this.metadataConnection !== connection) {
				this.metadataConnection = connection;
				void this.loadSession(connection).catch((error) => {
					if (connection.active()) this.error(error);
				});
			}
		};
		const run = (work: () => Promise<void>) => {
			if (this.disposed) return;
			const connection = this.client.connection;
			const generation = ++this.interactionGeneration;
			void work().catch((error) => {
				if (
					generation === this.interactionGeneration &&
					(!connection || connection.active())
				)
					this.error(error);
			});
		};
		this.renderer.onCreateSession = () => run(() => this.createSession());
		this.renderer.onSelect = (id) => run(() => this.selectSession(id));
		this.renderer.onSubmit = (text) => run(() => this.submit(text));
		this.renderer.onAbort = () => run(() => this.cancel());
		this.renderer.onSelectModel = (provider, model) =>
			run(() => this.selectModel(provider, model));
		this.renderer.onSelectThinking = (level) => {
			this.thinking = level;
			this.render();
		};
		this.renderer.onSelectPermission = (policy) =>
			run(async () => {
				const connection = this.requireConnection();
				const key = this.permissionKey(connection);
				if (!this.confirmedPermissions.has(key))
					this.confirmedPermissions.set(key, this.approvalPolicy);
				sessionStorage.setItem(this.permissionKey(connection), policy);
				this.render();
				const prior = this.permissionWrites.get(key) ?? Promise.resolve();
				const write = prior
					.catch(() => {})
					.then(async () => {
						await this.client.call(
							"PUT /api/v1/sessions/{session}/approval-policy",
							{
								path: { session: connection.sessionId },
								body: { policy },
								connection,
							},
						);
						this.confirmedPermissions.set(key, policy);
					});
				this.permissionWrites.set(key, write);
				try {
					await write;
				} catch (error) {
					if (this.permissionWrites.get(key) === write) {
						const confirmed = this.confirmedPermissions.get(key);
						if (confirmed) sessionStorage.setItem(key, confirmed);
						if (connection.active()) this.render();
					}
					throw error;
				} finally {
					if (this.permissionWrites.get(key) === write)
						this.permissionWrites.delete(key);
				}
			});
		this.renderer.onDraftChange = (text) => {
			this.drafts.current.text = text;
			this.drafts.current.revision++;
			this.paletteSelection = 0;
			this.render();
		};
		this.renderer.onPaletteSelection = (index) => {
			this.paletteSelection = index;
			this.render();
		};
		this.renderer.onCommandPick = (value) => {
			this.drafts.current.text = `/${value} `;
			this.drafts.current.revision++;
			this.renderer.setDraft(this.drafts.current.text, true);
			this.render();
		};
		this.renderer.onFilterRoster = (text) => {
			this.rosterFilter = text;
			this.render();
		};
		this.renderer.onAttachFiles = (files) => run(() => this.attachFiles(files));
		this.renderer.onPanelAction = (action) => run(() => this.action(action));
		this.renderer.onTerminalInput = (id, data) => {
			const terminal = this.dock.terminal;
			if (terminal && terminal.id === id && terminal.connection.active()) {
				try {
					terminal.queue.enqueue(data);
				} catch (error) {
					this.error(error);
				}
			}
		};
		this.renderer.onTerminalResize = (id, cols, rows) => {
			const terminal = this.dock.terminal;
			if (terminal && terminal.id === id && terminal.connection.active()) {
				terminal.desiredSize = { cols, rows };
				run(() => this.dock.resizeTerminal(terminal));
			}
		};
		this.renderer.onShortcut = (id) => {
			if (id === "session.new") run(() => this.createSession());
			else if (id === "run.stop") run(() => this.cancel());
			else if (id.startsWith("font."))
				run(() =>
					this.preferences.updatePreferences((preferences) => ({
						...preferences,
						...adjustedFontSizes(
							resolveTypography(preferences),
							id === "font.increase"
								? "increase"
								: id === "font.decrease"
									? "decrease"
									: "reset",
						),
					})),
				);
			else if (id === "view.cycle")
				run(() =>
					this.action({
						kind: "command",
						id: A.DOCK_TOGGLE_ACTION,
						data: undefined,
					}),
				);
		};
		const bridge: unknown = Reflect.get(globalThis, "amazmeDesktop");
		if (isRecord(bridge) && typeof bridge.pickDirectories === "function") {
			this.desktop = true;
			window.addEventListener("focus", this.refreshDesktopPreferences);
			const pick = bridge.pickDirectories.bind(bridge);
			this.renderer.onPickDirectories = async () => {
				const value: unknown = await pick();
				if (
					!Array.isArray(value) ||
					!value.every((item) => typeof item === "string")
				)
					return undefined;
				return value;
			};
		}
		this.stopTheme = followSystemTheme();
		this.render();
	}
	private error(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.panels.notice = { tone: "error", text: message };
		if (this.panels.modal)
			this.panels.modal = { ...this.panels.modal, notice: this.panels.notice };
		this.renderer.setConnection(message, "error");
		this.render();
	}
	private requireConnection(): ClientConnection {
		const connection = this.client.connection;
		if (!connection?.ready || !connection.active())
			throw new Error("请等待会话连接完成");
		return connection;
	}
	private ledger(connection: ClientConnection): PendingWrites {
		const key = `${connection.identity.profile_id}:${connection.sessionId}`;
		let ledger = this.writes.get(key);
		if (!ledger) {
			ledger = new PendingWrites(
				sessionStorage,
				connection.identity.profile_id,
				connection.sessionId,
			);
			this.writes.set(key, ledger);
		}
		return ledger;
	}
	private hostLedger(identity: Identity): PendingWrites {
		const key = `${identity.profile_id}:`;
		let ledger = this.writes.get(key);
		if (!ledger) {
			ledger = new PendingWrites(sessionStorage, identity.profile_id, "");
			this.writes.set(key, ledger);
		}
		return ledger;
	}
	start(): Promise<void> {
		if (this.disposed)
			return Promise.reject(new Error("页面已经关闭，请重新打开。"));
		if (!this.starting) this.starting = this.startOnce();
		return this.starting;
	}
	private async startOnce(): Promise<void> {
		await PendingWrites.restore(sessionStorage);
		if (this.disposed) return;
		await this.client.bootstrap();
		if (this.disposed) return;
		await this.loadGlobal();
		if (this.disposed) return;
		this.ready = true;
		const target = new URLSearchParams(location.search);
		if (
			target.get("host") &&
			target.get("host") !== this.client.identity?.profile_id
		)
			throw new Error("链接属于其他宿主，请从原启动器打开。");
		const sessionId = target.get("session");
		if (sessionId) {
			const session = this.sessions.find(
				(item) => item.session_id === sessionId,
			);
			if (
				!session ||
				(target.get("workspace") &&
					target.get("workspace") !== session.workspace)
			)
				throw new Error("链接的会话与工作区不匹配。");
			await this.selectSession(sessionId);
		} else if (target.get("new") === "1") await this.createSession();
		else {
			const last = this.sessions.find((item) => !item.archived);
			if (last) await this.selectSession(last.session_id);
			else this.renderer.setConnectionState(connectedCopy, "connected");
		}
		this.render();
	}
	private async loadGlobal(): Promise<void> {
		if (this.disposed) return;
		const generation = ++this.globalLoadGeneration;
		const identity = this.client.identity;
		const connection = this.client.connection,
			resourcesGeneration = ++this.resourceGeneration;
		const [
			sessions,
			workspaces,
			catalog,
			accounts,
			settings,
			projects,
			resources,
		] = await Promise.all([
			this.client.call("GET /api/v1/sessions"),
			this.client.call("GET /api/v1/workspaces"),
			this.client.call("GET /api/v1/models"),
			this.client.call("GET /api/v1/accounts"),
			this.client.call("GET /api/v1/settings"),
			this.client.call("GET /api/v1/projects"),
			this.client.call("GET /api/v1/skills", {
				query: { session_id: connection?.sessionId ?? "" },
			}),
		]);
		if (!identity || !this.hostActive(identity)) return;
		const globalModelIds = identity
			? await this.preferences.resolveModelIds(
					settings.preferences?.enabledModels ?? null,
					identity,
					catalog,
				)
			: null;
		if (
			generation === this.globalLoadGeneration &&
			identity &&
			this.hostActive(identity)
		) {
			this.sessions = sessions.sessions;
			this.workspaces = workspaces.workspaces;
			this.providers.catalog = catalog;
			this.providers.accounts = accounts;
			this.projects = projects.projects ?? [];
			if (
				this.client.connection === connection &&
				resourcesGeneration === this.resourceGeneration
			)
				this.resources = resources;
			if (
				(settings.revision ?? 0) >= (this.preferences.settings?.revision ?? 0)
			) {
				this.preferences.settings = settings;
				this.preferences.globalModelIds = globalModelIds;
				this.preferences.applyPreferences(settings.preferences ?? {});
			}
		}
	}
	private async loadSession(connection: ClientConnection): Promise<void> {
		const selectionGeneration = ++this.selectionGeneration;
		const resourceGeneration = ++this.resourceGeneration;
		const [selection, resources, , feedback] = await Promise.all([
			this.client
				.call("GET /api/v1/session-models/{session_id}", {
					path: { session_id: connection.sessionId },
				})
				.catch((error) => {
					if (
						error instanceof ApiError &&
						error.code === "session_model_missing"
					)
						return undefined;
					throw error;
				}),
			this.client.call("GET /api/v1/sessions/{session}/resources", {
				path: { session: connection.sessionId },
			}),
			this.loadUsage(connection),
			this.client.call("GET /api/v1/sessions/{session}/feedback", {
				path: { session: connection.sessionId },
			}),
		]);
		if (!connection.active()) return;
		if (selectionGeneration === this.selectionGeneration)
			this.selection = selection;
		if (resourceGeneration === this.resourceGeneration)
			this.resources = resources;
		this.mergeFeedback(feedback);
		await this.integrations.loadPlugins();
		if (!connection.active()) return;
		if (
			this.integrations.pluginPackages?.packages.some(
				(item) => item.phase === "installed",
			)
		) {
			const loaded = await this.client.call(
				"POST /api/v1/sessions/{session_id}/plugin-packages/load",
				{ path: { session_id: connection.sessionId }, connection },
			);
			if (!connection.active()) return;
			this.integrations.pluginRuntime = loaded.plugins;
		}
		await this.transcript.loadHistory(connection, false);
		if (!connection.active()) return;
		if (this.dock.dockOpen && this.dock.dockTab === "terminal")
			await this.dock.loadTerminal(connection);
		if (!connection.active()) return;
		this.render();
		clearTimeout(this.healthTimer);
		this.healthTimer = setTimeout(() => {
			void this.poll(connection);
		}, 3000);
	}
	private async poll(connection: ClientConnection): Promise<void> {
		if (!connection.active()) return;
		try {
			const health = await this.client.call("GET /api/v1/health");
			if (!connection.active()) return;
			if (health.identity.profile_id !== connection.identity.profile_id)
				throw new Error("宿主身份已更换");
			if (
				health.identity.host_epoch !== connection.identity.host_epoch ||
				health.identity.build_id !== connection.identity.build_id
			) {
				await this.client.connect(connection.sessionId);
				return;
			}
			this.ready = health.state === "ready";
			const [feedback] = await Promise.all([
				this.client.call("GET /api/v1/sessions/{session}/feedback", {
					path: { session: connection.sessionId },
				}),
				this.loadUsage(connection),
			]);
			if (!connection.active()) return;
			this.mergeFeedback(feedback);
			if (this.panels.current === P.AUTOMATION_VIEW)
				await this.automation.loadSchedules();
			if (this.panels.current === "plugins")
				await this.integrations.loadPlugins();
			this.render();
		} catch (error) {
			if (connection.active()) this.error(error);
		} finally {
			if (connection.active())
				this.healthTimer = setTimeout(() => {
					void this.poll(connection);
				}, 3000);
		}
	}
	private async loadUsage(connection: ClientConnection): Promise<void> {
		const generation = ++this.usageGeneration;
		const value = await this.client.call(
			"GET /api/v1/sessions/{session_id}/usage",
			{ path: { session_id: connection.sessionId }, connection },
		);
		if (connection.active() && generation === this.usageGeneration)
			this.usage = value;
	}
	private clearSessionView(): void {
		this.usageGeneration++;
		this.selection = undefined;
		this.resources = undefined;
		this.usage = undefined;
		this.dock.workspace = undefined;
		this.feedback = undefined;
		this.thinking = this.providers.catalog?.current.thinking ?? "off";
		this.integrations.pluginRuntime = [];
		this.integrations.pluginsGeneration++;
		this.integrations.mcpConfiguration = undefined;
		this.integrations.mcpRuntime = undefined;
		this.transcript.reset();
		this.dock.reset();
		this.panels.modal = undefined;
		this.panels.notice = undefined;
		this.panels.current = P.CHAT_VIEW;
		this.panels.settingsSection = undefined;
	}
	private async selectSession(id: string): Promise<void> {
		if (this.disposed) return;
		this.navigationGeneration++;
		this.panels.generation++;
		const session = this.sessions.find((item) => item.session_id === id);
		if (!session) throw new Error("会话不存在");
		if (session.prepared === false)
			throw new Error("分支仍在准备，请先重试原创建请求");
		this.selectedProject = session.project_id || undefined;
		if (
			this.selectedProject &&
			!this.expandedProjects.includes(this.selectedProject)
		)
			this.expandedProjects = [...this.expandedProjects, this.selectedProject];
		const connecting = this.client.connect(id);
		this.drafts.select(id);
		this.enabledModels = this.sessionModelIds(id);
		this.clearSessionView();
		const url = new URL(location.href);
		url.searchParams.set("host", this.client.identity?.profile_id ?? "");
		url.searchParams.set("workspace", session.workspace ?? "primary");
		url.searchParams.set("session", id);
		url.searchParams.delete("new");
		history.replaceState(null, "", url);
		this.renderer.setDraft(this.drafts.current.text);
		await connecting;
		if (!this.disposed && this.client.connection?.sessionId === id) {
			this.enabledModels = this.sessionModelIds(id);
			this.render();
		}
	}
	private async createSession(projectId = this.selectedProject): Promise<void> {
		if (this.newSessionPending) return;
		const identity = this.client.identity;
		if (!identity) throw new Error("请先连接后端");
		const navigation = ++this.navigationGeneration;
		const project = this.projects.find(
			(item) => item.project_id === projectId && !item.removed,
		);
		const workspace =
			project?.workspaces?.[0] ??
			this.sessions.find(
				(item) => item.session_id === this.client.connection?.sessionId,
			)?.workspace ??
			new URLSearchParams(location.search).get("workspace") ??
			"primary";
		const key = `amazme:create:${identity.profile_id}:${projectId ?? ""}:${workspace}`;
		const id = sessionStorage.getItem(key) ?? newId();
		sessionStorage.setItem(key, id);
		this.newSessionPending = true;
		this.render();
		try {
			const session = await this.client.call("POST /api/v1/sessions", {
				body: {
					session_id: id,
					title: "新会话",
					workspace,
					project_id: projectId ?? "",
					reuse_empty: true,
				},
				identity,
			});
			if (sessionStorage.getItem(key) === id) sessionStorage.removeItem(key);
			await this.loadGlobal();
			if (navigation === this.navigationGeneration)
				await this.selectSession(session.session_id);
		} finally {
			this.newSessionPending = false;
			this.render();
		}
	}
	private clearDraft(draft: Draft, revision: number): void {
		if (this.drafts.clear(draft, revision)) this.renderer.setDraft("");
	}
	private permissionKey(connection: ClientConnection): string {
		return `amazme:permission:${connection.identity.profile_id}:${connection.sessionId}`;
	}
	private get approvalPolicy(): ApprovalPolicy {
		const connection = this.client.connection;
		const saved = connection
			? sessionStorage.getItem(this.permissionKey(connection))
			: null;
		return saved === "all" || saved === "mutations" || saved === "auto"
			? saved
			: (this.client.identity?.approval_policy ?? "mutations");
	}
	private async submit(text: string, expectedRequest?: string): Promise<void> {
		const draft = this.drafts.current,
			revision = draft.revision,
			initial = this.client.connection;
		const images = draft.images.map((item) => item.image);
		if (initial) {
			const key = this.permissionKey(initial);
			let permissionWrite = this.permissionWrites.get(key);
			while (permissionWrite) {
				await permissionWrite;
				if (!initial.active() || this.drafts.current !== draft) return;
				const latest = this.permissionWrites.get(key);
				if (latest === permissionWrite) break;
				permissionWrite = latest;
			}
		}
		const previous =
			initial?.ready && initial.active()
				? this.ledger(initial).read(
						"submission",
						"POST /api/v1/sessions/{session}/submissions",
					)
				: undefined;
		if (expectedRequest && previous?.id !== expectedRequest)
			throw new Error("原请求已变化，请核对当前记录");
		let review: GitDiff | undefined;
		if (!previous) {
			const command = parseCommandLine(text);
			if (command) {
				const descriptor = this.commands.find(
					(item) => item.name === command.name,
				);
				if (!descriptor) throw new Error(`未识别的命令：/${command.name}`);
				if (descriptor.source === "builtin" && command.name === "diff") {
					if (images.length) throw new Error("/diff 不接受图片；请先移除附件");
					review = parseContract("GitDiff", {
						scope: command.args.trim() || "uncommitted",
					});
				} else if (descriptor.source === "builtin") {
					await this.command(command.name, command.args);
					this.clearDraft(draft, revision);
					this.render();
					return;
				}
				if (descriptor.source === "plugin") {
					await this.runPluginCommand(command.name, command.args);
					return;
				}
			}
		}
		const connection = this.requireConnection(),
			ledger = this.ledger(connection);
		if (
			ledger.read(
				"command",
				"POST /api/v1/sessions/{session_id}/plugins/{plugin_id}/calls",
			)
		)
			throw new Error("原插件命令尚未确认，请先重试原命令或核对结果");
		const displayedModel = this.selection ?? this.providers.catalog?.current;
		const root = connection.snapshot?.requests.find(
			(item) => item.kind === "root" && !settled.has(item.status),
		);
		const thinking = this.providers.catalog?.models
			.find(
				(item) =>
					item.provider === displayedModel?.provider &&
					item.model === displayedModel.model,
			)
			?.thinking_levels?.find((level) => level === this.thinking);
		const steer = !review && this.mode === "steer" && root?.run_id;
		const record =
			previous ??
			ledger.prepare(
				"submission",
				"POST /api/v1/sessions/{session}/submissions",
				(id) => ({
					path: { session: connection.sessionId },
					body: {
						request_id: id,
						text,
						images,
						mode: steer ? "steer" : "queue",
						...(review
							? {
									tool_call: {
										id,
										name: "git_diff",
										arguments: JSON.stringify(review),
									},
								}
							: {}),
						time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
						...(steer
							? { target_run_id: steer }
							: {
									approval_policy: this.approvalPolicy,
									...(displayedModel
										? {
												model_selection: {
													provider: displayedModel.provider,
													model: displayedModel.model,
												},
											}
										: {}),
									...(thinking ? { thinking } : {}),
								}),
					},
				}),
			);
		if (!previous) draft.submission = { id: record.id, revision };
		const owner =
			draft.submission?.id === record.id ? draft.submission : undefined;
		this.render();
		try {
			const result = await ledger.send(
				"submission",
				record,
				this.client,
				connection,
			);
			if (owner) this.clearDraft(draft, owner.revision);
			if (result.status !== "unknown" && draft.submission === owner)
				draft.submission = undefined;
		} finally {
			if (connection.active()) this.render();
		}
	}
	private async cancel(id?: string): Promise<void> {
		const connection = this.requireConnection();
		const request =
			id ??
			connection.snapshot?.requests.find(
				(item) => item.kind === "root" && !settled.has(item.status),
			)?.request_id;
		if (!request) return;
		await this.client.call(
			"POST /api/v1/sessions/{session}/requests/{request_id}/cancel",
			{
				path: { session: connection.sessionId, request_id: request },
				connection,
			},
		);
	}
	private async runPluginCommand(
		name: string,
		args: string,
		expectedCall?: string,
	): Promise<void> {
		const connection = this.requireConnection(),
			ledger = this.ledger(connection),
			draft = this.drafts.current;
		let record = ledger.read(
			"command",
			"POST /api/v1/sessions/{session_id}/plugins/{plugin_id}/calls",
		);
		if (expectedCall && record?.id !== expectedCall)
			throw new Error("原命令已变化，请核对当前记录");
		if (!record) {
			const plugin = this.integrations.pluginRuntime.find(
				(plugin) =>
					plugin.phase === "ready" &&
					plugin.tools?.some(
						(tool) => tool.kind === "command" && tool.name === name,
					),
			);
			if (!plugin) throw new Error("插件命令尚未加载，请检查插件配置");
			record = ledger.prepare(
				"command",
				"POST /api/v1/sessions/{session_id}/plugins/{plugin_id}/calls",
				(id) => ({
					path: {
						session_id: connection.sessionId,
						plugin_id: plugin.plugin_id,
					},
					body: {
						kind: "command",
						call_id: id,
						name,
						arguments: { arguments: args },
						expected_fingerprint: plugin.fingerprint,
						expected_load_id: plugin.load_id ?? "",
					},
				}),
			);
			draft.submission = { id: record.id, revision: draft.revision };
		}
		const owner =
			draft.submission?.id === record.id ? draft.submission : undefined;
		this.render();
		const result = await ledger.send(
			"command",
			record,
			this.client,
			connection,
		);
		this.rememberCommand(connection, record.body.name, result);
		if (result.phase === "done" && owner)
			this.clearDraft(draft, owner.revision);
		if (result.phase !== "unknown" && draft.submission === owner)
			draft.submission = undefined;
		if (connection.active()) this.render();
	}
	private rememberCommand(
		connection: ClientConnection,
		name: string,
		result: PluginCallView,
	): void {
		const scope = `${connection.identity.profile_id}:${connection.sessionId}`,
			outputs =
				this.commandResults.get(scope) ??
				new Map<string, { name: string; result: PluginCallView }>();
		outputs.set(result.call_id, { name, result });
		while (outputs.size > 20) {
			const first = outputs.keys().next().value;
			if (!first) break;
			outputs.delete(first);
		}
		this.commandResults.set(scope, outputs);
	}
	private mergeFeedback(value: AnswerFeedbackList): void {
		if (value.session_id !== this.client.connection?.sessionId) return;
		const records = new Map(
			(this.feedback?.records ?? []).map((record) => [
				record.request_id,
				record,
			]),
		);
		for (const record of value.records ?? [])
			if (
				record.session_id === value.session_id &&
				record.revision >= (records.get(record.request_id)?.revision ?? 0)
			)
				records.set(record.request_id, record);
		this.feedback = {
			session_id: value.session_id,
			records: [...records.values()],
		};
	}
	private async selectModel(provider: string, model: string): Promise<void> {
		const connection = this.requireConnection();
		const generation = ++this.selectionGeneration;
		const selection = await this.client.call(
			"PUT /api/v1/session-models/{session_id}",
			{
				path: { session_id: connection.sessionId },
				body: { session_id: connection.sessionId, provider, model },
				connection,
			},
		);
		if (!connection.active() || generation !== this.selectionGeneration) return;
		this.selection = selection;
		this.thinking = "off";
		this.render();
	}
	private async attachFiles(files: readonly File[]): Promise<void> {
		const connection = this.requireConnection();
		const draft = await this.drafts.attach(files);
		if (connection.active() && this.drafts.current === draft) this.render();
	}
	private async command(name: string, args: string): Promise<void> {
		switch (name) {
			case "new":
				await this.createSession();
				break;
			case "model":
				this.panels.settingsSection = {
					id: "settings:models",
					generation: ++this.panels.generation,
				};
				this.panels.current = P.SETTINGS_VIEW;
				this.render();
				break;
			case "settings":
				this.panels.settingsSection = undefined;
				this.panels.current = P.SETTINGS_VIEW;
				this.render();
				break;
			case "compact":
				await this.action({
					kind: "command",
					id: A.COMPACT_ACTION,
					data: undefined,
				});
				break;
			case "fork":
				await this.fork();
				break;
			case "export": {
				const data = await this.client.call("GET /api/v1/export");
				this.download(
					JSON.stringify(data, null, 2),
					"amazme-export.json",
					"application/json",
				);
				break;
			}
			default:
				throw new Error(`未识别的命令：/${name} ${args}`);
		}
	}
	private download(data: string, name: string, type: string): void {
		const url = URL.createObjectURL(new Blob([data], { type }));
		const link = document.createElement("a");
		link.href = url;
		link.download = name;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	private async fork(
		sessionId = this.requireConnection().sessionId,
		expectedBranch?: string,
	): Promise<void> {
		const navigation = this.navigationGeneration;
		const session = await this.client.withSession(
			sessionId,
			async (connection) => {
				const ledger = this.ledger(connection);
				let record = ledger.read(
					"branch",
					"POST /api/v1/sessions/{session}/branches",
				);
				if (expectedBranch && record?.id !== expectedBranch)
					throw new Error("原分支请求已变化，请核对当前记录");
				if (!record) {
					const snapshot =
						this.client.connection?.sessionId === sessionId
							? this.client.connection.snapshot
							: await this.client.call(
									"GET /api/v1/sessions/{session}/snapshot",
									{ path: { session: sessionId } },
								);
					const request = snapshot?.requests.findLast(
						(item) => item.kind === "root" && item.status === "succeeded",
					);
					if (!request) throw new Error("请先完成一个成功回合");
					record = ledger.prepare(
						"branch",
						"POST /api/v1/sessions/{session}/branches",
						(id) => ({
							path: { session: sessionId },
							body: { branch_id: id, request_id: request.request_id },
						}),
					);
				}
				return ledger.send("branch", record, this.client, connection);
			},
		);
		await this.loadGlobal();
		if (navigation === this.navigationGeneration)
			await this.selectSession(session.session_id);
	}
	private async action(action: P.PanelAction): Promise<void> {
		this.panels.notice = undefined;
		if (
			action.kind === "open" ||
			action.kind === "modal-close" ||
			(action.kind === "command" &&
				![A.PROVIDER_AUTH_OPEN_ACTION, A.PROVIDER_AUTH_CANCEL_ACTION].includes(
					action.id,
				))
		) {
			this.panels.generation++;
			this.providers.providerEdit = undefined;
		}
		if (action.kind === "open") {
			this.panels.current = action.panel;
			this.panels.settingsSection = undefined;
			this.panels.modal = undefined;
			this.render();
			if (action.panel === P.AUTOMATION_VIEW)
				await this.automation.loadSchedules();
			if (action.panel === "plugins") await this.integrations.loadPlugins();
			this.render();
			return;
		}
		if (action.kind === "modal-close") {
			this.panels.modal = undefined;
			this.render();
			return;
		}
		const id = action.id,
			data = action.data;
		const fields = action.kind === "modal-submit" ? action.fields : {};
		const value = action.kind === "control" ? action.value : (data ?? "");
		if (await this.managementAction(id, data, fields)) return;
		if (await this.skillAction(action)) return;
		if (await this.automation.scheduleAction(action)) return;
		if (await this.integrations.pluginAction(action)) return;
		if (await this.integrations.mcpAction(action)) return;
		if (id === USAGE_ACTION || id === USAGE_REFRESH_ACTION) {
			const connection = this.requireConnection();
			this.dock.dockOpen = true;
			this.dock.dockTab = "statistics";
			this.render();
			await this.loadUsage(connection);
			if (connection.active()) this.render();
			return;
		}
		if (id === A.HISTORY_MORE_ACTION || id === A.TRANSCRIPT_SEARCH_ACTION) {
			await this.transcript.loadHistory(
				this.requireConnection(),
				true,
				id === A.TRANSCRIPT_SEARCH_ACTION,
			);
			if (id === A.TRANSCRIPT_SEARCH_ACTION)
				this.renderer.refreshTranscriptSearch();
			return;
		}
		if (id === A.WELCOME_SESSION_ACTION) {
			await this.createSession();
			return;
		}
		if (id === A.WELCOME_SETTINGS_ACTION || id === A.MODEL_CONNECTIONS_ACTION) {
			this.panels.settingsSection =
				id === A.MODEL_CONNECTIONS_ACTION
					? {
							id: "settings:models",
							generation: this.panels.generation,
						}
					: undefined;
			this.panels.current = P.SETTINGS_VIEW;
			this.panels.modal = undefined;
			this.render();
			return;
		}
		if (id === A.QUESTION_ANSWER_ACTION) {
			const connection = this.requireConnection(),
				target: unknown = JSON.parse(data ?? "null");
			if (
				!isRecord(target) ||
				target.sessionId !== connection.sessionId ||
				!isRecord(target.value)
			)
				return;
			const answer = parseContract("QuestionAnswer", {
				...target.value,
				decision_id: "pending",
			});
			if (
				!connection.snapshot?.questions?.some(
					(question) =>
						question.state === "pending" &&
						question.question_id === answer.question_id &&
						question.proposal_digest === answer.proposal_digest &&
						question.generation === answer.generation,
				)
			)
				return;
			const ledger = this.ledger(connection),
				key = `question:${answer.question_id}`;
			const record = ledger.prepare(
				key,
				"POST /api/v1/sessions/{session}/questions",
				(decisionId) => ({
					path: { session: connection.sessionId },
					body: { ...answer, decision_id: decisionId },
				}),
			);
			if (
				record.body.kind !== answer.kind ||
				JSON.stringify(record.body.answers ?? []) !==
					JSON.stringify(answer.answers ?? [])
			) {
				throw new Error("原回答尚未确认，请先核对或重试原回答。");
			}
			await ledger.send(key, record, this.client, connection);
			return;
		}
		if (id === A.WELCOME_DISMISS_ACTION) {
			await this.preferences.setPreference("showWelcome", "false");
			return;
		}
		if (id === A.DOCK_TOGGLE_ACTION) {
			this.dock.dockOpen = !this.dock.dockOpen;
			if (
				this.dock.dockOpen &&
				this.dock.dockTab === "files" &&
				!this.dock.workspace
			)
				await this.dock.openWorkspace();
			if (this.dock.dockOpen && this.dock.dockTab === "terminal")
				await this.dock.loadTerminal(this.requireConnection());
			this.render();
			return;
		}
		if (id === A.DOCK_TAB_ACTION) {
			this.dock.dockTab = value;
			this.dock.dockOpen = true;
			if (value === "files" && !this.dock.workspace)
				await this.dock.openWorkspace();
			if (value === "terminal")
				await this.dock.loadTerminal(this.requireConnection(), true);
			this.render();
			return;
		}
		if (id === A.WORKSPACE_OPEN_ACTION || id === A.WORKSPACE_READ_ACTION) {
			await this.dock.openWorkspace(
				id === A.WORKSPACE_READ_ACTION
					? { kind: "file", path: value }
					: { kind: "directory", path: value },
			);
			return;
		}
		if (id === A.WORKSPACE_FILE_LINK_ACTION) {
			const target = parseWorkspaceAction(data);
			if (target.kind !== "link")
				throw new TypeError("Invalid file link action");
			if (this.client.connection?.sessionId !== target.sessionId) return;
			await this.dock.openWorkspace({
				kind: "file",
				path: target.path,
				line: target.line,
			});
			return;
		}
		if (id === A.WORKSPACE_RELOAD_ACTION || id === A.WORKSPACE_PAGE_ACTION) {
			const target = parseWorkspaceAction(data);
			if (target.kind === "link")
				throw new TypeError("Invalid workspace reload action");
			await this.dock.openWorkspace(
				target.kind === "read"
					? { kind: "file", path: target.path, preserve: true }
					: { kind: "directory", path: target.path, offset: target.offset },
			);
			return;
		}
		if (id === A.SUBMIT_MODE_ACTION) {
			this.mode = value === "steer" ? "steer" : "followUp";
			this.render();
			return;
		}
		if (id === A.ATTACHMENT_REMOVE_ACTION) {
			this.drafts.current.images = this.drafts.current.images.filter(
				(item) => item.id !== data,
			);
			this.drafts.current.revision++;
			this.render();
			return;
		}
		if (id === A.QUEUE_CANCEL_ACTION) {
			await this.cancel(data);
			return;
		}
		if (id === "effect:cleanup") {
			const connection = this.requireConnection(),
				target: unknown = JSON.parse(data ?? "null");
			if (
				!Array.isArray(target) ||
				target[0] !== connection.sessionId ||
				typeof target[1] !== "string" ||
				!/^[a-f0-9]{64}$/.test(target[1])
			)
				throw new Error("脚本不属于当前会话");
			const hold = connection.snapshot?.effects?.find(
				(item) =>
					item.call_id === target[1] &&
					item.reason === "codemode_outcome_unknown" &&
					!item.reconciled,
			);
			if (!hold) throw new Error("原脚本状态已变化，请核对当前记录");
			await this.client.call(
				"POST /api/v1/sessions/{session_id}/code/{run_id}/cancel",
				{
					path: {
						session_id: connection.sessionId,
						run_id: hold.call_id.slice(0, 32),
					},
					connection,
				},
			);
			await this.client.call("GET /api/v1/sessions/{session}/snapshot", {
				path: { session: connection.sessionId },
			});
			if (connection.active()) this.render();
			return;
		}
		if (id === "effect:review" || id === "effect:resolve") {
			const connection = this.requireConnection(),
				target: unknown = JSON.parse(data ?? "null");
			if (
				!Array.isArray(target) ||
				target.length !== 2 ||
				target[0] !== connection.sessionId ||
				typeof target[1] !== "string"
			)
				throw new Error("核对操作不属于当前会话");
			const hold = connection.snapshot?.effects?.find(
				(item) => item.call_id === target[1] && !item.reconciled,
			);
			if (!hold || !hold.resource_clean)
				throw new Error("请先等待原资源退出并核对当前状态");
			if (id === "effect:review") {
				this.panels.modal = {
					id: "effect:resolve",
					data,
					title: "核对执行效果",
					description:
						"根据本机文件或外部系统的实际状态填写证据。核对不会重新执行原调用。",
					submit: "提交核对",
					fields: [
						{
							id: "outcome",
							label: "实际效果",
							kind: "select",
							value: "",
							options: [
								{ value: "", label: "请选择核对结果" },
								{ value: "applied", label: "效果已发生" },
								{ value: "not_applied", label: "确认效果未发生" },
							],
						},
						{ id: "evidence", label: "核对证据", kind: "textarea", value: "" },
					],
				};
				this.render();
				return;
			}
			const modal = this.panels.modal;
			if (
				action.kind !== "modal-submit" ||
				modal?.id !== id ||
				modal.data !== data
			)
				return;
			const ledger = this.ledger(connection),
				key = `resolution:${hold.call_id}`;
			const record = ledger.prepare(
				key,
				"POST /api/v1/sessions/{session}/effects/resolve",
				(resolution) => ({
					path: { session: connection.sessionId },
					body: parseContract("EffectResolution", {
						resolution_id: resolution,
						call_id: hold.call_id,
						outcome: fields.outcome,
						evidence: fields.evidence?.trim() ?? "",
					}),
				}),
			);
			await ledger.send(key, record, this.client, connection);
			if (connection.active() && this.panels.modal === modal) {
				this.panels.modal = undefined;
				this.render();
			}
			return;
		}
		if (
			id === A.FEEDBACK_UP_ACTION ||
			id === A.FEEDBACK_DOWN_ACTION ||
			id === "write:retry-feedback"
		) {
			const connection = this.requireConnection(),
				target: unknown = JSON.parse(data ?? "null");
			if (
				!Array.isArray(target) ||
				target[0] !== connection.sessionId ||
				typeof target[1] !== "string"
			)
				throw new Error("反馈不属于当前答案，请刷新后重试");
			const ledger = this.ledger(connection),
				key = `feedback:${target[1]}`;
			let record = ledger.read(key, "POST /api/v1/sessions/{session}/feedback");
			if (id === "write:retry-feedback") {
				if (target.length !== 3 || !record || record.id !== target[2])
					throw new Error("原反馈请求已变化，请核对当前记录");
			} else {
				if (target.length !== 4 || ![null, "up", "down"].includes(target[2]))
					throw new Error("答案反馈无效");
				const rating = id === A.FEEDBACK_UP_ACTION ? "up" : "down";
				const value = parseContract("AnswerFeedbackWrite", {
					operation_id: newId(),
					request_id: target[1],
					rating: target[2] === rating ? null : rating,
					expected_revision: target[3],
				});
				record ??= ledger.prepare(
					key,
					"POST /api/v1/sessions/{session}/feedback",
					(operation) => ({
						path: { session: connection.sessionId },
						body: { ...value, operation_id: operation },
					}),
				);
			}
			const result = await ledger.send(key, record, this.client, connection);
			if (connection.active()) {
				this.mergeFeedback({
					session_id: connection.sessionId,
					records: [result],
				});
				this.render();
			}
			return;
		}
		if (id === A.TERMINAL_RUN_ACTION) {
			const connection = this.requireConnection();
			if (
				!this.dock.terminal ||
				this.dock.terminal.connection !== connection ||
				this.dock.terminal.view.phase !== "running"
			)
				await this.dock.loadTerminal(connection, true);
			if (value.trim() && this.dock.terminal?.connection === connection)
				this.dock.terminal.queue.enqueue(value + "\r");
			return;
		}
		if (id === A.TERMINAL_STOP_ACTION && this.dock.terminal) {
			const terminal = this.dock.terminal;
			const view = await this.client.call(
				"POST /api/v1/sessions/{session_id}/terminals/{terminal_id}/close",
				{
					path: {
						session_id: terminal.connection.sessionId,
						terminal_id: terminal.id,
					},
					connection: terminal.connection,
				},
			);
			if (terminal.connection.active() && this.dock.terminal === terminal) {
				this.dock.observeTerminal(terminal, view);
				this.render();
			}
			return;
		}
		if (id === "terminal:retry") {
			this.dock.terminal?.queue.retry();
			return;
		}
		if (id === "terminal:confirm") {
			this.panels.modal = {
				id: "terminal:confirm-submit",
				title: "核对终端输入",
				description:
					"确认已经核对终端内容后，清除这些未确认输入；不会重新发送它们。",
				fields: [],
				submit: "已核对，继续",
				data: this.dock.terminal?.id,
			};
			this.render();
			return;
		}
		if (
			id === "terminal:confirm-submit" &&
			this.dock.terminal &&
			data === this.dock.terminal.id
		) {
			this.dock.terminal.queue.confirm();
			this.panels.modal = undefined;
			this.render();
			return;
		}
		if (id === "write:retry-submit") {
			if (!data) throw new Error("缺少原请求编号");
			await this.submit(this.drafts.current.text, data);
			return;
		}
		if (id === "write:retry-command") {
			if (!data) throw new Error("缺少原命令编号");
			await this.runPluginCommand("", "", data);
			return;
		}
		if (id === "write:cancel-command") {
			const connection = this.requireConnection(),
				ledger = this.ledger(connection),
				record = ledger.read(
					"command",
					"POST /api/v1/sessions/{session_id}/plugins/{plugin_id}/calls",
				);
			if (
				!record ||
				record.id !== data ||
				typeof record.path.plugin_id !== "string"
			)
				throw new Error("原命令已变化，请核对当前记录");
			const result = await this.client.call(
				"POST /api/v1/sessions/{session_id}/plugins/{plugin_id}/calls/{call_id}/cancel",
				{
					path: {
						session_id: connection.sessionId,
						plugin_id: record.path.plugin_id,
						call_id: record.id,
					},
					connection,
				},
			);
			this.rememberCommand(connection, record.body.name, result);
			if (result.phase !== "unknown" && result.clean)
				await ledger.forget("command", record);
			if (connection.active()) this.render();
			return;
		}
		if (id === "write:cancel-submit") {
			const connection = this.requireConnection(),
				ledger = this.ledger(connection);
			const record = ledger.read(
				"submission",
				"POST /api/v1/sessions/{session}/submissions",
			);
			if (record?.id !== data) throw new Error("原请求已变化，请核对当前记录");
			if (record) {
				await this.cancel(record.body.request_id);
				await ledger.forget("submission", record);
				if (connection.active()) this.render();
			}
			return;
		}
		if (id === A.CONVERSATION_FORK_ACTION) {
			await this.fork(data);
			return;
		}
		if (id === "write:retry-branch") {
			if (!data) throw new Error("缺少原分支编号");
			await this.fork(this.requireConnection().sessionId, data);
			return;
		}
		if (id === A.COMPACT_ACTION) {
			this.panels.modal = {
				...P.compactModal(this.preferences.locale),
				data: this.requireConnection().sessionId,
			};
			this.render();
			return;
		}
		if (id === A.COMPACT_MODAL) {
			const connection = this.requireConnection(),
				ledger = this.ledger(connection),
				modal = this.panels.modal;
			if (
				action.kind !== "modal-submit" ||
				modal?.id !== id ||
				modal.data !== data ||
				data !== connection.sessionId
			)
				return;
			let record = ledger.read(
				"compaction",
				"POST /api/v1/sessions/{session}/compactions",
			);
			if (!record) {
				const through = connection.snapshot?.requests.findLast(
					(item) => item.kind === "root" && item.status === "succeeded",
				);
				if (!through) throw new Error("没有可压缩的成功回合");
				record = ledger.prepare(
					"compaction",
					"POST /api/v1/sessions/{session}/compactions",
					(id) => ({
						path: { session: connection.sessionId },
						body: {
							compaction_id: id,
							through_request_id: through.request_id,
							instructions: fields.instructions ?? "",
						},
					}),
				);
			}
			await ledger.send("compaction", record, this.client, connection);
			if (connection.active() && this.panels.modal === modal) {
				this.panels.modal = undefined;
				this.render();
			}
			return;
		}
		if (id === A.APPROVAL_APPROVE_ACTION || id === A.APPROVAL_DENY_ACTION) {
			const connection = this.requireConnection(),
				ledger = this.ledger(connection);
			const proposal = connection.snapshot?.approvals?.find(
				(item) => item.approval_id === data && item.state === "pending",
			);
			if (!proposal) throw new Error("审批提案已变化，请核对当前记录");
			const key = `approval:${proposal.approval_id}`;
			const record = ledger.prepare(
				key,
				"POST /api/v1/sessions/{session}/approvals",
				(id) => ({
					path: { session: connection.sessionId },
					body: {
						decision_id: id,
						approval_id: proposal.approval_id,
						expected_revision: proposal.revision,
						proposal_digest: proposal.proposal_digest,
						approve: action.id === A.APPROVAL_APPROVE_ACTION,
					},
				}),
			);
			if (record.body.approve !== (id === A.APPROVAL_APPROVE_ACTION))
				throw new Error("原审批决定尚未确认；请先重试原决定。");
			await ledger.send(key, record, this.client, connection);
			return;
		}
		if (id === A.MODEL_SELECT_ACTION) {
			const selected = modelReference(value);
			await this.selectModel(selected.provider, selected.model);
			return;
		}
		if (id === A.MODEL_THINKING_ACTION) {
			this.thinking = value;
			this.render();
			return;
		}
		if (
			id === A.REFRESH_MODELS_ACTION ||
			id === P.SETTINGS_RELOAD_ACTION ||
			id === A.SESSION_RELOAD_ACTION
		) {
			await this.loadGlobal();
			const connection = this.client.connection;
			if (connection?.ready) await this.loadSession(connection);
			this.render();
			return;
		}
		if (id === A.MODEL_SCOPE_ACTION) {
			const available = this.providers.connections().enabledModels;
			if (available.length === 0) {
				this.panels.settingsSection = {
					id: "settings:models",
					generation: this.panels.generation,
				};
				this.panels.current = P.SETTINGS_VIEW;
				this.panels.modal = undefined;
			} else
				this.panels.modal = modelScopeModal(this.preferences.locale, {
					allModels: available.map((item) => ({
						provider: item.provider,
						id: item.modelId,
						name: item.name,
					})),
					enabledModelIds: this.enabledModels,
				});
			this.render();
			return;
		}
		if (id === A.MODEL_SCOPE_MODAL) {
			const connection = this.requireConnection(),
				modal = this.panels.modal;
			if (
				action.kind !== "modal-submit" ||
				modal?.id !== id ||
				this.panels.modalPending
			)
				return;
			const ids =
				parseContract("InterfacePreferences", {
					enabledModels: JSON.parse(fields.models || "null"),
				}).enabledModels ?? null;
			this.modelScopes.set(
				`${connection.identity.profile_id}:${connection.sessionId}`,
				ids,
			);
			this.enabledModels = ids;
			if (fields.persist !== "true") {
				if (this.panels.modal === modal) this.panels.modal = undefined;
				this.render();
				return;
			}
			this.panels.pendingModal = modal;
			this.render();
			try {
				await this.preferences.updatePreferences((current) => ({
					...current,
					enabledModels: ids,
				}));
				if (connection.active() && this.panels.modal === modal)
					this.panels.modal = undefined;
			} finally {
				if (this.panels.pendingModal === modal)
					this.panels.pendingModal = undefined;
				if (connection.active()) this.render();
			}
			return;
		}
		if (id === A.MODEL_DEFAULTS_ACTION) {
			const identity = this.client.identity;
			if (!identity || !this.providers.catalog) throw new Error("请先连接后端");
			const selected = data
				? modelReference(data)
				: (this.selection ?? this.providers.catalog.current);
			const model = this.providers.catalog.models.find(
				(item) =>
					item.provider === selected.provider && item.model === selected.model,
			);
			if (!model) throw new Error("模型不可用");
			const levels = model.thinking_levels ?? ["off"],
				thinking =
					levels.find((level) => level === this.thinking) ?? levels[0] ?? "off";
			await this.client.call("POST /api/v1/models", {
				body: parseContract("UpdateModelSettings", {
					provider: selected.provider,
					model: selected.model,
					api: model.api ?? "openai-completions",
					base_url: model.base_url ?? "",
					thinking,
				}),
				identity,
			});
			await this.loadGlobal();
			return;
		}
		if (id === PROVIDER_SELECT_ACTION) {
			this.providers.selectedProvider = data;
			this.render();
			return;
		}
		if (id === PROVIDER_EDIT_ACTION) {
			const connections = this.providers.connections(),
				provider = connections.state.providers.find((item) => item.id === data);
			this.panels.modal = providerConfigurationModal(
				this.preferences.locale,
				provider,
				connections.models,
				connections.state.authentication.providers,
				provider
					? (connections.state.authentication.providers.find(
							(item) => item.id === provider.id,
						)?.methods ?? [])
					: [],
			);
			const identity = this.client.identity,
				raw =
					identity && provider
						? sessionStorage.getItem(
								`amazme:provider:${identity.profile_id}:${provider.id}`,
							)
						: null;
			if (raw) {
				const previous = parseContract("ConfigureProvider", JSON.parse(raw));
				this.panels.modal = {
					...this.panels.modal,
					notice: {
						tone: "info",
						text: "上次配置尚待确认；提交将沿用原编号和内容。",
					},
					fields: this.panels.modal.fields.map((field) => {
						const values: Readonly<Record<string, string>> = {
							name: previous.name ?? previous.provider,
							baseUrl: previous.base_url,
							api: previous.api,
							models: previous.model_ids?.join("\n") ?? "",
						};
						return field.id in values
							? { ...field, value: values[field.id], readOnly: true }
							: field;
					}),
				};
			}
			this.providers.providerEdit = {
				generation: this.panels.generation,
				revision: this.providers.accounts.revision,
				configurationRevision:
					this.providers.catalog?.configuration_revision ?? 0,
			};
			this.render();
			return;
		}
		if (id === PROVIDER_LOGOUT_ACTION) {
			this.panels.modal = providerLogoutModal(
				this.preferences.locale,
				data ?? "",
				data ?? "",
			);
			this.providers.providerEdit = {
				generation: this.panels.generation,
				revision: this.providers.accounts.revision,
				configurationRevision:
					this.providers.catalog?.configuration_revision ?? 0,
			};
			this.render();
			return;
		}
		if (id === PROVIDER_EDIT_MODAL || id === PROVIDER_LOGOUT_MODAL) {
			if (this.panels.modal?.id !== id || this.panels.modal.data !== data)
				return;
			await this.providers.saveProvider(
				data,
				fields,
				id === PROVIDER_LOGOUT_MODAL,
			);
			return;
		}
		if (id === A.PROVIDER_AUTH_OPEN_ACTION) {
			if (!data || !/^https?:\/\//.test(data)) throw new Error("授权链接无效");
			window.open(data, "_blank", "noopener,noreferrer");
			return;
		}
		if (id === A.PROVIDER_AUTH_ACTION) {
			this.panels.modal = providerAuthModal(
				this.preferences.locale,
				this.providers.authentication(),
				data,
			);
			this.providers.providerEdit = {
				generation: this.panels.generation,
				revision: this.providers.accounts.revision,
				configurationRevision:
					this.providers.catalog?.configuration_revision ?? 0,
			};
			this.render();
			return;
		}
		if (id === A.PROVIDER_AUTH_CANCEL_ACTION) {
			await this.providers.cancelOAuth(data);
			return;
		}
		if (id === A.PROVIDER_AUTH_MODAL) {
			if (this.panels.modal?.id !== id || this.panels.modal.data !== data)
				return;
			if (this.providers.modalOAuth) {
				const login = this.providers.modalOAuth,
					identity = this.client.identity;
				if (!identity) return;
				await this.client.call("POST /api/v1/accounts/oauth/{login_id}/input", {
					path: { login_id: login.login_id },
					body: { value: fields.value ?? "" },
					identity,
				});
				return;
			}
			const provider = fields.provider,
				method = fields[`method:${provider}`];
			if (method === "oauth" || method === "logout") {
				await this.providers.saveProvider(
					provider,
					fields,
					method === "logout",
				);
				return;
			}
			const state = this.providers.connections(),
				target = state.state.providers.find((item) => item.id === provider);
			if (!target) throw new Error("供应商不可用");
			this.panels.modal = providerConfigurationModal(
				this.preferences.locale,
				target,
				state.models,
				state.state.authentication.providers,
				state.state.authentication.providers.find(
					(item) => item.id === provider,
				)?.methods ?? [],
			);
			this.render();
			return;
		}
		if (id === MODEL_ENABLED_ACTION) {
			const reference = modelReference(data ?? ""),
				key = `${reference.provider}/${reference.model}`;
			const all =
				this.providers.catalog?.models.map(
					(item) => `${item.provider}/${item.model}`,
				) ?? [];
			await this.preferences.updateSettings(async (current, identity) => {
				const selected = new Set(
					(await this.preferences.resolveModelIds(
						current.preferences?.enabledModels ?? null,
						identity,
					)) ?? all,
				);
				if (value === "true") selected.add(key);
				else selected.delete(key);
				const preferences = parseContract("InterfacePreferences", {
					...current.preferences,
					enabledModels: [...selected],
				});
				return this.client.call("PUT /api/v1/settings/preferences", {
					body: { preferences, expected_revision: current.revision ?? 0 },
					identity,
				});
			});
			return;
		}
		if (id === PROVIDER_TEST_ACTION) {
			const state = this.providers.connections(),
				provider = state.state.providers.find((item) => item.id === data);
			if (!provider?.configured) throw new Error("请先配置供应商账号");
			const models = (this.providers.catalog?.models ?? [])
				.filter((item) => item.provider === provider.id)
				.map((item) => ({
					provider: item.provider,
					modelId: item.model,
					name: item.label,
					available: true,
				}));
			const modal = providerTestModal(this.preferences.locale, models, true);
			this.panels.modal = {
				...modal,
				data: provider.id,
				actions: modal.actions?.map((action) => ({
					...action,
					data: provider.id,
				})),
			};
			this.render();
			return;
		}
		if (id === PROVIDER_TEST_MODAL || id === PROVIDER_TEST_ALL_ACTION) {
			await this.providers.checkProvider(
				data,
				id === PROVIDER_TEST_ALL_ACTION ? undefined : fields.model,
			);
			return;
		}
		if (id === P.SETTINGS_FIELD_ACTION) {
			await this.preferences.setPreference(data ?? "", value);
			return;
		}
		if (id === P.DIAGNOSTICS_ACTION) {
			const connection = this.requireConnection(),
				generation = this.panels.generation,
				modal = this.panels.modal;
			const report = await this.client.call(
				"GET /api/v1/sessions/{session_id}/diagnostics",
				{ path: { session_id: connection.sessionId } },
			);
			if (
				connection.active() &&
				generation === this.panels.generation &&
				this.panels.modal === modal
			) {
				this.panels.modal = {
					id: "diagnostics:close",
					title: "诊断",
					fields: [
						{
							id: "report",
							label: "会话诊断",
							kind: "textarea",
							readOnly: true,
							value: JSON.stringify(report, null, 2),
						},
					],
				};
				this.render();
			}
			return;
		}
		throw new Error(`入口尚未接通：${id}`);
	}
	private async managementAction(
		id: string,
		data: string | undefined,
		fields: Readonly<Record<string, string>>,
	): Promise<boolean> {
		const session = this.sessions.find((item) => item.session_id === data);
		const project = this.projects.find((item) => item.project_id === data);
		if (id === A.SESSION_COPY_ID_ACTION && data) {
			await navigator.clipboard.writeText(data);
			return true;
		}
		if (id === A.SESSION_REMOVE_ACTION) {
			if (!session) throw new Error("会话不存在");
			this.panels.modal = P.removeSessionModal(
				this.preferences.locale,
				session.session_id,
			);
			this.render();
			return true;
		}
		if (id === A.SESSION_REMOVE_MODAL && data) {
			const identity = this.client.identity,
				modal = this.panels.modal,
				navigation = this.navigationGeneration;
			if (!identity || modal?.id !== id || modal.data !== data) return true;
			await this.client.call("DELETE /api/v1/sessions/{session}", {
				path: { session: data },
				identity,
			});
			if (!this.hostActive(identity)) return true;
			this.globalLoadGeneration++;
			this.sessions = this.sessions.filter((item) => item.session_id !== data);
			this.drafts.delete(data);
			const url = new URL(location.href);
			const removedCurrent =
				this.client.connection?.sessionId === data ||
				url.searchParams.get("session") === data;
			if (removedCurrent) {
				this.panels.generation++;
				this.client.retire();
				clearTimeout(this.healthTimer);
				this.clearSessionView();
				this.drafts.current = { text: "", images: [], revision: 0 };
				this.renderer.setDraft("");
				url.searchParams.delete("session");
				history.replaceState(null, "", url);
			}
			if (this.panels.modal === modal) this.panels.modal = undefined;
			this.render();
			await this.loadGlobal();
			if (
				this.hostActive(identity) &&
				navigation === this.navigationGeneration &&
				removedCurrent &&
				!this.client.connection
			) {
				const next = this.sessions.findLast(
					(item) => !item.archived && item.project_id === session?.project_id,
				);
				if (next) await this.selectSession(next.session_id);
			}
			this.render();
			return true;
		}
		if (id === A.SESSION_RENAME_ACTION || id === A.CONVERSATION_RENAME_ACTION) {
			if (!session) throw new Error("会话不存在");
			this.sessionEdit = session;
			this.panels.modal = P.renameSessionModal(
				this.preferences.locale,
				session.session_id,
				session.title,
			);
			this.render();
			return true;
		}
		if (id === A.SESSION_RENAME_MODAL) {
			const original = this.sessionEdit,
				modal = this.panels.modal;
			if (!original || original.session_id !== data || modal?.id !== id)
				return true;
			await this.client.withSession(original.session_id, (connection) =>
				this.client.call("PUT /api/v1/sessions/{session}/title", {
					path: { session: original.session_id },
					body: { title: fields.name ?? "", expected_title: original.title },
					connection,
				}),
			);
			await this.loadGlobal();
			if (this.panels.modal === modal) this.panels.modal = undefined;
			this.render();
			return true;
		}
		if (
			id === Projects.SESSION_ARCHIVE_ACTION ||
			id === A.CONVERSATION_ARCHIVE_ACTION
		) {
			if (!session) throw new Error("会话不存在");
			this.panels.modal = Projects.archiveSessionModal(
				this.preferences.locale,
				session.session_id,
			);
			this.render();
			return true;
		}
		if (
			id === Projects.SESSION_ARCHIVE_MODAL ||
			id === Projects.SESSION_RESTORE_ACTION ||
			id === A.CONVERSATION_RESTORE_ACTION
		) {
			if (!session) throw new Error("会话不存在");
			const modal = this.panels.modal;
			await this.client.withSession(session.session_id, (connection) =>
				this.client.call("POST /api/v1/sessions/{session}/archive", {
					path: { session: session.session_id },
					body: { archived: id === Projects.SESSION_ARCHIVE_MODAL },
					connection,
				}),
			);
			await this.loadGlobal();
			if (this.panels.modal === modal) this.panels.modal = undefined;
			this.render();
			return true;
		}
		if (
			id === Projects.SESSION_ARCHIVE_OPEN_ACTION ||
			id === A.CONVERSATION_SELECT_ACTION
		) {
			if (data) await this.selectSession(data);
			return true;
		}
		if (id === A.CONVERSATIONS_REFRESH_ACTION) {
			await this.loadGlobal();
			this.render();
			return true;
		}
		if (id === Projects.PROJECT_SELECT_ACTION) {
			if (!project) throw new Error("项目不存在");
			this.selectedProject = project.project_id;
			this.expandedProjects = Projects.toggleExpandedProjects(
				this.expandedProjects,
				project.project_id,
			);
			this.render();
			return true;
		}
		if (id === Projects.PROJECT_NEW_SESSION_ACTION) {
			await this.createSession(data);
			return true;
		}
		if (id === Projects.PROJECT_ADD_ACTION) {
			this.projectEdit = undefined;
			this.panels.modal = Projects.addProjectModal(this.preferences.locale);
			this.render();
			return true;
		}
		if (
			id === Projects.PROJECT_EDIT_ACTION ||
			id === Projects.PROJECT_RENAME_ACTION ||
			id === Projects.PROJECT_REMOVE_ACTION
		) {
			if (!project) throw new Error("项目不存在");
			this.projectEdit = project;
			const paths =
				project.workspaces?.map(
					(name) =>
						this.workspaces.find((item) => item.name === name)?.host_path ?? "",
				) ?? [];
			this.panels.modal =
				id === Projects.PROJECT_EDIT_ACTION
					? Projects.editProjectModal(this.preferences.locale, {
							id: project.project_id,
							name: project.name,
							cwd: paths[0] ?? "",
							workspaces: paths,
						})
					: id === Projects.PROJECT_RENAME_ACTION
						? Projects.renameProjectModal(
								this.preferences.locale,
								project.project_id,
								project.name,
							)
						: Projects.removeProjectModal(
								this.preferences.locale,
								project.project_id,
								project.name,
							);
			this.render();
			return true;
		}
		if (
			[
				Projects.PROJECT_ADD_MODAL,
				Projects.PROJECT_EDIT_MODAL,
				Projects.PROJECT_RENAME_MODAL,
				Projects.PROJECT_REMOVE_MODAL,
			].includes(id)
		) {
			const identity = this.client.identity,
				modal = this.panels.modal,
				original = this.projectEdit;
			if (
				!identity ||
				modal?.id !== id ||
				(id !== Projects.PROJECT_ADD_MODAL &&
					(!original || original.project_id !== data))
			)
				return true;
			let workspaces = original?.workspaces ?? ["primary"];
			if (
				id === Projects.PROJECT_ADD_MODAL ||
				id === Projects.PROJECT_EDIT_MODAL
			) {
				const paths: unknown = JSON.parse(fields.workspaces ?? "[]");
				if (
					!Array.isArray(paths) ||
					!paths.length ||
					!paths.every(
						(item) => typeof item === "string" && item.startsWith("/"),
					)
				)
					throw new Error("请选择项目目录");
				workspaces = [];
				for (const path of paths) {
					const grant = await this.client.call(
						"POST /api/v1/workspaces/select",
						{ body: { host_path: path }, identity },
					);
					workspaces.push(grant.name);
				}
			}
			if (id === Projects.PROJECT_ADD_MODAL) {
				const key = `amazme:project:${identity.profile_id}`,
					previous = sessionStorage.getItem(key);
				const record = parseContract(
					"ProjectWrite",
					previous
						? JSON.parse(previous)
						: { project_id: newId(), name: fields.name ?? "", workspaces },
				);
				sessionStorage.setItem(key, JSON.stringify(record));
				const created = await this.client.call("POST /api/v1/projects", {
					body: record,
					identity,
				});
				if (sessionStorage.getItem(key) === JSON.stringify(record))
					sessionStorage.removeItem(key);
				if (this.panels.modal === modal) {
					this.selectedProject = created.project_id;
					this.expandedProjects = [
						...this.expandedProjects,
						created.project_id,
					];
				}
			} else if (original)
				await this.client.call("PUT /api/v1/projects/{project_id}", {
					path: { project_id: original.project_id },
					body: {
						name: fields.name ?? original.name,
						workspaces,
						expected_revision: original.revision ?? 0,
						removed: id === Projects.PROJECT_REMOVE_MODAL,
					},
					identity,
				});
			await this.loadGlobal();
			if (this.panels.modal === modal) this.panels.modal = undefined;
			this.render();
			return true;
		}
		return false;
	}
	private async skillAction(action: P.PanelAction): Promise<boolean> {
		if (action.kind === "open" || action.kind === "modal-close") return false;
		const { id, data } = action,
			fields = action.kind === "modal-submit" ? action.fields : {};
		const connection = this.client.connection,
			identity = this.client.identity,
			navigation = this.navigationGeneration;
		const query = { session_id: connection?.sessionId ?? "" },
			modal = this.panels.modal;
		const panelGeneration = this.panels.generation;
		const current = () =>
			identity !== undefined &&
			this.hostActive(identity) &&
			navigation === this.navigationGeneration &&
			panelGeneration === this.panels.generation &&
			this.panels.modal === modal;
		if (id === P.SKILL_NEW_ACTION) {
			this.skillEdit = undefined;
			this.panels.modal = P.newSkillModal(this.preferences.locale);
			this.render();
			return true;
		}
		if (id === P.SKILL_IMPORT_ACTION) {
			this.skillEdit = undefined;
			this.panels.modal = P.importSkillModal(this.preferences.locale);
			this.render();
			return true;
		}
		if (
			(id === P.SKILL_EDIT_ACTION || id === P.SKILL_REMOVE_ACTION) &&
			action.kind === "command"
		) {
			const document = await this.client.call("GET /api/v1/skills/{name}", {
				path: { name: data ?? "" },
				query,
			});
			if (!current()) return true;
			this.panels.modal =
				id === P.SKILL_REMOVE_ACTION
					? P.removeSkillModal(this.preferences.locale, document.name)
					: P.skillModal(
							this.preferences.locale,
							document.name,
							document.content,
							document.editable,
						);
			this.skillEdit = {
				document,
				sessionId: query.session_id,
				modal: this.panels.modal,
			};
			this.render();
			return true;
		}
		if (id === P.SKILL_VIEW_MODAL) {
			this.panels.modal = undefined;
			this.render();
			return true;
		}
		if (
			action.kind !== "modal-submit" ||
			![
				P.SKILL_CREATE_MODAL,
				P.SKILL_EDIT_MODAL,
				P.SKILL_REMOVE_MODAL,
				P.SKILL_IMPORT_MODAL,
			].includes(id)
		)
			return false;
		if (!identity || !modal || this.panels.modalPending) return true;
		const original = this.skillEdit;
		if (
			(id === P.SKILL_EDIT_MODAL || id === P.SKILL_REMOVE_MODAL) &&
			(!original || original.modal !== modal || original.document.name !== data)
		)
			return true;
		this.panels.pendingModal = modal;
		this.render();
		try {
			if (id === P.SKILL_CREATE_MODAL) {
				const name = (fields.name ?? "").trim();
				await this.client.call("POST /api/v1/skills", {
					body: {
						name,
						content: P.composeSkill(
							name,
							fields.description ?? "",
							fields.body ?? "",
						),
					},
					query,
					identity,
				});
			} else if (id === P.SKILL_IMPORT_MODAL)
				await this.client.call("POST /api/v1/skills/import", {
					body: { path: fields.path ?? "" },
					query,
					identity,
				});
			else if (original) {
				const scope = { session_id: original.sessionId };
				if (id === P.SKILL_EDIT_MODAL)
					await this.client.call("POST /api/v1/skills", {
						body: {
							name: original.document.name,
							content: fields.content ?? "",
							expected_digest: original.document.digest,
						},
						query: scope,
						identity,
					});
				else
					await this.client.call("DELETE /api/v1/skills/{name}", {
						path: { name: original.document.name },
						body: { expected_digest: original.document.digest },
						query: scope,
						identity,
					});
			}
			const generation = ++this.resourceGeneration;
			const resources = await this.client.call("GET /api/v1/skills", { query });
			if (current() && generation === this.resourceGeneration) {
				this.resources = resources;
				this.panels.modal = undefined;
			}
		} finally {
			if (this.panels.pendingModal === modal)
				this.panels.pendingModal = undefined;
			if (navigation === this.navigationGeneration) this.render();
		}
		return true;
	}
	private hostActive(identity: Identity): boolean {
		const current = this.client.identity;
		return (
			!this.disposed &&
			current?.profile_id === identity.profile_id &&
			current.instance_id === identity.instance_id &&
			current.host_epoch === identity.host_epoch &&
			current.build_id === identity.build_id
		);
	}
	private sessionModelIds(sessionId: string): string[] | null {
		const key = `${this.client.identity?.profile_id}:${sessionId}`;
		return (
			(this.modelScopes.has(key)
				? this.modelScopes.get(key)
				: this.preferences.globalModelIds) ?? null
		);
	}
	private render(): void {
		if (this.disposed) return;
		this.renderer.syncDraft?.(this.drafts.current.text);
		document.documentElement.lang = documentLanguage(this.preferences.locale);
		const connection = this.client.connection,
			session = this.sessions.find(
				(item) => item.session_id === connection?.sessionId,
			);
		const directory = pythonDirectory(
			this.sessions,
			this.projects,
			this.workspaces,
		);
		const picker = pythonView({
			locale: this.preferences.locale,
			typography: this.preferences.typography,
			sessions: this.sessions,
			projects: this.projects,
			selectedProject: this.selectedProject,
			expandedProjects: this.expandedProjects,
			workspaces: this.workspaces,
			connection,
			catalog: this.providers.catalog,
			selection: this.selection,
			thinking: this.thinking,
			enabledModels: this.enabledModels,
			rosterFilter: this.rosterFilter,
			draft: this.drafts.current.text,
			paletteSelection: this.paletteSelection,
			commands: this.commands,
			attachments: attachments(
				this.preferences.locale,
				this.drafts.current.images,
			),
			approvalPolicy: this.approvalPolicy,
			panel: P.panelView({
				locale: this.preferences.locale,
				current: this.panels.current,
				settingsSection: this.panels.settingsSection,
				modal: this.panels.modal,
				modalPending: this.panels.modalPending,
				notice: this.panels.notice,
				plugins: {
					state: this.integrations.pluginPanelState(
						this.integrations.pluginPackages,
						this.integrations.pluginRuntime,
						connection?.ready === true,
						this.integrations.mcpConfiguration?.path ?? "AmazMe",
					),
					runtime: this.integrations.mcpPanelRuntime(
						this.integrations.mcpConfiguration,
						this.integrations.mcpRuntime,
						this.ready && (!connection || connection.ready),
						connection?.ready === true,
						this.integrations.mcpLogin,
					),
				},
				automation: {
					state: this.automation.schedules
						? {
								path: this.automation.schedules.path,
								tickMs: this.automation.schedules.tick_ms ?? 5000,
								schedules:
									this.automation.schedules.schedules.map(scheduleRecord),
							}
						: undefined,
					sessionId: connection?.sessionId,
				},
				settings: {
					hostModels: true,
					state: {
						paths: { global: "AmazMe" },
						projectTrusted: true,
						errors: [],
						descriptors: this.preferences.descriptors(this.desktop),
					},
					archives: {
						sessions: directory.sessions,
						projects: directory.projects ?? [],
						retentionDays: 0,
						now: Date.now(),
					},
				},
				skills: {
					state: {
						directory: this.resources?.skill_directory ?? "",
						skills:
							this.resources?.skills.map((item) => ({
								name: item.name,
								description: item.description ?? "",
								filePath: item.path,
								scope: item.scope ?? "user",
								disableModelInvocation: item.disable_model_invocation ?? false,
								editable: item.editable ?? false,
							})) ?? [],
						diagnostics:
							this.resources?.diagnostics.map((message) => ({ message })) ?? [],
					},
				},
			}),
			connections: this.providers.connections(),
			mode: this.mode,
			usage: this.usage,
			history: this.transcript.history,
			feedback: this.feedback,
			historyLoading: this.transcript.historyLoading,
			historyMore:
				this.transcript.history?.more === true ||
				Boolean(
					connection &&
						(connection.snapshot?.requests.filter(
							(row) => row.kind === "root" && settled.has(row.status),
						).length ?? 0) >= 20 &&
						this.transcript.latestTranscriptRevision(connection) >
							this.transcript.historyLatestRevision,
				),
			welcomeDismissed:
				this.preferences.settings?.preferences?.showWelcome === false,
			newSessionPending: this.newSessionPending,
			ready: this.ready,
		});
		const cwd =
			this.workspaces.find((item) => item.name === session?.workspace)
				?.host_path ?? "";
		let pendingError: string | undefined;
		const pending = (() => {
			try {
				return connection
					? this.ledger(connection).read(
							"submission",
							"POST /api/v1/sessions/{session}/submissions",
						)
					: undefined;
			} catch (error) {
				pendingError = error instanceof Error ? error.message : String(error);
				return undefined;
			}
		})();
		let branchPending: string | undefined;
		const commandPending: Array<{
			id: string;
			text: string;
			retry: P.PanelButton;
			cancel: P.PanelButton;
		}> = [];
		try {
			branchPending = connection
				? this.ledger(connection).read(
						"branch",
						"POST /api/v1/sessions/{session}/branches",
					)?.id
				: undefined;
		} catch (error) {
			pendingError = error instanceof Error ? error.message : String(error);
		}
		try {
			const command = connection
				? this.ledger(connection).read(
						"command",
						"POST /api/v1/sessions/{session_id}/plugins/{plugin_id}/calls",
					)
				: undefined;
			if (command)
				commandPending.push({
					id: command.id,
					text: `插件命令尚未确认：/${command.body.name}`,
					retry: {
						id: "write:retry-command",
						data: command.id,
						label: "重试原命令",
						weight: "line",
					},
					cancel: {
						id: "write:cancel-command",
						data: command.id,
						label: "取消原命令",
						weight: "text",
					},
				});
		} catch (error) {
			pendingError = error instanceof Error ? error.message : String(error);
		}
		const feedbackPending: Array<{
			id: string;
			text: string;
			retry: P.PanelButton;
		}> = [];
		try {
			if (connection)
				for (const request of new Set(
					[
						...(connection.snapshot?.requests ?? []),
						...(this.transcript.history?.requests ?? []),
					].map((item) => item.request_id),
				)) {
					const record = this.ledger(connection).read(
						`feedback:${request}`,
						"POST /api/v1/sessions/{session}/feedback",
					);
					if (record)
						feedbackPending.push({
							id: record.id,
							text: "答案反馈尚未确认",
							retry: {
								id: "write:retry-feedback",
								data: JSON.stringify([
									connection.sessionId,
									request,
									record.id,
								]),
								label: "重试原反馈",
								weight: "line",
							},
						});
				}
		} catch (error) {
			pendingError = error instanceof Error ? error.message : String(error);
		}
		const terminal =
			this.dock.terminal?.connection === connection
				? this.dock.terminal
				: undefined;
		const commandBlocks: TranscriptBlock[] = [
			...(this.commandResults
				.get(`${connection?.identity.profile_id}:${connection?.sessionId}`)
				?.values() ?? []),
		].map(({ name, result }) => {
			const content = result.result?.content ?? [],
				text =
					content
						.filter(
							(item) => item.type === "text" && typeof item.text === "string",
						)
						.map((item) => item.text)
						.join("\n") ||
					result.error ||
					result.phase;
			const error =
				result.phase === "failed" ||
				result.phase === "conflict" ||
				result.result?.is_error === true;
			return {
				id: `command:${result.call_id}`,
				kind: "tool",
				title: `/${name}`,
				toolName: name,
				text,
				running: false,
				tone: error ? "error" : "plain",
				images: content.flatMap((item) =>
					item.type === "image" &&
					typeof item.mimeType === "string" &&
					["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
						item.mimeType,
					) &&
					typeof item.data === "string"
						? [
								{
									dataUrl: `data:${item.mimeType};base64,${item.data}`,
									alt: name,
								},
							]
						: [],
				),
				result: toolResultView(
					this.preferences.locale,
					name,
					{},
					{
						content: [{ type: "text", text }],
						isError: error,
						details: result.result?.details,
					},
				),
			};
		});
		const dock = dockView(this.preferences.locale, {
			usage: this.usage,
			open: this.dock.dockOpen,
			tab: this.dock.dockTab,
			cwd,
			workspace: this.dock.workspace,
			terminal: terminal
				? {
						status: terminal.view.phase === "running" ? "running" : "done",
						command: "/bin/zsh -il",
						exitCode: terminal.view.exit_code ?? null,
						output: "",
						truncated: false,
						error: null,
					}
				: undefined,
			conversations: {
				selected: connection?.sessionId ?? "",
				conversations: this.sessions
					.filter(
						(item) =>
							item.session_id === connection?.sessionId ||
							item.session_id === session?.parent_id ||
							item.parent_id === connection?.sessionId ||
							Boolean(
								session?.parent_id && item.parent_id === session.parent_id,
							),
					)
					.map((item) => ({
						id: item.session_id,
						label: item.title,
						root: !item.parent_id,
						role: item.parent_id ? ("fork" as const) : ("main" as const),
						parentConversationId: item.parent_id || undefined,
						children: this.sessions.filter(
							(child) => child.parent_id === item.session_id,
						).length,
						hasEntries: true,
						...(item.archived ? { archivedAt: item.updated_ms ?? 0 } : {}),
					})),
				tasks: (connection?.snapshot?.requests ?? []).map((item) => ({
					id: item.request_id,
					kind: item.kind ?? "root",
					conversationId: connection?.sessionId ?? "",
					background: item.kind === "child",
					status: item.status,
					phase: item.status,
					waitsOn: item.children ?? [],
					conversations: [],
				})),
			},
		});
		this.renderer.render({
			...picker,
			blocks: [...picker.blocks, ...commandBlocks],
			readOnly: picker.readOnly || Boolean(pendingError),
			queue: [
				...picker.queue,
				...commandPending,
				...feedbackPending,
				...(branchPending
					? [
							{
								id: branchPending,
								text: "分支创建尚未确认",
								retry: {
									id: "write:retry-branch",
									data: branchPending,
									label: "重试原分支",
									weight: "line" as const,
								},
							},
						]
					: []),
				...(pending
					? [
							{
								id: pending.id,
								text: `请求尚未确认：${pending.body.text}`,
								retry: {
									id: "write:retry-submit",
									data: pending.id,
									label: "重试原请求",
									weight: "line" as const,
								},
								cancel: {
									id: "write:cancel-submit",
									data: pending.id,
									label: "取消原请求",
									weight: "text" as const,
								},
							},
						]
					: []),
			],
			dock:
				terminal && this.dock.dockTab === "terminal"
					? {
							...dock,
							panel: {
								...dock.panel,
								texts: [],
								notices: terminal.queue.paused
									? [
											{
												tone: "warning",
												text: "终端输入尚未确认；请重试原输入或核对后继续。",
											},
										]
									: dock.panel.notices,
								actions: [
									{
										id: "terminal:retry",
										label: "重试原输入",
										weight: "line",
										disabled:
											terminal.queue.busy || !terminal.queue.items.length,
									},
									{
										id: "terminal:confirm",
										label: "核对后继续",
										weight: "text",
										disabled:
											terminal.queue.busy || !terminal.queue.items.length,
									},
								],
							},
							pty: {
								id: terminal.id,
								cols: terminal.view.cols,
								rows: terminal.view.rows,
								output: terminal.view.output,
								outputSeq:
									terminal.view.output_seq ?? terminal.view.output.length,
								fontFamily: this.preferences.typography.terminalFont,
								fontSize: this.preferences.typography.terminalSize,
								inputEnabled:
									connection?.ready === true &&
									terminal.view.phase === "running" &&
									!terminal.queue.paused,
							},
						}
					: dock,
		});
		if (pendingError) this.renderer.setConnection(pendingError, "error");
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.navigationGeneration++;
		this.globalLoadGeneration++;
		this.interactionGeneration++;
		this.stopTheme();
		this.renderer.dispose?.();
		window.removeEventListener("focus", this.refreshDesktopPreferences);
		clearTimeout(this.healthTimer);
		this.providers.dispose();
		this.integrations.dispose();
		this.dock.dispose();
		this.transcript.reset();
		this.client.retire();
	}
}
