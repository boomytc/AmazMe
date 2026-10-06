/// <reference lib="dom" />
/**
 * Page bootstrap: read the host's boot manifest, dial the loopback byte transport, and keep a
 * visible connection state. Rendering lives in `main.ts`'s siblings; this file owns only the
 * lifecycle, so a missing manifest or a dropped host is always visible instead of a blank page.
 */
import { Client, type ClientOptions } from "@amazme/client";
import { createWebSocketTransportFactory } from "@amazme/client/websocket";
import { BOOT_GLOBAL, type WebBootManifest } from "../contract.ts";

interface PageApplication {
	readonly client: Client;
	readonly manifest: WebBootManifest;
	dispose(): Promise<void>;
}

export interface PageSurface {
	setConnection(text: string, kind: "state" | "error"): void;
}

function readManifest(): WebBootManifest | undefined {
	const candidate = (globalThis as Record<string, unknown>)[BOOT_GLOBAL];
	if (typeof candidate !== "object" || candidate === null) return undefined;
	const manifest = candidate as Partial<WebBootManifest>;
	if (typeof manifest.server?.id !== "string" || typeof manifest.transport?.url !== "string") return undefined;
	return manifest as WebBootManifest;
}

function requireElement(id: string): HTMLElement {
	const element = document.getElementById(id);
	if (element === null) throw new Error(`Page document is missing #${id}`);
	return element;
}

/** Show a boot failure in both panels; the page must never stay blank. */
export function showBootFailure(surface: PageSurface, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	surface.setConnection(`cannot boot: ${message}`, "error");
}

export async function startPage(surface: PageSurface): Promise<PageApplication | undefined> {
	const manifest = readManifest();
	if (manifest === undefined) {
		showBootFailure(surface, new Error("the host served this document without its boot manifest"));
		return undefined;
	}
	document.title = `${manifest.app.name} ${manifest.app.version}`;
	const client = new Client({
		serverId: manifest.server.id,
		transportFactory: createWebSocketTransportFactory({ url: manifest.transport.url }),
	} satisfies ClientOptions);
	client.onConnectionStateChange((change) => {
		const detail = change.state === "connected" ? `connected to ${manifest.server.id}` : change.state;
		if (change.state === "disconnected" && change.error !== undefined) {
			surface.setConnection(`disconnected: ${change.error.message}`, "error");
			return;
		}
		surface.setConnection(detail, "state");
	});
	try {
		await client.connect();
	} catch (error) {
		showBootFailure(surface, error);
		await client.dispose();
		return undefined;
	}
	return {
		client,
		manifest,
		dispose: () => client.dispose(),
	};
}

/** Entry point referenced by the served document. */
export async function main(): Promise<void> {
	const surface: PageSurface = {
		setConnection(text, kind) {
			const element = requireElement("connection");
			element.textContent = text;
			element.className = kind;
		},
	};
	try {
		const manifest = readManifest();
		if (manifest !== undefined) requireElement("mode").textContent = `${manifest.mode} · ${manifest.transport.url}`;
		await startPage(surface);
	} catch (error) {
		showBootFailure(surface, error);
	}
}

void main();
