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
	BOOT_GLOBAL,
	buildWebView,
	collectPageElements,
	createRenderer,
	failureView,
	followSystemTheme,
	isBusy,
	rosterItems,
	type PageElements,
	type PageRenderer,
	type WebBootManifest,
} from "@amazme/web";
import { AgentController } from "../services/agent-controller.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type SessionServiceSource,
} from "../services/connection.ts";
import { Models, type ModelsState } from "../services/models.ts";
import { SessionDirectory, SessionManagement } from "../services/sessions.ts";
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
			services: [Transcript, AgentController, Models],
			assertAccess(): void {},
			onError: (error: Error) => this.#renderer.setConnection(`stream error: ${message(error)}`, "error"),
		});
		await services.ready(BACKGROUND_CONTEXT);
		const transcript = services.use(Transcript);
		this.#services = services;
		this.#transcript = transcript.state;
		this.#controller = services.use(AgentController);
		this.#models = services.use(Models);
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
		services: [SessionDirectory, SessionManagement],
		assertAccess(): void {},
		onError: report,
	});
	const directory = serverServices.use(SessionDirectory);
	const management = serverServices.use(SessionManagement);
	const paint = (): void =>
		renderer.render(
			buildWebView({
				directory: directory.state.value,
				transcript: painter.transcriptValue,
				attachedId: painter.sessionId,
				now: Date.now(),
				models: painter.modelsValue,
				thinkingLevels: painter.levels,
			}),
		);
	directory.state.subscribe(() => paint());

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
