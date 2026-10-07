/// <reference lib="dom" />
/**
 * Page entry: read the host's boot manifest, dial the loopback byte transport, bind the host's
 * replicated services, and paint them. The page contract, view model, and DOM renderer come from
 * `@amazme/web`; this module owns the client lifecycle, session attachment, and the visible
 * failure states.
 */
import type { ModelThinkingLevel } from "@amazme/ai";
import { Client, type ClientOptions } from "@amazme/client";
import { createWebSocketTransportFactory } from "@amazme/client/websocket";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { ReplicatedState } from "@amazme/chord";
import type { ConversationView } from "@amazme/durable";
import {
	addMcpServerModal,
	addPackageModal,
	applyTheme,
	ATTACHMENT_REMOVE_ACTION,
	attachmentRejection,
	BOOT_GLOBAL,
	COMPACT_ACTION,
	COMPACT_MODAL,
	commandPalette,
	compactModal,
	expandSkillCommand,
	buildWebView,
	CHAT_VIEW,
	collectPageElements,
	composeSkill,
	createRenderer,
	DOCK_TAB_ACTION,
	DOCK_TOGGLE_ACTION,
	documentLanguage,
	failureView,
	FALLBACK_LOCALE,
	followSystemTheme,
	importSkillModal,
	isBusy,
	newSkillModal,
	PLUGIN_MCP_ADD_ACTION,
	PLUGIN_MCP_ENABLED_ACTION,
	PLUGIN_MCP_EXPOSURE_ACTION,
	PLUGIN_MCP_MODAL,
	PLUGIN_MCP_REMOVE_ACTION,
	PLUGIN_PACKAGE_ADD_ACTION,
	PLUGIN_PACKAGE_MODAL,
	PLUGIN_PACKAGE_REMOVE_ACTION,
	QUEUE_CANCEL_ACTION,
	REFRESH_MODELS_ACTION,
	panelNav,
	parseCommandLine,
	removeSessionModal,
	removeSkillModal,
	resolveLocale,
	resolveThemePreference,
	rosterItems,
	SETTINGS_FIELD_ACTION,
	SETTINGS_RELOAD_ACTION,
	SKILL_CREATE_MODAL,
	SKILL_EDIT_ACTION,
	SKILL_EDIT_MODAL,
	SKILL_IMPORT_ACTION,
	SKILL_IMPORT_MODAL,
	SKILL_NEW_ACTION,
	SKILL_REMOVE_ACTION,
	SESSION_REMOVE_ACTION,
	skillCommands,
	TERMINAL_RUN_ACTION,
	TERMINAL_STOP_ACTION,
	WORKSPACE_OPEN_ACTION,
	WORKSPACE_READ_ACTION,
	WORKSPACE_RELOAD_ACTION,
	SESSION_REMOVE_MODAL,
	SKILL_REMOVE_MODAL,
	skillModal,
	SUBMIT_MODE_ACTION,
	translate,
	type Locale,
	type MessageKey,
	type PageElements,
	type PageRenderer,
	type ShortcutId,
	type SubmitMode,
	type PanelAction,
	type PanelModal,
	type ThemePreference,
	type WebBootManifest,
} from "@amazme/web";
import { AgentController, type AgentPromptImage } from "../services/agent-controller.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type SessionServiceSource,
} from "../services/connection.ts";
import { Commands, type Commands as CommandsService, type CommandsState } from "../services/commands.ts";
import { Terminal, type Terminal as TerminalService, type TerminalState } from "../services/terminal.ts";
import { Workspace, type Workspace as WorkspaceService, type WorkspaceState } from "../services/workspace.ts";
import { Models, type ModelsState } from "../services/models.ts";
import { Plugins } from "../services/plugins.ts";
import { SessionDirectory, SessionManagement } from "../services/sessions.ts";
import { SessionSettings, Settings } from "../services/settings.ts";
import { Skills } from "../services/skills.ts";
import { Transcript } from "../services/transcript.ts";

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
	#sessionSettings: SessionSettings | undefined;
	#commands: CommandsService | undefined;
	#workspace: WorkspaceService | undefined;
	#terminal: TerminalService | undefined;
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

	get transcriptValue(): ConversationView | undefined {
		return this.#transcript?.value;
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
			this.#renderer.setConnection(translate(this.locale, "dock.terminalFailed", { error: result.problem }), "error");
		}
	}

	async stopTerminal(): Promise<void> {
		await this.#terminal?.stop(BACKGROUND_CONTEXT);
	}

	/** The session's command catalogue, as the host published it. */
	get commands(): CommandsState["commands"] {
		return this.#commands?.state.value?.commands ?? [];
	}

	/** Run one of the host's commands; the result carries the note or the problem to show. */
	async runCommand(name: string, args: string): Promise<{ readonly ok: boolean; readonly message: string }> {
		const commands = this.#commands;
		if (commands === undefined) return { ok: false, message: translate(this.locale, "page.commandUnknown", { name }) };
		const result = await commands.run(name, args, BACKGROUND_CONTEXT);
		return result.ok ? { ok: true, message: result.note } : { ok: false, message: result.problem };
	}

	/** The host's completions for one command's argument. */
	async complete(name: string, prefix: string): Promise<readonly { value: string; label: string; description?: string }[]> {
		return (await this.#commands?.complete(name, prefix, BACKGROUND_CONTEXT)) ?? [];
	}

	/**
	 * Send input to the attached session: an image prompt, a new run when idle, or — while a turn
	 * runs — the mode the composer asks for, so a mid-turn message is a steer or a queued follow-up.
	 */
	async submit(text: string, mode: SubmitMode, images: readonly AgentPromptImage[] = []): Promise<void> {
		const controller = this.#controller;
		if (controller === undefined) return;
		const request = { message: text, images: images.length === 0 ? null : [...images] };
		const response = !isBusy(this.transcriptValue)
			? await controller.prompt(request, BACKGROUND_CONTEXT)
			: mode === "steer"
				? await controller.steer(request, BACKGROUND_CONTEXT)
				: await controller.followUp(request, BACKGROUND_CONTEXT);
		// A rejection must be visible; an accepted prompt shows itself in the transcript.
		if (!response.accepted) {
			this.#renderer.setConnection(
				translate(this.locale, "page.promptRejected", { error: response.error.message }),
				"error",
			);
		}
	}

	/** Withdraw queued input and abort the running turn and compaction. */
	async abort(): Promise<void> {
		await this.#controller?.abort(BACKGROUND_CONTEXT);
	}

	/** Withdraw one queued input by its inbox submission id; the rest stay queued. */
	async cancelQueued(entryId: string): Promise<void> {
		const outcome = await this.#controller?.cancelQueued(entryId, BACKGROUND_CONTEXT);
		if (outcome !== undefined && outcome.outcome !== "cancelled") {
			this.#renderer.setConnection(translate(this.locale, "page.queueGone"), "error");
		}
	}

	/** Summarize the conversation so far; an empty instruction asks the host for its own summary. */
	async compact(instructions: string): Promise<void> {
		const trimmed = instructions.trim();
		const response = await this.#controller?.compact(
			{ customInstructions: trimmed.length === 0 ? null : trimmed },
			BACKGROUND_CONTEXT,
		);
		if (response !== undefined && !response.accepted) {
			this.#renderer.setConnection(
				translate(this.locale, "page.compactFailed", { error: response.error.message }),
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
		const model =
			configuration === undefined || configuration === null
				? ""
				: `${configuration.provider}/${configuration.modelId}`;
		if (service === undefined || model === this.#levelsModel) return;
		this.#levelsModel = model;
		this.#levels = await service.getThinkingLevels(BACKGROUND_CONTEXT);
		paint();
	}

	async attach(sessionId: string, paint: () => void): Promise<void> {
		if (this.#sessionId === sessionId) return;
		await this.detach();
		this.#sessionId = sessionId;
		const attached = this.#sessionSource.attachment.value;
		if (attached === undefined || attached.status === "detached" || attached.sessionId !== sessionId) {
			throw new Error(`Host did not attach session ${sessionId}`);
		}
		const services = this.#sessionSource.open({
			services: [Transcript, AgentController, Models, SessionSettings, Commands, Workspace, Terminal],
			assertAccess(): void {},
			onError: (error: Error) =>
				this.#renderer.setConnection(
					translate(this.locale, "page.streamFailed", { error: message(error) }),
					"error",
				),
		});
		await services.ready(BACKGROUND_CONTEXT);
		const transcript = services.use(Transcript);
		this.#services = services;
		this.#transcript = transcript.state;
		this.#controller = services.use(AgentController);
		this.#models = services.use(Models);
		this.#sessionSettings = services.use(SessionSettings);
		this.#commands = services.use(Commands);
		this.#workspace = services.use(Workspace);
		this.#terminal = services.use(Terminal);
		// A listing, a file, or terminal output lands here; the page repaints the dock from it.
		this.#workspace.state.subscribe(() => paint());
		this.#terminal.state.subscribe(() => paint());
		this.#levels = undefined;
		this.#levelsModel = undefined;
		// A model switch made anywhere repaints the chip and re-reads the levels of the new model.
		this.#models.state.subscribe(() => {
			paint();
			void this.#refreshLevels(paint).catch((error: unknown) => {
				this.#renderer.setConnection(
					translate(this.locale, "page.modelStateFailed", { error: message(error) }),
					"error",
				);
			});
		});
		transcript.state.subscribe(() => paint());
		await this.#refreshLevels(paint);
		paint();
	}

	async detach(): Promise<void> {
		await this.#services?.dispose(BACKGROUND_CONTEXT);
		this.#services = undefined;
		this.#transcript = undefined;
		this.#controller = undefined;
		this.#models = undefined;
		this.#sessionSettings = undefined;
		this.#commands = undefined;
		this.#workspace = undefined;
		this.#terminal = undefined;
		this.#levels = undefined;
		this.#levelsModel = undefined;
		this.#sessionId = undefined;
	}
}

