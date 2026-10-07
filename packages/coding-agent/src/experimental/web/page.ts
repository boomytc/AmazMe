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
	BOOT_GLOBAL,
	buildWebView,
	CHAT_VIEW,
	collectPageElements,
	composeSkill,
	createRenderer,
	failureView,
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
	removeSkillModal,
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
	SKILL_REMOVE_MODAL,
	skillModal,
	type PageElements,
	type PageRenderer,
	type PanelAction,
	type PanelModal,
	type WebBootManifest,
} from "@amazme/web";
import { AgentController } from "../services/agent-controller.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type SessionServiceSource,
} from "../services/connection.ts";
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

/** Attach one session and keep its transcript subscribed until the attachment changes. */
class SessionPainter {
	readonly #sessionSource: SessionServiceSource;
	readonly #renderer: PageRenderer;
	#transcript: ReplicatedState<ConversationView> | undefined;
	#controller: AgentController | undefined;
	#models: Models | undefined;
	#sessionSettings: SessionSettings | undefined;
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

	/** Send input to the attached session: a new run when idle, queued input while one runs. */
	async submit(text: string): Promise<void> {
		const controller = this.#controller;
		if (controller === undefined) return;
		const request = { message: text, images: null };
		const response = isBusy(this.transcriptValue)
			? await controller.followUp(request, BACKGROUND_CONTEXT)
			: await controller.prompt(request, BACKGROUND_CONTEXT);
		// A rejection must be visible; an accepted prompt shows itself in the transcript.
		if (!response.accepted) this.#renderer.setConnection(`prompt rejected: ${response.error.message}`, "error");
	}

	/** Withdraw queued input and abort the running turn and compaction. */
	async abort(): Promise<void> {
		await this.#controller?.abort(BACKGROUND_CONTEXT);
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
			services: [Transcript, AgentController, Models, SessionSettings],
			assertAccess(): void {},
			onError: (error: Error) => this.#renderer.setConnection(`stream error: ${message(error)}`, "error"),
		});
		await services.ready(BACKGROUND_CONTEXT);
		const transcript = services.use(Transcript);
		this.#services = services;
		this.#transcript = transcript.state;
		this.#controller = services.use(AgentController);
		this.#models = services.use(Models);
		this.#sessionSettings = services.use(SessionSettings);
		this.#levels = undefined;
		this.#levelsModel = undefined;
		// A model switch made anywhere repaints the chip and re-reads the levels of the new model.
		this.#models.state.subscribe(() => {
			paint();
			void this.#refreshLevels(paint).catch((error: unknown) => {
				this.#renderer.setConnection(`model state failed: ${message(error)}`, "error");
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
		this.#levels = undefined;
		this.#levelsModel = undefined;
		this.#sessionId = undefined;
	}
}

