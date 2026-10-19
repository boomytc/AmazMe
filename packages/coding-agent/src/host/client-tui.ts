import { sourceFacets } from "./services/connection.ts";
import { createServiceHost, serviceFacet, type ServiceValue, disposeResources } from "@amazme/protocol/services";
import { resolve } from "node:path";
import type { Host, Facet, FacetLoader, JsonValue } from "@amazme/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@amazme/chord/context";
import type { AgentState, ConversationView, EntryRecord } from "@amazme/durable";
import { CombinedAutocompleteProvider, type Component, Container, isFocusable, type SelectItem, SelectList, setKeybindings, Text, type TUI } from "@amazme/tui";
import { manageProviderAuth } from "../durable/provider-menu.ts";
import { ListSelector } from "../modes/interactive/components/list-selector.ts";
import { keyText } from "../modes/interactive/components/keybinding-hints.ts";
import { ScopedModelsSelectorComponent } from "../modes/interactive/components/scoped-models-selector.ts";
import { Models } from "./services/models.ts";
import type { ClientCommand } from "../cli/host/commands/client.ts";
import { getAgentDir } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { oldestPresentedEntryId, type TaskSummary } from "../durable/conversation-view.ts";
import { createChatViewport } from "../modes/interactive/chat-viewport.ts";
import { CustomEditor } from "../modes/interactive/components/custom-editor.ts";
import { durablePromptShortcutLine } from "../modes/interactive/composer-contract.ts";
import { getEditorTheme, setRegisteredThemes, stopThemeWatcher, theme } from "../modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../modes/interactive/theme/theme-controller.ts";
import { createInteractiveTui } from "../modes/interactive/tui-renderer.ts";
import { type OpenClientRuntimeOptions, openClientRuntime } from "./client-runtime.ts";
import { ExperimentalChatView } from "./client-tui-chat.ts";
import { loadFacets, createPresentationFacetLoaders } from "./plugins/bundled.ts";
import { AgentController, type AgentOperationResponse, type AgentQueueResponse } from "../core/plugins/agent-controller.ts";
import type { ServerConnectionState, ServerServiceSource, SessionAttachmentState, SessionServiceSource } from "./services/connection.ts";
import { Conversations, type Conversations as ConversationsService } from "./services/conversations.ts";
import { PresentationPlugins } from "./services/plugins.ts";
import { PresentationUI } from "./services/presentation-ui.ts";
import { SessionDirectory, SessionManagement, type SessionSummary } from "./services/sessions.ts";
import { SlashCommands } from "../core/plugins/slash-commands.ts";
import { createBuiltInSlashCommandsFacet } from "./services/slash-commands-provider.ts";
import { createSlashCommandsRuntimeFacet } from "../core/plugins/command-registry.ts";
import { liveOf, Transcript, type Transcript as TranscriptService } from "./services/transcript.ts";
import { formatLane } from "../durable/session-surface.ts";
import { Commands } from "./services/commands.ts";
import { SessionInsights } from "./services/insights.ts";
import { createInsightsCommandsFacet } from "./services/insights-commands.ts";
import { formatRestartCount } from "../durable/restart-count.ts";
import { sessionDatabaseErrorText } from "./session-database-error.ts";

/** Commands owned by the terminal presentation, not by the worker. */
const TERMINAL_COMMANDS = [
	{ name: "tree", description: "Navigate conversation history" },
	{ name: "agents", description: "Switch conversations" },
	{ name: "fork", description: "Fork the current conversation" },
	{ name: "older", description: "Load older history" },
	{ name: "scoped_models", description: "Choose models shown in /model and model cycling" },
] as const;

export interface RunClientTuiOptions extends OpenClientRuntimeOptions {
	readonly facetLoader?: FacetLoader;
}

export interface ClientTuiServer {
	readonly serverId: string;
	readonly radius: boolean;
	readonly server: ServerServiceSource;
	readonly session: SessionServiceSource;
}

interface SessionFeature {
	readonly serverId: string;
	readonly session: SessionServiceSource;
	readonly transcript: TranscriptService;
}

interface PreparedClientSession {
	readonly server: ClientTuiServer;
	readonly summary: SessionSummary;
	readonly presentationPlugins: JsonValue;
}

interface PendingSelection {
	readonly title: string;
	readonly items: readonly SelectItem[];
	readonly selectedValue?: string;
	resolve(value: string | undefined): void;
}

const selectTheme = {
	selectedPrefix: (text: string) => theme.fg("accent", text),
	selectedText: (text: string) => theme.fg("accent", text),
	description: (text: string) => theme.fg("muted", text),
	scrollInfo: (text: string) => theme.fg("dim", text),
	noMatch: (text: string) => theme.fg("warning", text) };

/** Service-only presentation driven by a replicated main-lane snapshot. */
export class ExperimentalClientTui implements Component {
	readonly #ui: TUI;
	readonly #requestRender: () => void;
	readonly #finish: () => void;
	readonly #documentContainer = new Container();
	readonly #sessionHeading = new Text("", 1, 0);
	readonly #pendingMessagesContainer = new Container();
	readonly #statusContainer = new Container();
	readonly #editorContainer = new Container();
	readonly #footerComponent = new Text("", 1, 0);
	readonly #layoutRoot: Component;
	readonly #sharedFacets: readonly Facet[];
	readonly #keybindings = KeybindingsManager.create();
	#facetHost: Host | undefined;
	#facetReloadTail = Promise.resolve();
	#session: SessionFeature | undefined;
	#slashCommands: SlashCommands | undefined;
	#commands: Commands | undefined;
	#controller: AgentController | undefined;
	#conversations: ConversationsService | undefined;
	#models: Models | undefined;
	#authComponent: Component | undefined;
	#modelScopeSelector: ScopedModelsSelectorComponent | undefined;
	#selectionEpoch = 0;
	#authFlow: { controller: AbortController; done: Promise<void> } | undefined;
	#history: readonly EntryRecord[] = [];
	#historyCursor: string | null = null;
	#historyLoaded = false;
	/** The next submitted line is custom branch-summary instructions, not a prompt. */
	#pendingSummary: { readonly conversationId: string; readonly at: string } | undefined;
	readonly #chatInput: CustomEditor;
	#selectList: SelectList | undefined;
	#selection: PendingSelection | undefined;
	#screen: "select" | "chat" = "chat";
	#selectedServerId: string | undefined;
	#sessionId: string | undefined;
	#status = "Starting Session…";
	#busy = false;
	#closed = false;
	#closePromise: Promise<void> | undefined;
	#recoveryTransition: Promise<void> = Promise.resolve();
	#laneUnsubscribe: (() => void) | undefined;
	#chatView: ExperimentalChatView | undefined;