export async function startPage(renderer: PageRenderer): Promise<Client | undefined> {
	const manifest = readManifest();
	if (manifest === undefined) {
		fail(renderer, new Error(translate(FALLBACK_LOCALE, "page.noManifest")), FALLBACK_LOCALE);
		return undefined;
	}
	document.title = `${manifest.app.name} ${manifest.app.version}`;
	const client = new Client({
		serverId: manifest.server.id,
		transportFactory: createWebSocketTransportFactory({ url: manifest.transport.url }),
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
		services: [SessionDirectory, SessionManagement, Settings, Skills, Plugins],
		assertAccess(): void {},
		onError: report,
	});
	const directory = serverServices.use(SessionDirectory);
	const management = serverServices.use(SessionManagement);
	/** The management surface's own services, and the view the main area shows. */
	const settings = serverServices.use(Settings);
	const skills = serverServices.use(Skills);
	const plugins = serverServices.use(Plugins);
	let view = CHAT_VIEW;
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
	/** The composer's draft, mirrored here so the command palette can be projected from it. */
	let draft = "";
	/** The host's argument completions for the command line being typed. */
	let completions: readonly { readonly value: string; readonly label: string; readonly description?: string }[] = [];
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
	 * The commands the composer offers: the session's own catalogue, and — when the agent registers
	 * skills as commands — one `/skill:<name>` per loaded skill.
	 */
	const composerCommands = (): readonly { name: string; description: string; argumentHint?: string }[] => {
		const host = painter.commands.map((command) => ({
			name: command.name,
			description: command.description,
			...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
		}));
		const skillsEnabled = settingValue("enableSkillCommands") !== "false";
		if (!skillsEnabled) return host;
		return [...host, ...skillCommands(skills.state.value?.skills ?? [])];
	};

	/** The catalogue's value for one field, once the host has published it. */
	const settingValue = (id: string): string | undefined =>
		settings.state.value?.descriptors.find((descriptor) => descriptor.id === id)?.value;
	/**
	 * A switch made in the panel reaches this page through the replicated settings: the resolved
	 * language and palette follow the host's value, so both tabs agree without a reload.
	 */
	const paint = (): void => {
		locale = resolveLocale(settingValue("locale") ?? manifest.preferences?.locale, navigator.languages);
		appearance = resolveThemePreference(settingValue("appearance") ?? manifest.preferences?.appearance);
		painter.locale = locale;
		applyTheme(appearance);
		document.documentElement.lang = documentLanguage(locale);
		paintSafely(() =>
			renderer.render(
				buildWebView({
					locale,
					directory: directory.state.value,
					transcript: painter.transcriptValue,
					attachedId: painter.sessionId,
					now: Date.now(),
					models: painter.modelsValue,
					thinkingLevels: painter.levels,
					submitMode,
					attachments: pending,
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
					},
					// The panel inherits this view's language, so one resolution serves the whole page.
					panel: {
						locale,
						current: view,
						...(modal === undefined ? {} : { modal }),
						settings: { state: settings.state.value },
						skills: { state: skills.state.value },
						plugins: { state: plugins.state.value },
					},
				}),
			),
		);
	};
	directory.state.subscribe(() => paint());
	settings.state.subscribe(() => paint());
	skills.state.subscribe(() => paint());
	plugins.state.subscribe(() => paint());

	/**
	 * Attach another session. The painter lets go of the previous one first: the host has already
	 * moved this connection's attachment by the time the new services bind, so a send in that window
	 * would reach a session this client no longer has. The composer is inert until the new one lands.
	 */
	const selectSession = async (sessionId: string): Promise<void> => {
		if (painter.sessionId === sessionId) return;
		await painter.detach();
		paint();
		await retryOnRebind(async () => {
			await management.attach(sessionId, BACKGROUND_CONTEXT);
			await sessionSource.whenAttached(sessionId, BACKGROUND_CONTEXT);
			await painter.attach(sessionId, paint);
		});
	};
	renderer.onSelect = (sessionId) => {
		void selectSession(sessionId).catch((error: unknown) => {
			renderer.setConnection(copy("page.attachFailed", { error: message(error) }), "error");
		});
	};
	// The host creates the session; the roster shows it from the replicated directory. A second
	// click while the first create is in flight would make a second session, so this one is one-shot.
	let creating = false;
	/** Create a session and attach it; one path serves the sidebar's bar and the shortcut. */
	const createSession = (): void => {
		if (creating) return;
		creating = true;
		void management
			.create({}, BACKGROUND_CONTEXT)
			.then((created) => selectSession(created.sessionId))
			.catch((error: unknown) => {
				renderer.setConnection(copy("page.newSessionFailed", { error: message(error) }), "error");
			})
			.finally(() => {
				creating = false;
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
		const views = [CHAT_VIEW, ...panelNav(locale, CHAT_VIEW).map((item) => item.id)];
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
		void (async () => {
			const added: PendingImage[] = [];
			for (const file of files) {
				const rejection = attachmentRejection({ mediaType: file.type, bytes: file.size });
				if (rejection !== undefined) {
					renderer.setConnection(
						copy(rejection, { name: file.name, limit: copy("composer.attachmentLimit") }),
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
			pending = [...pending, ...added];
			paint();
		})();
	};
	/**
	 * Run one command line. A skill command expands here, the way the CLI expands it, and becomes a
	 * prompt; anything else is the host's to run, and its note or problem reaches the connection line.
	 */
	const runCommandLine = (name: string, args: string): void => {
		if (name.startsWith("skill:")) {
			const skillName = name.slice("skill:".length);
			const summary = skills.state.value?.skills.find((skill) => skill.name === skillName);
			if (summary === undefined) {
				renderer.setConnection(copy("page.commandUnknown", { name }), "error");
				return;
			}
			void skills.read(skillName, BACKGROUND_CONTEXT).then(
				(content) => {
					// The skill becomes a prompt, so the model sees the same block the CLI sends.
					const expanded = expandSkillCommand({ name: summary.name, filePath: summary.filePath, content }, args);
					return painter.submit(expanded, submitMode, []);
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

	renderer.onSubmit = (text) => {
		const line = parseCommandLine(text);
		if (line !== undefined && composerCommands().some((command) => command.name === line.name)) {
			renderer.setDraft("");
			runCommandLine(line.name, line.args);
			return;
		}
		const sent = pending;
		const images: AgentPromptImage[] = sent.map((image) => ({
			type: "image",
			data: image.data,
			mimeType: image.mediaType,
		}));
		pending = [];
		void painter.submit(text, submitMode, images).catch((error: unknown) => {
			// The prompt never reached the session, so the images stay attached for another try.
			pending = sent;
			paint();
			renderer.setConnection(copy("page.sendFailed", { error: message(error) }), "error");
		});
	};
	renderer.onAbort = () => {
		void painter.abort().catch((error: unknown) => {
			renderer.setConnection(copy("page.abortFailed", { error: message(error) }), "error");
		});
	};

	/** Report a failed management call; the panel keeps its state and the reader keeps their text. */
	const failPanel = (error: unknown): void =>
		renderer.setConnection(copy("page.panelFailed", { error: message(error) }), "error");

	/** Run one host call from the management surface, closing the modal once it succeeded. */
	const settle = (operation: Promise<void> | undefined, closeModal = true): void => {
		if (operation === undefined) return;
		void operation.then(
			() => {
				if (closeModal) modal = undefined;
				paint();
			},
			(error: unknown) => {
				failPanel(error);
				paint();
			},
		);
	};

	const pluginPackages = (): readonly string[] => plugins.state.value?.packages ?? [];
	const skillOf = (name: string): { readonly editable: boolean } | undefined =>
		skills.state.value?.skills.find((candidate) => candidate.name === name);

	renderer.onPanelAction = (action: PanelAction): void => {
		switch (action.kind) {
			case "open":
				// The row of the view already open returns to the conversation.
				view = action.panel === view ? CHAT_VIEW : action.panel;
				modal = undefined;
				paint();
				return;
			case "modal-close":
				modal = undefined;
				paint();
				return;
			case "control":
				if (action.id === SETTINGS_FIELD_ACTION && action.data !== undefined) {
					const id = action.data;
					// A running session holds the settings it loaded, so ask it to re-read them.
					settle(
						settings
							.set(id, action.value, BACKGROUND_CONTEXT)
							.then(() => painter.reloadSettings())
							.catch((error: unknown) => {
								// A session that is already gone is not a settings failure.
								failPanel(error);
							}),
						false,
					);
					return;
				}
				if (action.id === PLUGIN_MCP_ENABLED_ACTION && action.data !== undefined) {
					const name = action.data;
					settle(plugins.setMcpServer(name, { enabled: action.value === "true" }, BACKGROUND_CONTEXT), false);
					return;
				}
				if (action.id === PLUGIN_MCP_EXPOSURE_ACTION && action.data !== undefined) {
					const name = action.data;
					settle(plugins.setMcpServer(name, { exposure: action.value }, BACKGROUND_CONTEXT), false);
				}
				return;
			case "command":
				switch (action.id) {
					case COMPACT_ACTION:
						modal = compactModal(locale);
						paint();
						return;
					case REFRESH_MODELS_ACTION:
						settle(painter.refreshModels(), false);
						return;
					case SUBMIT_MODE_ACTION:
						submitMode = action.data === "steer" ? "steer" : "followUp";
						paint();
						return;
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
						settle(painter.workspaceOpen(view !== undefined && view.kind === "text" ? view.path : (view?.path ?? ".")), false);
						return;
					}
					case WORKSPACE_OPEN_ACTION:
						settle(painter.workspaceOpen(action.data ?? "."), false);
						return;
					case WORKSPACE_READ_ACTION:
						settle(painter.workspaceRead(action.data ?? ""), false);
						return;
					case TERMINAL_RUN_ACTION:
						settle(painter.runTerminal(action.data ?? ""), false);
						return;
					case TERMINAL_STOP_ACTION:
						settle(painter.stopTerminal(), false);
						return;
					case SESSION_REMOVE_ACTION:
						modal = removeSessionModal(locale, action.data ?? "");
						paint();
						return;
					case ATTACHMENT_REMOVE_ACTION: {
						pending = pending.filter((image) => image.id !== action.data);
						paint();
						return;
					}
					case QUEUE_CANCEL_ACTION: {
						const entryId = action.data ?? "";
						settle(painter.cancelQueued(entryId), false);
						return;
					}
					case SETTINGS_RELOAD_ACTION:
						settle(settings.reload(BACKGROUND_CONTEXT), false);
						return;
					case SKILL_NEW_ACTION:
						modal = newSkillModal(locale);
						paint();
						return;
					case SKILL_IMPORT_ACTION:
						modal = importSkillModal(locale);
						paint();
						return;
					case SKILL_REMOVE_ACTION:
						modal = removeSkillModal(locale, action.data ?? "");
						paint();
						return;
					case SKILL_EDIT_ACTION: {
						const name = action.data ?? "";
						settle(
							skills.read(name, BACKGROUND_CONTEXT).then((content) => {
								modal = skillModal(locale, name, content, skillOf(name)?.editable === true);
							}),
							false,
						);
						return;
					}
					case PLUGIN_PACKAGE_ADD_ACTION:
						modal = addPackageModal(locale);
						paint();
						return;
					case PLUGIN_PACKAGE_REMOVE_ACTION: {
						const path = action.data ?? "";
						settle(
							plugins.setPackages(
								pluginPackages().filter((candidate) => candidate !== path),
								BACKGROUND_CONTEXT,
							),
							false,
						);
						return;
					}
					case PLUGIN_MCP_ADD_ACTION:
						modal = addMcpServerModal(locale);
						paint();
						return;
					case PLUGIN_MCP_REMOVE_ACTION: {
						const name = action.data ?? "";
						settle(plugins.removeMcpServer(name, BACKGROUND_CONTEXT), false);
						return;
					}
					default:
						return;
				}
			case "modal-submit": {
				const fields = action.fields;
				switch (action.id) {
					case SESSION_REMOVE_MODAL: {
						const sessionId = action.data ?? "";
						// A session that was just attached is detached before its storage goes away.
						if (painter.sessionId === sessionId) {
							void painter.detach().then(() => paint(), () => paint());
						}
						settle(
							management.remove(sessionId, BACKGROUND_CONTEXT).catch((error: unknown) => {
								renderer.setConnection(copy("page.removeFailed", { error: message(error) }), "error");
							}),
						);
						return;
					}
					case COMPACT_MODAL:
						settle(painter.compact(fields.instructions ?? ""));
						return;
					case SKILL_CREATE_MODAL: {
						const name = (fields.name ?? "").trim();
						if (name.length === 0) {
							failPanel(new Error(copy("page.skillNeedsName")));
							return;
						}
						settle(
							skills.write(
								{ name, content: composeSkill(name, fields.description ?? "", fields.body ?? "") },
								BACKGROUND_CONTEXT,
							),
						);
						return;
					}
					case SKILL_EDIT_MODAL:
						settle(skills.write({ name: action.data ?? "", content: fields.content ?? "" }, BACKGROUND_CONTEXT));
						return;
					case SKILL_REMOVE_MODAL:
						settle(skills.remove(action.data ?? "", BACKGROUND_CONTEXT));
						return;
					case SKILL_IMPORT_MODAL:
						settle(skills.importSkill(fields.path ?? "", BACKGROUND_CONTEXT));
						return;
					case PLUGIN_PACKAGE_MODAL: {
						const path = (fields.path ?? "").trim();
						if (path.length === 0) {
							failPanel(new Error(copy("page.packageNeedsPath")));
							return;
						}
						settle(plugins.setPackages([...pluginPackages(), path], BACKGROUND_CONTEXT));
						return;
					}
					case PLUGIN_MCP_MODAL:
						settle(plugins.addMcpServer((fields.name ?? "").trim(), fields.entry ?? "", BACKGROUND_CONTEXT));
						return;
					default:
						// A read-only view submits to close, which is what removing the modal does.
						modal = undefined;
						paint();
						return;
				}
			}
		}
	};

	client.onConnectionStateChange((change) => {
		if (change.state === "connected") {
			renderer.setConnection(copy("connection.connected", { id: manifest.server.id }), "state");
			return;
		}
		if (change.state === "disconnected") {
			renderer.setConnection(
				copy("connection.disconnected", {
					error: change.error?.message ?? copy("connection.hostGone"),
				}),
				"error",
			);
			return;
		}
		// Any other state the client reports is its own word for an unfinished connection.
		renderer.setConnection(copy("connection.connecting"), "state");
	});
	try {
		await client.connect();
	} catch (error) {
		fail(renderer, error, locale);
		await client.dispose();
		return undefined;
	}
	await serverServices.ready(BACKGROUND_CONTEXT);
	// Attach the session the sidebar lists first: the page's own ordering, not the host's array order.
	const newest = rosterItems(locale, directory.state.value, undefined, Date.now())[0];
	if (newest !== undefined) {
		await selectSession(newest.id).catch((error: unknown) => {
			renderer.setConnection(copy("page.attachFailed", { error: message(error) }), "error");
		});
	}
	paint();

	globalThis.addEventListener("pagehide", () => {
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
		renderer = createRenderer(elements);
	} catch (error) {
		document.body.textContent = translate(locale, "page.cannotBoot", { error: message(error) });
		return;
	}
	if (manifest !== undefined) elements.mode.textContent = `${manifest.mode} · ${manifest.transport.url}`;
	try {
		await startPage(renderer);
	} catch (error) {
		fail(renderer, error, locale);
	}
}

void main();