export async function startPage(renderer: PageRenderer): Promise<Client | undefined> {
	const manifest = readManifest();
	if (manifest === undefined) {
		fail(renderer, new Error("the host served this document without its boot manifest"));
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
	const paint = (): void =>
		renderer.render(
			buildWebView({
				directory: directory.state.value,
				transcript: painter.transcriptValue,
				attachedId: painter.sessionId,
				now: Date.now(),
				models: painter.modelsValue,
				thinkingLevels: painter.levels,
				panel: {
					current: view,
					...(modal === undefined ? {} : { modal }),
					settings: { state: settings.state.value },
					skills: { state: skills.state.value },
					plugins: { state: plugins.state.value },
				},
			}),
		);
	directory.state.subscribe(() => paint());
	settings.state.subscribe(() => paint());
	skills.state.subscribe(() => paint());
	plugins.state.subscribe(() => paint());

	const selectSession = async (sessionId: string): Promise<void> => {
		await management.attach(sessionId, BACKGROUND_CONTEXT);
		await sessionSource.whenAttached(sessionId, BACKGROUND_CONTEXT);
		await painter.attach(sessionId, paint);
	};
	renderer.onSelect = (sessionId) => {
		void selectSession(sessionId).catch((error: unknown) => {
			renderer.setConnection(`attach failed: ${message(error)}`, "error");
		});
	};
	// The host creates the session; the roster shows it from the replicated directory. A second
	// click while the first create is in flight would make a second session, so this one is one-shot.
	let creating = false;
	renderer.onCreateSession = () => {
		if (creating) return;
		creating = true;
		void management
			.create({}, BACKGROUND_CONTEXT)
			.then((created) => selectSession(created.sessionId))
			.catch((error: unknown) => {
				renderer.setConnection(`new session failed: ${message(error)}`, "error");
			})
			.finally(() => {
				creating = false;
			});
	};
	renderer.onSelectModel = (provider, modelId) => {
		void painter.selectModel(provider, modelId).catch((error: unknown) => {
			renderer.setConnection(`model change failed: ${message(error)}`, "error");
		});
	};
	renderer.onSelectThinking = (level) => {
		void painter.selectThinking(level).catch((error: unknown) => {
			renderer.setConnection(`thinking level failed: ${message(error)}`, "error");
		});
	};
	renderer.onSubmit = (text) => {
		void painter.submit(text).catch((error: unknown) => {
			renderer.setConnection(`send failed: ${message(error)}`, "error");
		});
	};
	renderer.onAbort = () => {
		void painter.abort().catch((error: unknown) => {
			renderer.setConnection(`abort failed: ${message(error)}`, "error");
		});
	};

	/** Report a failed management call; the panel keeps its state and the reader keeps their text. */
	const failPanel = (error: unknown): void =>
		renderer.setConnection(`panel action failed: ${message(error)}`, "error");

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
					case SETTINGS_RELOAD_ACTION:
						settle(settings.reload(BACKGROUND_CONTEXT), false);
						return;
					case SKILL_NEW_ACTION:
						modal = newSkillModal();
						paint();
						return;
					case SKILL_IMPORT_ACTION:
						modal = importSkillModal();
						paint();
						return;
					case SKILL_REMOVE_ACTION:
						modal = removeSkillModal(action.data ?? "");
						paint();
						return;
					case SKILL_EDIT_ACTION: {
						const name = action.data ?? "";
						settle(
							skills.read(name, BACKGROUND_CONTEXT).then((content) => {
								modal = skillModal(name, content, skillOf(name)?.editable === true);
							}),
							false,
						);
						return;
					}
					case PLUGIN_PACKAGE_ADD_ACTION:
						modal = addPackageModal();
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
						modal = addMcpServerModal();
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
					case SKILL_CREATE_MODAL: {
						const name = (fields.name ?? "").trim();
						if (name.length === 0) {
							failPanel(new Error("a skill needs a name"));
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
							failPanel(new Error("a plugin package needs a path"));
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
			renderer.setConnection(`connected · ${manifest.server.id}`, "state");
			return;
		}
		if (change.state === "disconnected") {
			renderer.setConnection(`disconnected: ${change.error?.message ?? "host went away"}`, "error");
			return;
		}
		renderer.setConnection(change.state, "state");
	});
	try {
		await client.connect();
	} catch (error) {
		fail(renderer, error);
		await client.dispose();
		return undefined;
	}
	await serverServices.ready(BACKGROUND_CONTEXT);
	// Attach the session the sidebar lists first: the page's own ordering, not the host's array order.
	const newest = rosterItems(directory.state.value, undefined, Date.now())[0];
	if (newest !== undefined) {
		await selectSession(newest.id).catch((error: unknown) => {
			renderer.setConnection(`attach failed: ${message(error)}`, "error");
		});
	}
	paint();

	globalThis.addEventListener("pagehide", () => {
		void painter.detach();
		void serverServices.dispose(BACKGROUND_CONTEXT).then(() => client.dispose());
	});
	return client;
}

function fail(renderer: PageRenderer, error: unknown): void {
	const text = `cannot boot: ${message(error)}`;
	renderer.setConnection(text, "error");
	renderer.render(failureView(text));
}

/** Entry point referenced by the served document. */
export async function main(): Promise<void> {
	let elements: PageElements;
	let renderer: PageRenderer;
	try {
		followSystemTheme();
		elements = collectPageElements();
		renderer = createRenderer(elements);
	} catch (error) {
		document.body.textContent = `cannot boot: ${message(error)}`;
		return;
	}
	const manifest = readManifest();
	if (manifest !== undefined) elements.mode.textContent = `${manifest.mode} · ${manifest.transport.url}`;
	try {
		await startPage(renderer);
	} catch (error) {
		fail(renderer, error);
	}
}

void main();