	private constructor(ui: TUI, requestRender: () => void, finish: () => void, loadedFacets: readonly Facet[]) {
		this.#ui = ui;
		this.#requestRender = requestRender;
		this.#finish = finish;
		this.#sharedFacets = loadedFacets;
		setKeybindings(this.#keybindings);
		this.#chatInput = new CustomEditor(ui, getEditorTheme(), this.#keybindings, { paddingX: 1 });
		this.#chatInput.onSubmit = (message) => void this.#runPrompt(message);
		this.#chatInput.onEscape = () => this.#interrupt();
		this.#chatInput.onCtrlD = finish;
		this.#chatInput.onAction("app.clear", finish);
		this.#chatInput.onAction("app.model.select", () => void this.#executeSlashCommand("model", ""));
		this.#chatInput.onAction("app.tasks.retry", () => void this.#retryParkedTask());
		this.#chatInput.onAction("app.thinking.cycle", () => {
			void this.#models?.cycleThinking(BACKGROUND_CONTEXT).catch((error: unknown) => this.showError(message(error)));
		});
		for (const [action, direction] of [["app.model.cycleForward", "forward"], ["app.model.cycleBackward", "backward"]] as const)
			this.#chatInput.onAction(action, () => {
				void this.#models?.cycleModel(direction, BACKGROUND_CONTEXT).catch((error: unknown) => this.showError(message(error)));
			});
		this.#chatInput.onAction("app.message.followUp", () => {
			const text = this.#chatInput.getText().trim();
			if (text.length === 0) return;
			this.#chatInput.setText("");
			void this.#queueFollowUp(text);
		});
		this.#editorContainer.addChild(this.#chatInput);
		this.#layoutRoot = createChatViewport({
			document: this.#documentContainer,
			pendingMessages: this.#pendingMessagesContainer,
			status: this.#statusContainer,
			editor: this.#editorContainer,
			footer: this.#footerComponent,
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text) }).root;
		this.#rebuild();
	}

	static async create(options: {
		readonly command: ClientCommand;
		readonly ui: TUI;
		readonly servers: readonly ClientTuiServer[];
		readonly facetLoader?: FacetLoader;
		requestRender(): void;
		finish(): void;
	}): Promise<ExperimentalClientTui> {
		const prepared = await prepareClientSession(options.command, options.servers);
		const loadedFacets = await loadFacets(options.facetLoader === undefined ? [] : [options.facetLoader]);
		const component = new ExperimentalClientTui(options.ui, options.requestRender, options.finish, loadedFacets);
		try {
			await component.#start(prepared);
			await component.#openPreparedSession(prepared);
			return component;
		} catch (error) {
			try {
				await component.close();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Experimental TUI startup and cleanup failed");
			}
			throw error;
		}
	}

	get layoutRoot(): Component {
		return this.#layoutRoot;
	}

	render(width: number): string[] {
		return [
			...this.#documentContainer.render(width),
			...this.#pendingMessagesContainer.render(width),
			...this.#statusContainer.render(width),
			...this.#editorContainer.render(width),
			...this.#footerComponent.render(width),
		];
	}

	handleInput(data: string): void {
		if (this.#modelScopeSelector && !this.#busy) {
			this.#modelScopeSelector.handleInput(data);
			this.#requestRender();
			return;
		}
		if (this.#authComponent && !this.#busy) {
			if (this.#keybindings.matches(data, "app.clear")) this.#authFlow?.controller.abort();
			else this.#authComponent.handleInput?.(data);
			this.#requestRender();
			return;
		}
		if (this.#busy) {
			if (this.#keybindings.matches(data, "app.clear") || (this.#chatInput.getText().length === 0 && this.#keybindings.matches(data, "app.exit"))) {
				this.#finish();
			}
			return;
		}
		if (this.#screen === "chat") {
			this.#chatInput.handleInput(data);
			this.#requestRender();
			return;
		}
		this.#selectList?.handleInput(data);
	}

	invalidate(): void {
		this.#layoutRoot.invalidate();
	}

	dispose(): void {
		void this.close().catch(() => {});
	}

	refreshTheme(): void {
		const view = this.#conversationView();
		if (view !== undefined) this.#chatView?.refreshTheme(view);
		this.#rebuild();
	}

	showError(error: string): void {
		if (this.#closed) return;
		this.#status = `Error: ${error}`;
		this.#rebuild();
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #start(prepared: PreparedClientSession): Promise<void> {
		const server = prepared.server;
		const hasInsights = (await server.session.catalogue(BACKGROUND_CONTEXT)).some(entry => entry.serviceId === SessionInsights.name);
		let presentationFacets = await loadFacets(createPresentationFacetLoaders(prepared.presentationPlugins));
		let facetHost!: Host;
		const reloadPresentationPlugins = (data: JsonValue): Promise<void> => {
			const operation = this.#facetReloadTail.then(async () => {
				if (this.#authFlow) await this.#stopAuthentication();
				const candidate = await loadFacets(createPresentationFacetLoaders(data));
				const previousNames = new Set(presentationFacets.map(facet => facet.name));
    const names = new Set(candidate.map(facet => facet.name));
    const bridges = await sourceFacets([...builtins, ...candidate], [server.server, server.session]);
    await facetHost.reload([...bridges, ...candidate], { remove: [...previousNames].filter(name => !names.has(name)) });
    presentationFacets = candidate;
			});
			this.#facetReloadTail = operation.catch(() => {});
			return operation;
		};
		const presentationBridgeFacet = serviceFacet(
			"@pi/presentation-bridge",
			PresentationUI,
			[SlashCommands, Commands, AgentController, Transcript, Conversations, Models],
			async (services) => {
				const disposers: Array<() => void | Promise<void>> = [];
				try {
					const implementation: ServiceValue<typeof PresentationUI> = {
						select: (title, items, selectedValue) =>
							this.#select(
								title,
								items.map((item) => ({ ...item })),
								selectedValue,
							),
						showStatus: (status) => {
							this.#status = status;
							this.#rebuild();
						},
					};
					const commands = services.get(SlashCommands);
					const catalog = services.get(Commands);
					const controller = services.get(AgentController);
					const transcript = services.get(Transcript);
					const conversations = services.get(Conversations);
					const models = services.get(Models);
					const sessionFeature: SessionFeature = {
						serverId: server.serverId,
						session: server.session,
						transcript,
					};
					await (() => {
						if (this.#session !== undefined || this.#slashCommands !== undefined || this.#controller !== undefined) {
							throw new Error("Presentation services are already active");
						}
						this.#session = sessionFeature;
						this.#slashCommands = commands;
						this.#commands = catalog;
						this.#controller = controller;
						this.#conversations = conversations;
						this.#models = models;
						disposers.push(() => {
							if (this.#session === sessionFeature) this.#session = undefined;
							if (this.#slashCommands === commands) this.#slashCommands = undefined;
							if (this.#commands === catalog) this.#commands = undefined;
							if (this.#controller === controller) this.#controller = undefined;
							if (this.#conversations === conversations) this.#conversations = undefined;
							if (this.#models === models) this.#models = undefined;
						});
						disposers.push(
							conversations.state.subscribe(() => {
								const shown = this.#conversationView();
								if (shown !== undefined) this.#chatView?.apply(this.#withHistory(shown));
								this.#rebuild();
							}),
						);
						disposers.push(commands.subscribe(() => this.#updateAutocomplete()));
						disposers.push(catalog.state.subscribe(() => this.#updateAutocomplete()));
						disposers.push(
							models.state.subscribe(() => {
								this.#updateAutocomplete();
								this.#rebuild();
							}),
						);
						disposers.push(
							server.session.attachment.subscribe((state) => {
								if (state.status !== "attached" || state.sessionId !== this.#sessionId) this.#authFlow?.controller.abort();
							}),
						);
						if (server.radius) {
							disposers.push(
								server.server.connection.subscribe((state) => this.#handleConnectionState(server.serverId, state)),
							);
							disposers.push(
								server.session.attachment.subscribe((state) => this.#handleAttachmentState(sessionFeature, state)),
							);
						}
					})();

					return { value: implementation, close: () => disposeResources(disposers) };
				} catch (error) {
					await disposeResources(disposers);
					throw error;
				}
			},
		);
		const builtins = [
   createSlashCommandsRuntimeFacet(), presentationBridgeFacet,
   createBuiltInSlashCommandsFacet({ reloadPresentationPlugins, authenticate: (mode, provider) => this.#authenticate(mode, provider) }),
   ...(hasInsights ? [createInsightsCommandsFacet()] : []), ...this.#sharedFacets,
  ];
  facetHost = createServiceHost("presentation");
  this.#facetHost = facetHost;
  const bridges = await sourceFacets([...builtins, ...presentationFacets], [server.server, server.session]);
  await facetHost.load([...bridges, ...builtins, ...presentationFacets]);
		this.#facetHost = facetHost;
	}

	async #openPreparedSession(prepared: PreparedClientSession): Promise<void> {
		const feature = this.#session;
		if (feature === undefined) throw new Error(`No Session service is available for ${prepared.server.serverId}`);
		await feature.session.whenAttached(prepared.summary.sessionId, BACKGROUND_CONTEXT);
		this.#selectedServerId = feature.serverId;
		this.#sessionId = prepared.summary.sessionId;
		this.#updateAutocomplete();
		await this.#openLane(feature);
		this.#screen = "chat";
		this.#status = "";
		this.#rebuild();
	}

	async #close(): Promise<void> {
		this.#closed = true;
		if (this.#authFlow) await this.#stopAuthentication();
		this.#completeSelection(undefined);
		const errors: unknown[] = [];
		try {
			await this.#recoveryTransition;
			await this.#closeLane();
			await this.#facetReloadTail;
		} catch (error) {
			errors.push(error);
		}
		if (this.#facetHost !== undefined) {
			try {
				await this.#facetHost.close();
			} catch (error) {
				errors.push(error);
			}
			this.#facetHost = undefined;
		}

		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose experimental TUI facets");
	}

	/** Tasks the restart limit parked: pending, and blocked for that reason. */
	#parkedTasks(): readonly TaskSummary[] {
		return (this.#conversations?.state.value?.tasks ?? []).filter(
			(task) => task.status === "pending" && task.blocked === "restart_limit",
		);
	}

	async #retryParkedTask(): Promise<void> {
		const conversations = this.#conversations;
		const parked = this.#parkedTasks();
		if (conversations === undefined || parked.length === 0) return;
		let target = parked[0]!;
		if (parked.length > 1) {
			const value = await this.#select(
				"Retry which paused task?",
				parked.map((task) => ({
					value: task.id,
					label: `Task #${task.id}`,
					description: `${task.kind} · ${formatRestartCount(task.restarts ?? task.restartLimit ?? 0, task.restartLimit)} interruptions`,
				})),
			);
			if (value === undefined) return;
			target = parked.find((task) => task.id === value) ?? target;
		}
		try {
			await conversations.retryTask(target.id, BACKGROUND_CONTEXT);
			this.#status = `Retried task #${target.id}.`;
		} catch (error) {
			this.#status = `Retry failed: ${message(error)}`;
		}
		this.#rebuild();
	}

	#rebuild(): void {
		const conversation = this.#conversationView();
		const agent = conversation?.docs["amazme.agent"] as AgentState | undefined;
		const running = conversation !== undefined && liveOf(conversation).run !== undefined;
		this.#chatInput.setModelLabel(() => `${agent?.model?.modelId ?? "No model"} · ${agent?.thinkingLevel ?? "off"}`);
		this.#chatInput.setShortcutLine(() => durablePromptShortcutLine(running));
		this.#sessionHeading.setText(
			this.#sessionId === undefined || this.#selectedServerId === undefined
				? ""
				: theme.fg("dim", `Server: ${this.#selectedServerId}\nSession: ${this.#sessionId}`),
		);
		this.#statusContainer.clear();
		if (this.#status.length > 0) {
			this.#statusContainer.addChild(new Text(theme.fg("dim", this.#status), 1, 0));
		}
		if (this.#chatView !== undefined) this.#statusContainer.addChild(this.#chatView.status);
		for (const task of this.#parkedTasks()) {
			const attempts = task.restarts ?? task.restartLimit ?? 0;
			const limit = task.restartLimit === null ? "" : ` (limit ${String(task.restartLimit)})`;
			this.#statusContainer.addChild(
				new Text(
					theme.fg(
						"warning",
						`Task #${task.id} paused after ${String(attempts)} consecutive interruptions${limit}; ${keyText("app.tasks.retry")} to retry.`,
					),
					1,
					0,
				),
			);
		}
		this.#footerComponent.setText(theme.fg("dim", this.#footer()));
		this.#editorContainer.clear();
		if (this.#authComponent !== undefined) {
			this.#chatInput.focused = false;
			this.#selectList = undefined;
			this.#editorContainer.addChild(this.#authComponent);
		} else if (this.#modelScopeSelector !== undefined) {
			this.#chatInput.focused = false;
			this.#editorContainer.addChild(this.#modelScopeSelector);
		} else if (this.#screen === "select" && this.#selection !== undefined) {
			this.#chatInput.focused = false;
			const selector = new Container();
			selector.addChild(new Text(theme.bold(this.#selection.title), 1, 1));
			const items = [...this.#selection.items];
			this.#selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), selectTheme);
			const selectedIndex = items.findIndex((item) => item.value === this.#selection?.selectedValue);
			if (selectedIndex >= 0) this.#selectList.setSelectedIndex(selectedIndex);
			this.#selectList.onSelect = (item) => this.#completeSelection(item.value);
			this.#selectList.onCancel = () => this.#completeSelection(undefined);
			selector.addChild(this.#selectList);
			this.#editorContainer.addChild(selector);
		} else {
			this.#selectList = undefined;
			this.#chatInput.focused = !this.#busy;
			this.#editorContainer.addChild(this.#chatInput);
		}
		this.#layoutRoot.invalidate();
		this.#requestRender();
	}

	#select(title: string, items: readonly SelectItem[], selectedValue?: string): Promise<string | undefined> {
		++this.#selectionEpoch;
		this.#modelScopeSelector = undefined;
		if (this.#selection !== undefined) throw new Error("A slash command selector is already active");
		return new Promise((resolve) => {
			this.#selection = {
				title,
				items,
				...(selectedValue === undefined ? {} : { selectedValue }),
				resolve };
			this.#screen = "select";
			this.#rebuild();
		});
	}

	#completeSelection(value: string | undefined): void {
		const selection = this.#selection;
		if (selection === undefined) return;
		this.#selection = undefined;
		this.#screen = "chat";
		selection.resolve(value);
		if (!this.#closed) this.#rebuild();
	}

	async #stopAuthentication(): Promise<void> {
		const flow = this.#authFlow;
		flow?.controller.abort();
		await flow?.done;
	}

	#authenticate(mode: "login" | "logout", provider: string | undefined): Promise<void> {
		++this.#selectionEpoch;
		this.#modelScopeSelector = undefined;
		const models = this.#models;
		const feature = this.#session;
		const sessionId = this.#sessionId;
		if (!models || !feature || !sessionId || this.#authFlow) return Promise.resolve();
		const owner = new AbortController();
		const sameTarget = () => {
			const attachment = feature.session.attachment.value;
			return this.#session === feature && this.#models === models && this.#sessionId === sessionId
				&& attachment?.status === "attached" && attachment.sessionId === sessionId;
		};
		const context = () => {
			owner.signal.throwIfAborted();
			if (this.#closed || !sameTarget()) throw new Error("The authentication session changed");
			return withAbortSignal(owner.signal, BACKGROUND_CONTEXT);
		};
		const mount = (component: Component) => {
			if (owner.signal.aborted || this.#closed || !sameTarget()) return;
			if (this.#authComponent && isFocusable(this.#authComponent)) this.#authComponent.focused = false;
			this.#authComponent = component;
			if (isFocusable(component)) component.focused = true;
			this.#rebuild();
		};
		const done = manageProviderAuth({
			snapshot: () => sameTarget() ? models.state.value?.authentication ?? { providers: [], login: null } : { providers: [], login: null },
			subscribe: (listener) => models.state.subscribe(listener),
			startLogin: (id, method) => models.startLogin(id, method, context()),
			submitPrompt: (id, promptId, value) => models.submitLoginPrompt(id, promptId, value, context()),
			cancelLogin: (id) => sameTarget() ? models.cancelLogin(id, withAbortSignal(AbortSignal.timeout(5_000), BACKGROUND_CONTEXT)) : Promise.resolve(false),
			logout: (id) => models.logout(id, context()) }, mode, provider, {
			ui: this.#ui,
			mount,
			select: (title, items, confirm, cancel) => mount(new ListSelector(title, items, confirm, cancel)),
			inform: (text, close) => {
				const panel = new Container();
				panel.addChild(new Text(text, 1, 1));
				const back = new SelectList([{ value: "close", label: "Back to prompt" }], 1, selectTheme);
				back.onSelect = close; back.onCancel = close;
				panel.addChild(back);
				mount({ render: width => panel.render(width), invalidate: () => panel.invalidate(), handleInput: data => back.handleInput(data) });
			} }, owner.signal).then((result) => {
			if (this.#closed || this.#busy || !sameTarget()) return;
			const login = models.state.value?.authentication?.login;
			this.#status = result && "loggedOut" in result ? "Saved credentials removed; environment credentials remain available."
				: result && "id" in result && login?.id === result.id
					? login.error ?? (login.status === "done" ? "Signed in. Select a model with /model." : "Provider sign-in ended.")
					: "Provider authentication ended.";
		}).finally(() => {
			if (this.#authFlow?.controller !== owner) return;
			this.#authComponent = undefined;
			this.#authFlow = undefined;
			if (!this.#closed && !this.#busy && sameTarget()) {
				this.#rebuild();
			}
		});
		this.#authFlow = { controller: owner, done };
		return done;
	}

	#updateAutocomplete(): void {
		const commands = this.#selectedSlashCommands()?.list() ?? [];
		const catalog = this.#commands;
		const taken = new Set([...TERMINAL_COMMANDS, ...commands].map(command => command.name));
		const remote = catalog === undefined ? [] : (catalog.state.value?.commands ?? [])
			.filter(command => !taken.has(command.name))
			.map(command => ({
				...command,
				getArgumentCompletions: async (prefix: string) => {
					const items = await catalog.complete(command.name, prefix, BACKGROUND_CONTEXT);
					return this.#closed || catalog !== this.#commands ? [] : [...items];
				} }));
		this.#chatInput.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[...TERMINAL_COMMANDS, ...commands.filter(command => !TERMINAL_COMMANDS.some(local => local.name === command.name)).map((command) => ({
					name: command.name,
					description: command.description,
					...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
					...(command.getArgumentCompletions === undefined
						? {}
						: {
								getArgumentCompletions: async (prefix: string) => {
									const items = await command.getArgumentCompletions!(prefix);
									return items === null ? null : [...items];
								} }) })), ...remote],
				process.cwd(),
			),
		);
		this.#requestRender();
	}

	#selectedSlashCommands(): SlashCommands | undefined {
		return this.#slashCommands;
	}

	#handleConnectionState(serverId: string, state: ServerConnectionState): void {
		if (this.#closed || this.#selectedServerId !== serverId) return;
		if (state.status === "connected") {
			if (this.#laneUnsubscribe === undefined) {
				this.#busy = true;
				this.#status = "Reattaching Session…";
				this.#rebuild();
			}
			return;
		}
		this.#busy = true;
		this.#status = state.status === "connecting" ? "Reconnecting to Radius…" : "Radius disconnected; retrying…";
		this.#queueRecovery(() => this.#closeLane());
		this.#rebuild();
	}

	#handleAttachmentState(feature: SessionFeature, state: SessionAttachmentState): void {
		if (this.#closed || this.#selectedServerId !== feature.serverId || this.#sessionId === undefined) return;
		if (state.status === "attached" && state.sessionId === this.#sessionId) {
			this.#queueRecovery(async () => {
				if (this.#laneUnsubscribe === undefined) await this.#openLane(feature);
				this.#busy = false;
				this.#status = "";
				this.#rebuild();
			});
			return;
		}
		if (state.status === "attaching" && state.sessionId === this.#sessionId) {
			this.#busy = true;
			this.#status = "Reattaching Session…";
			this.#rebuild();
		}
	}

	#queueRecovery(operation: () => Promise<void>): void {
		this.#recoveryTransition = this.#recoveryTransition
			.then(async () => {
				if (!this.#closed) await operation();
			})
			.catch((error: unknown) => {
				if (this.#closed) return;
				this.#busy = true;
				this.#status = `Reconnect error: ${message(error)}`;
				this.#rebuild();
			});
	}

	async #openLane(feature: SessionFeature): Promise<void> {
		await this.#closeLane();
		const view = new ExperimentalChatView(this.#ui, process.cwd(), () => this.#interrupt());
		this.#chatView = view;
		this.#documentContainer.addChild(this.#sessionHeading);
		this.#documentContainer.addChild(view.transcript);
		this.#pendingMessagesContainer.addChild(view.pendingMessages);
		this.#laneUnsubscribe = feature.transcript.state.subscribe(() => {
			const shown = this.#conversationView();
			if (shown !== undefined) view.apply(this.#withHistory(shown));
			this.#rebuild();
		});
		if (feature.transcript.state.value === undefined) {
			await this.#closeLane();
			throw new Error("Transcript has no initialized view");
		}
	}

	async #closeLane(): Promise<void> {
		++this.#selectionEpoch;
		this.#modelScopeSelector = undefined;
		if (this.#authFlow) await this.#stopAuthentication();
		this.#laneUnsubscribe?.();
		this.#laneUnsubscribe = undefined;
		this.#chatView?.dispose();
		this.#chatView = undefined;
		this.#documentContainer.clear();
		this.#pendingMessagesContainer.clear();
		this.#statusContainer.clear();
	}

	async #runPrompt(messageText: string): Promise<void> {
		const prompt = messageText.trim();
		const pending = this.#pendingSummary;
		if (pending !== undefined && !prompt.startsWith("/")) {
			this.#pendingSummary = undefined;
			this.#chatInput.setText("");
			await this.#finishLeave(pending.conversationId, pending.at, true, prompt.length === 0 ? null : prompt);
			return;
		}
		if (pending !== undefined) this.#pendingSummary = undefined;
		if (prompt.length === 0) return;
		if (prompt.startsWith("/")) {
			this.#chatInput.setText("");
			const separator = prompt.indexOf(" ");
			const name = prompt.slice(1, separator === -1 ? undefined : separator);
			const args = separator === -1 ? "" : prompt.slice(separator + 1).trim();
			await this.#executeSlashCommand(name, args);
			return;
		}
		this.#chatInput.setText("");
		try {
			await this.#submitPrompt(prompt);
		} catch (error) {
			this.#status = `Error: ${message(error)}`;
			this.#rebuild();
		}
	}

	async #executeSlashCommand(name: string, args: string): Promise<void> {
		if (name === "scoped_models") {
			if (args.length > 0) { this.showError("Usage: /scoped_models"); return; }
			await this.#configureModelScope();
			return;
		}
		if (name === "tree" || name === "agents") {
			await this.#switchConversation();
			return;
		}
		if (name === "fork") {
			const conversations = this.#conversations;
			const id = conversations?.state.value?.selected;
			if (conversations === undefined || id === undefined) {
				this.#status = "No conversation to fork.";
				this.#rebuild();
				return;
			}
			this.#history = [];
			this.#historyCursor = null;
			this.#historyLoaded = false;
			const result = await conversations.fork(id, null, BACKGROUND_CONTEXT);
			this.#status = result.error === null ? `Forked ${result.conversationId}.` : result.error.message;
			this.#rebuild();
			return;
		}
		if (name === "older") {
			await this.#loadOlder();
			return;
		}
		const focused = this.#focusedId();
		if (name === "compact" && focused !== undefined && this.#conversations !== undefined) {
			const result = await this.#conversations.compact(focused, { customInstructions: args.length === 0 ? null : args }, BACKGROUND_CONTEXT);
			this.#reportOperation(result);
			return;
		}
		const command = this.#selectedSlashCommands()
			?.list()
			.find((candidate) => candidate.name === name);
		try {
			if (command === undefined) {
				const catalog = this.#commands;
				const selected = catalog?.state.value?.commands.find(candidate => candidate.name === name);
				if (!catalog || !selected) throw new Error(`Unknown slash command: /${name}`);
				if (selected.source === "template" || selected.source === "skill") {
					const sessionId = this.#sessionId;
					const target = this.#focusedId();
					const expanded = await catalog.expand(name, args, BACKGROUND_CONTEXT);
					if (this.#closed || catalog !== this.#commands || sessionId !== this.#sessionId || target !== this.#focusedId()) throw new Error("Command target changed; retry in the current conversation.");
					if (!expanded.ok) throw new Error(expanded.problem);
					await this.#submitPrompt(expanded.prompt);
				} else {
					const result = await catalog.run(name, args, BACKGROUND_CONTEXT);
					this.#status = result.ok ? result.note : result.problem;
					this.#rebuild();
				}
				return;
			}
			const result = await command.run(args, BACKGROUND_CONTEXT);
			if (result !== undefined) {
				if ("note" in result) {
					this.#status = result.note;
					this.#rebuild();
				} else if ("entryId" in result) this.#reportQueue(result);
				else this.#reportOperation(result);
			}
		} catch (error) {
			if (this.#closed) return;
			this.#status = `Error: ${message(error)}`;
			this.#rebuild();
		}
	}

	async #configureModelScope(): Promise<void> {
		const epoch = ++this.#selectionEpoch;
		const models = this.#models;
		const sessionId = this.#sessionId;
		if (!models) return;
		const current = () => !this.#closed && this.#selectionEpoch === epoch && this.#models === models && this.#sessionId === sessionId;
		try {
			const config = await models.getModelScope(BACKGROUND_CONTEXT);
			if (!current()) return;
			const configure = (ids: string[] | null, persist: boolean) => {
				if (!current()) return Promise.reject(new Error("Model scope target changed. Open /scoped_models again."));
				return models.setModelScope(ids, persist, BACKGROUND_CONTEXT);
			};
			this.#modelScopeSelector = new ScopedModelsSelectorComponent({
				allModels: config.allModels,
				enabledModelIds: config.enabledModelIds === null ? null : [...config.enabledModelIds] }, {
				onChange: (ids) => configure(ids, false),
				onPersist: (ids) => configure(ids, true),
				onCancel: () => { this.#modelScopeSelector = undefined; this.#rebuild(); },
				requestRender: this.#requestRender });
			this.#rebuild();
		} catch (error) { if (current()) this.showError(message(error)); }
	}

	async #submitPrompt(prompt: string): Promise<void> {
		const request = { message: prompt, images: null };
		const view = this.#conversationView();
		const running = view !== undefined && liveOf(view).run !== undefined;
		this.#status = running ? "Queueing steering message…" : "Running turn…";
		this.#rebuild();
		const focused = this.#focusedId();
		const conversations = this.#conversations;
		if (focused !== undefined && conversations !== undefined) {
			if (running) this.#reportQueue(await conversations.steer(focused, request, BACKGROUND_CONTEXT));
			else this.#reportOperation(await conversations.prompt(focused, request, BACKGROUND_CONTEXT));
			return;
		}
		const controller = this.#selectedController();
		if (controller === undefined) throw new Error("No Session AgentController service is available");
		if (running) this.#reportQueue(await controller.steer(request, BACKGROUND_CONTEXT));
		else this.#reportOperation(await controller.prompt(request, BACKGROUND_CONTEXT));
	}

	async #queueFollowUp(text: string): Promise<void> {
		const request = { message: text, images: null };
		try {
			this.#status = "Queueing follow-up…";
			this.#rebuild();
			const focused = this.#focusedId();
			const conversations = this.#conversations;
			if (focused !== undefined && conversations !== undefined) {
				this.#reportQueue(await conversations.followUp(focused, request, BACKGROUND_CONTEXT));
				return;
			}
			const controller = this.#selectedController();
			if (controller === undefined) return;
			this.#reportQueue(await controller.followUp(request, BACKGROUND_CONTEXT));
		} catch (error) {
			this.#status = `Error: ${message(error)}`;
			this.#rebuild();
		}
	}

	#reportOperation(response: AgentOperationResponse): void {
		this.#status = response.accepted ? "" : `Operation rejected: ${response.error.message}`;
		this.#rebuild();
	}

	#reportQueue(response: AgentQueueResponse): void {
		this.#status = response.accepted ? `Queued ${response.entryId}.` : `Message rejected: ${response.error.message}`;
		this.#rebuild();
	}

	#interrupt(): void {
		const view = this.#conversationView();
		const focused = this.#focusedId();
		const conversations = this.#conversations;
		const controller = this.#selectedController();
		if (view === undefined || liveOf(view).run === undefined) return;
		const aborting =
			focused !== undefined && conversations !== undefined ? conversations.abort(focused, BACKGROUND_CONTEXT) : controller?.abort(BACKGROUND_CONTEXT);
		if (aborting === undefined) return;
		this.#status = "Aborting…";
		this.#rebuild();
		void aborting.then(
			() => {
				if (this.#status !== "Aborting…") return;
				this.#status = "";
				this.#rebuild();
			},
			(error: unknown) => {
				this.#status = `Error: ${message(error)}`;
				this.#rebuild();
			},
		);
	}

	#selectedController(): AgentController | undefined {
		return this.#controller;
	}

	/** The focused conversation when it is not the root. The root stays on `AgentController`. */
	#focusedId(): string | undefined {
		const state = this.#conversations?.state.value;
		if (state === undefined) return undefined;
		const root = state.conversations.find((entry) => entry.root)?.id;
		if (root === undefined || state.selected === root) return undefined;
		return state.selected;
	}

	#conversationView(): ConversationView | undefined {
		const conversations = this.#conversations?.state.value;
		const root = conversations?.conversations.find((entry) => entry.root)?.id;
		if (conversations !== undefined && root !== undefined && conversations.selected !== root && conversations.view !== null) {
			return conversations.view;
		}
		return this.#session?.transcript.state.value;
	}

	#withHistory(view: ConversationView): ConversationView {
		if (this.#history.length === 0) return view;
		return { ...view, entries: [...this.#history, ...view.entries] };
	}

	async #switchConversation(): Promise<void> {
		const conversations = this.#conversations;
		if (conversations === undefined) return;
		const listed = conversations.state.value;
		if (listed === undefined) return;
		const points = await conversations.returnPoints(listed.selected, BACKGROUND_CONTEXT);
		const value = await this.#select(
			"Switch conversation",
			[
				...listed.conversations.map((summary) => ({
					value: `focus:${summary.id}`,
					label: `${"  ".repeat(summary.depth)}${summary.label}`,
					description: summary.role })),
				...points.map((point) => ({
					value: `leave:${point.id}`,
					label: point.label,
					description: "return" })),
			],
			`focus:${listed.selected}`,
		);
		if (value === undefined) return;
		this.#history = [];
		this.#historyCursor = null;
		this.#historyLoaded = false;
		if (value.startsWith("leave:")) {
			await this.#leaveConversation(listed.selected, value.slice("leave:".length));
			return;
		}
		const id = value.startsWith("focus:") ? value.slice("focus:".length) : value;
		await conversations.select(id, BACKGROUND_CONTEXT);
	}

	/** Leave the shown conversation back to `at`. skipPrompt does not ask and does not summarize. */
	async #leaveConversation(conversationId: string, at: string): Promise<void> {
		const conversations = this.#conversations;
		if (conversations === undefined) return;
		const skip = conversations.state.value?.branchSummarySkipPrompt === true;
		let summarize = false;
		let customInstructions: string | null = null;
		if (!skip) {
			const choice = await this.#select("Summarize branch?", [
				{ value: "no", label: "No summary" },
				{ value: "yes", label: "Summarize" },
				{ value: "custom", label: "Summarize with custom prompt" },
			]);
			if (choice === undefined) {
				await this.#switchConversation();
				return;
			}
			summarize = choice !== "no";
			if (choice === "custom") {
				this.#pendingSummary = { conversationId, at };
				this.#status = "Custom summarization instructions. Submit a line, or submit empty for the default summary.";
				this.#rebuild();
				return;
			}
		}
		await this.#finishLeave(conversationId, at, summarize, customInstructions);
	}

	async #finishLeave(conversationId: string, at: string, summarize: boolean, customInstructions: string | null): Promise<void> {
		const conversations = this.#conversations;
		if (conversations === undefined) return;
		const result = await conversations.leave(conversationId, at, { summarize, customInstructions }, BACKGROUND_CONTEXT);
		if (result.cancelled) this.#status = "Branch summarization cancelled";
		else if (result.error !== null) this.#status = result.error.message;
		else this.#status = result.summarized ? "Left the branch with a summary." : "Left the branch.";
		this.#rebuild();
	}

	async #loadOlder(): Promise<void> {
		const conversations = this.#conversations;
		const target = conversations?.state.value?.selected;
		if (conversations === undefined || target === undefined) return;
		const shown = this.#conversationView();
		const before = this.#historyLoaded ? null : oldestPresentedEntryId(shown?.entries);
		const page = await conversations.older(target, before, this.#historyCursor, 20, BACKGROUND_CONTEXT);
		this.#historyLoaded = true;
		this.#history = [...page.entries, ...this.#history];
		this.#historyCursor = page.cursor ?? null;
		const view = this.#conversationView();
		if (view !== undefined) this.#chatView?.apply(this.#withHistory(view));
		this.#status = page.entries.length === 0 ? "Start of this conversation." : "";
		this.#rebuild();
	}

	#footer(): string {
		const view = this.#conversationView();
		const lane = this.#conversations?.state.value?.lane;
		if (lane !== undefined) {
			const count = view === undefined ? "" : ` · ${view.entries.length} entries`;
			return `${formatLane(lane)}${count}`;
		}
		return view === undefined ? "" : `${view.entries.length} entries`;
	}
}

