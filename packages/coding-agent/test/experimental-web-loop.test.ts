import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@amazme/client";
import { createWebSocketTransportFactory } from "@amazme/client/websocket";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { ConversationView } from "@amazme/durable";
import { afterEach, describe, expect, test } from "vitest";
import { AgentController } from "../src/experimental/services/agent-controller.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type SessionServiceSource,
} from "../src/experimental/services/connection.ts";
import { SessionDirectory, SessionManagement } from "../src/experimental/services/sessions.ts";
import { Transcript } from "../src/experimental/services/transcript.ts";
import { startWebHost, type WebHost } from "../src/experimental/web/host.ts";
import { transcriptBlocks } from "../src/experimental/web/view.ts";

interface Presentation {
	readonly management: SessionManagement;
	readonly sessionSource: SessionServiceSource;
	dispose(): Promise<void>;
}

interface Attached {
	readonly transcript: { readonly state: { readonly value: ConversationView | undefined } };
	readonly controller: AgentController;
	dispose(): Promise<void>;
}

const hosts = new Set<WebHost>();
const directories = new Set<string>();
const previousAgentDir = process.env.AMAZME_CODING_AGENT_DIR;

async function makeDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 90_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

/** One page-shaped presentation: two of these against one host are two browser tabs. */
async function openPresentation(host: WebHost): Promise<Presentation> {
	const client = await Client.connect({
		serverId: host.serverId,
		transportFactory: createWebSocketTransportFactory({ url: host.webSocketUrl }),
	});
	const serverSource = createServerServiceSource(client);
	const sessionSource = createSessionServiceSource(client);
	const serverServices = serverSource.open({
		services: [SessionDirectory, SessionManagement],
		assertAccess(): void {},
		onError(): void {},
	});
	await serverServices.ready(BACKGROUND_CONTEXT);
	return {
		management: serverServices.use(SessionManagement),
		sessionSource,
		async dispose() {
			await serverServices.dispose(BACKGROUND_CONTEXT);
			await client.dispose();
		},
	};
}

async function attachSession(presentation: Presentation, sessionId: string): Promise<Attached> {
	await presentation.management.attach(sessionId, BACKGROUND_CONTEXT);
	await presentation.sessionSource.whenAttached(sessionId, BACKGROUND_CONTEXT);
	const services = presentation.sessionSource.open({
		services: [Transcript, AgentController],
		assertAccess(): void {},
		onError(): void {},
	});
	await services.ready(BACKGROUND_CONTEXT);
	return {
		transcript: services.use(Transcript),
		controller: services.use(AgentController),
		async dispose() {
			await services.dispose(BACKGROUND_CONTEXT);
		},
	};
}

function sawUserText(view: ConversationView | undefined, marker: string): boolean {
	return transcriptBlocks(view).some((block) => block.kind === "user" && block.text.includes(marker));
}

afterEach(async () => {
	await Promise.allSettled([...hosts].map((host) => host.close()));
	hosts.clear();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
	if (previousAgentDir === undefined) delete process.env.AMAZME_CODING_AGENT_DIR;
	else process.env.AMAZME_CODING_AGENT_DIR = previousAgentDir;
});

describe("web client interactive loop", () => {
	test(
		"commits a prompt from one presentation and replicates it to a second one",
		async () => {
			// An empty agent directory has no credentials, so the model turn fails fast and offline
			// while the user entry still commits: the prompt and its replication are the observable.
			process.env.AMAZME_CODING_AGENT_DIR = await makeDirectory("web-loop-agent-");
			const host = await startWebHost({
				port: 0,
				directory: await makeDirectory("web-loop-server-"),
				sessionDir: await makeDirectory("web-loop-sessions-"),
			});
			hosts.add(host);

			const first = await openPresentation(host);
			const created = await first.management.create({ id: "web-loop" }, BACKGROUND_CONTEXT);
			expect(created.sessionId).toBe("web-loop");
			const attached = await attachSession(first, created.sessionId);

			const marker = `web-loop-marker-${Date.now()}`;
			const accepted = await attached.controller.prompt({ message: marker, images: null }, BACKGROUND_CONTEXT);
			expect(accepted).toMatchObject({ accepted: true });
			await waitFor(
				() => sawUserText(attached.transcript.state.value, marker),
				"the marker in the first presentation's transcript",
			);

			const second = await openPresentation(host);
			const secondAttached = await attachSession(second, created.sessionId);
			await waitFor(
				() => sawUserText(secondAttached.transcript.state.value, marker),
				"the marker in the second presentation's transcript",
			);

			await attached.controller.abort(BACKGROUND_CONTEXT);
			await secondAttached.dispose();
			await attached.dispose();
			await second.dispose();
			await first.dispose();
		},
		240_000,
	);
});
