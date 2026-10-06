/// <reference lib="dom" />
/**
 * Page entry: read the host's boot manifest, dial the loopback byte transport, bind the host's
 * replicated services, and paint them. The view model and DOM renderer live next to this file;
 * this module owns the client lifecycle, session attachment, and the visible failure states.
 */
import { Client, type ClientOptions } from "@amazme/client";
import { createWebSocketTransportFactory } from "@amazme/client/websocket";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { ReplicatedState } from "@amazme/chord";
import type { ConversationView } from "@amazme/durable";
import { BOOT_GLOBAL, type WebBootManifest } from "../contract.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type SessionServiceSource,
} from "../../services/connection.ts";
import { AgentController } from "../../services/agent-controller.ts";
import { SessionDirectory, SessionManagement } from "../../services/sessions.ts";
import { Transcript } from "../../services/transcript.ts";
import { buildWebView, failureView, isBusy } from "../view.ts";
import { collectPageElements, createRenderer, type PageRenderer } from "./render.ts";

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

	/** Send input to the attached session: a new run when idle, queued input while one runs. */
	async submit(text: string): Promise<void> {
		const controller = this.#controller;
		if (controller === undefined) return;
		const request = { message: text, images: null };
		const response = isBusy(this.transcriptValue)
			? await controller.followUp(request, BACKGROUND_CONTEXT)
			: await controller.prompt(request, BACKGROUND_CONTEXT);
		if (!response.accepted) {
			this.#renderer.setConnection(`prompt rejected: ${response.error.message}`, "error");
			return;
		}
		this.#renderer.setConnection("prompt accepted", "state");
	}

	/** Withdraw queued input and abort the running turn and compaction. */
	async abort(): Promise<void> {
		await this.#controller?.abort(BACKGROUND_CONTEXT);
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
			services: [Transcript, AgentController],
			assertAccess(): void {},
			onError: (error: Error) => this.#renderer.setConnection(`stream error: ${message(error)}`, "error"),
		});
		await services.ready(BACKGROUND_CONTEXT);
		const transcript = services.use(Transcript);
		this.#services = services;
		this.#transcript = transcript.state;
		this.#controller = services.use(AgentController);
		transcript.state.subscribe(() => paint());
		paint();
	}

	async detach(): Promise<void> {
		await this.#services?.dispose(BACKGROUND_CONTEXT);
		this.#services = undefined;
		this.#transcript = undefined;
		this.#controller = undefined;
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
	const newest = directory.state.value?.sessions[0];
	if (newest !== undefined) {
		await selectSession(newest.sessionId).catch((error: unknown) => {
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
	let renderer: PageRenderer;
	try {
		renderer = createRenderer(collectPageElements());
	} catch (error) {
		document.body.textContent = `cannot boot: ${message(error)}`;
		return;
	}
	try {
		const manifest = readManifest();
		if (manifest !== undefined) {
			const elements = collectPageElements();
			elements.mode.textContent = `${manifest.mode} · ${manifest.transport.url}`;
		}
		await startPage(renderer);
	} catch (error) {
		fail(renderer, error);
	}
}

void main();