export async function prepareClientSession(command: ClientCommand, servers: readonly ClientTuiServer[]): Promise<PreparedClientSession> {
	const opened = servers.map((server) => ({
		server,
		services: server.server.open({
			services: [SessionDirectory, SessionManagement, PresentationPlugins],
			assertAccess() {},
			onError() {} }) }));
	try {
		const features = opened.map(({ server, services }) => ({
			server,
			directory: services.get(SessionDirectory),
			management: services.get(SessionManagement),
			plugins: services.get(PresentationPlugins) }));
		await Promise.all(opened.map(({ services }) => services.ready(BACKGROUND_CONTEXT)));
		let selected:
			| {
					readonly server: ClientTuiServer;
					readonly management: SessionManagement;
					readonly plugins: PresentationPlugins;
					readonly summary: SessionSummary;
			  }
			| undefined;
		if (command.sessionId !== undefined) {
			const matches = features.flatMap((feature) =>
				(feature.directory.state.value?.sessions ?? [])
					.filter((session) => session.sessionId === command.sessionId)
					.map((summary) => ({
						server: feature.server,
						management: feature.management,
						plugins: feature.plugins,
						summary })),
			);
			if (matches.length > 1) throw new Error(`Session ${command.sessionId} is available from more than one server`);
			// --session-id is an exact open: a typo must not silently create an empty Session.
			if (matches[0] === undefined) throw new Error(`No Session ${command.sessionId} exists on the selected server`);
			selected = matches[0];
		} else if (command.newSessionId !== undefined) {
			const feature = requireSingleServer(features);
			selected = {
				server: feature.server,
				management: feature.management,
				plugins: feature.plugins,
				summary: await feature.management.create({ id: command.newSessionId }, BACKGROUND_CONTEXT) };
		} else if (command.continue === true || command.resume === true) {
			selected = features
				.flatMap((feature) =>
					(feature.directory.state.value?.sessions ?? []).filter(summary => summary.archivedAt === undefined).map((summary) => ({
						server: feature.server,
						management: feature.management,
						plugins: feature.plugins,
						summary })),
				)
				.sort(
					(left, right) =>
						right.summary.createdAt - left.summary.createdAt ||
						left.summary.serverId.localeCompare(right.summary.serverId) ||
						left.summary.sessionId.localeCompare(right.summary.sessionId),
				)[0];
		}
		if (selected === undefined) {
			const feature = requireSingleServer(features);
			selected = {
				server: feature.server,
				management: feature.management,
				plugins: feature.plugins,
				summary: await feature.management.create({}, BACKGROUND_CONTEXT) };
		}
		const presentationPlugins = await selected.plugins.prepareSession(
			{
				sessionId: selected.summary.sessionId,
				packagePaths: command.pluginPackages?.map((packagePath) => resolve(packagePath)) ?? null },
			BACKGROUND_CONTEXT,
		);
		await selected.management.attach(selected.summary.sessionId, BACKGROUND_CONTEXT);
		await selected.server.session.whenAttached(selected.summary.sessionId, BACKGROUND_CONTEXT);
		return {
			server: selected.server,
			summary: selected.summary,
			presentationPlugins };
	} finally {
		await Promise.allSettled(opened.map(({ services }) => services.dispose(BACKGROUND_CONTEXT)));
	}
}

export async function runClientTui(command: ClientCommand, options: RunClientTuiOptions = {}): Promise<void> {
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true });
	await resourceLoader.reload();
	setRegisteredThemes(resourceLoader.getThemes().themes);
	const runtime = await openClientRuntime(command, options);
	const tui = createInteractiveTui({
		tuiMode: "fullscreen",
		showHardwareCursor: settingsManager.getShowHardwareCursor(),
		logDirectory: agentDir,
		fullscreenWheelScrollLines: settingsManager.getFullscreenWheelScrollLines() });
	tui.setClearOnShrink(settingsManager.getClearOnShrink());
	let component: ExperimentalClientTui | undefined;
	let tuiStarted = false;
	const themeController = new InteractiveThemeController(tui, {
		getSettingsManager: () => settingsManager,
		showError: (error) => component?.showError(error),
		onChanged: () => component?.refreshTheme() });
	try {
		let finish!: () => void;
		const finished = new Promise<void>((resolve) => {
			finish = () => {
				themeController.disableAutoSync();
				if (tuiStarted) {
					tui.stop();
					tuiStarted = false;
				}
				resolve();
			};
		});
		component = await ExperimentalClientTui.create({
			command,
			ui: tui,
			servers: runtime.servers.map((server) => ({
				serverId: server.route.serverId,
				radius: server.route.transport === "radius",
				server: server.server,
				session: server.session })),
			facetLoader: options.facetLoader,
			requestRender: () => tui.requestRender(),
			finish });
		tui.addChild(component);
		tui.setLayoutRoot(component.layoutRoot);
		tui.setFocus(component);
		tuiStarted = true;
		tui.start();
		themeController.applyFromSettings();
		await finished;
	} finally {
		themeController.dispose();
		stopThemeWatcher();
		if (tuiStarted) tui.stop();
		await component?.close();
		await runtime.dispose();
	}
}

function requireSingleServer<T>(features: readonly T[]): T {
	if (features.length !== 1) throw new Error("Starting a Session requires exactly one server");
	return features[0]!;
}

function message(error: unknown): string {
	return sessionDatabaseErrorText(error) ?? (error instanceof Error ? error.message : String(error));
}
