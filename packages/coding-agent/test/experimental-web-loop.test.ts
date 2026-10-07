import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@amazme/client";
import { createWebSocketTransportFactory } from "@amazme/client/websocket";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { ConversationView } from "@amazme/durable";
import {
	inboxOf,
	isBusy,
	liveOf,
	modelPicker,
	QUEUE_CANCEL_ACTION,
	queuedInputs,
	rosterItems,
	SESSION_REMOVE_ACTION,
	transcriptBlocks,
} from "@amazme/web";
import { afterEach, describe, expect, test } from "vitest";
import { AgentController } from "../src/experimental/services/agent-controller.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type SessionServiceSource,
} from "../src/experimental/services/connection.ts";
import { Commands, type Commands as CommandsService } from "../src/experimental/services/commands.ts";
import { Approvals, type Approvals as ApprovalsService } from "../src/experimental/services/approvals.ts";
import { Conversations, type Conversations as ConversationsService } from "../src/experimental/services/conversations.ts";
import { Terminal, type Terminal as TerminalService } from "../src/experimental/services/terminal.ts";
import { Workspace, type Workspace as WorkspaceService } from "../src/experimental/services/workspace.ts";
import { Models, type Models as ModelsService } from "../src/experimental/services/models.ts";
import { Plugins, type Plugins as PluginsService } from "../src/experimental/services/plugins.ts";
import { SessionDirectory, SessionManagement } from "../src/experimental/services/sessions.ts";
import { Settings, type Settings as SettingsService } from "../src/experimental/services/settings.ts";
import { Skills, type Skills as SkillsService } from "../src/experimental/services/skills.ts";
import { Transcript } from "../src/experimental/services/transcript.ts";
import { startWebHost, type WebHost } from "../src/experimental/web/host.ts";

interface Presentation {
	readonly management: SessionManagement;
	readonly directory: SessionDirectory;
	readonly sessionSource: SessionServiceSource;
	dispose(): Promise<void>;
}

interface Attached {
	readonly transcript: { readonly state: { readonly value: ConversationView | undefined } };
	readonly controller: AgentController;
	readonly models: ModelsService;
	readonly commands: CommandsService;
	readonly workspace: WorkspaceService;
	readonly conversations: ConversationsService;
	readonly approvals: ApprovalsService;
	readonly terminal: TerminalService;
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

/** Start a host whose agent directory has no credentials: model turns fail offline and fast. */
async function startLoopHost(): Promise<WebHost> {
	process.env.AMAZME_CODING_AGENT_DIR = await makeDirectory("web-loop-agent-");
	const host = await startWebHost({
		port: 0,
		directory: await makeDirectory("web-loop-server-"),
		sessionDir: await makeDirectory("web-loop-sessions-"),
	});
	hosts.add(host);
	return host;
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
		directory: serverServices.use(SessionDirectory),
		sessionSource,
		async dispose() {
			await serverServices.dispose(BACKGROUND_CONTEXT);
			await client.dispose();
		},
	};
}

/** Attach a session the way the page does: transcript, agent control, and the models facade. */
async function attachSession(presentation: Presentation, sessionId: string): Promise<Attached> {
	await presentation.management.attach(sessionId, BACKGROUND_CONTEXT);
	await presentation.sessionSource.whenAttached(sessionId, BACKGROUND_CONTEXT);
	const services = presentation.sessionSource.open({
		services: [Transcript, AgentController, Models, Commands, Workspace, Terminal, Conversations, Approvals],
		assertAccess(): void {},
		onError(): void {},
	});
	await services.ready(BACKGROUND_CONTEXT);
	return {
		transcript: services.use(Transcript),
		controller: services.use(AgentController),
		models: services.use(Models),
		commands: services.use(Commands),
		workspace: services.use(Workspace),
		conversations: services.use(Conversations),
		approvals: services.use(Approvals),
		terminal: services.use(Terminal),
		async dispose() {
			await services.dispose(BACKGROUND_CONTEXT);
		},
	};
}

function sawUserText(view: ConversationView | undefined, marker: string): boolean {
	return transcriptBlocks("en", view).some((block) => block.kind === "user" && block.text.includes(marker));
}

function listedSessions(presentation: Presentation): readonly string[] {
	return (presentation.directory.state.value?.sessions ?? []).map((session) => session.sessionId);
}

interface Administration {
	readonly settings: SettingsService;
	readonly skills: SkillsService;
	readonly plugins: PluginsService;
	dispose(): Promise<void>;
}

/** The management surface's bindings: the three server services the page's panels read. */
async function openAdministration(host: WebHost): Promise<Administration> {
	const client = await Client.connect({
		serverId: host.serverId,
		transportFactory: createWebSocketTransportFactory({ url: host.webSocketUrl }),
	});
	const serverSource = createServerServiceSource(client);
	const services = serverSource.open({
		services: [Settings, Skills, Plugins],
		assertAccess(): void {},
		onError(): void {},
	});
	await services.ready(BACKGROUND_CONTEXT);
	return {
		settings: services.use(Settings),
		skills: services.use(Skills),
		plugins: services.use(Plugins),
		async dispose() {
			await services.dispose(BACKGROUND_CONTEXT);
			await client.dispose();
		},
	};
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
			const host = await startLoopHost();

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

	test(
		"creates sessions from the presentation and keeps two attachments isolated",
		async () => {
			const host = await startLoopHost();
			const first = await openPresentation(host);

			const alpha = await first.management.create({ id: "web-loop-alpha" }, BACKGROUND_CONTEXT);
			expect(alpha.sessionId).toBe("web-loop-alpha");
			expect(listedSessions(first)).toContain(alpha.sessionId);

			// The same call the page's new-session bar makes, then the attach the page follows it with.
			const beta = await first.management.create({}, BACKGROUND_CONTEXT);
			expect(beta.sessionId).not.toBe(alpha.sessionId);
			await waitFor(() => listedSessions(first).includes(beta.sessionId), "the created session in the directory");

			const attachedAlpha = await attachSession(first, alpha.sessionId);
			const alphaMarker = `web-loop-alpha-${Date.now()}`;
			await attachedAlpha.controller.prompt({ message: alphaMarker, images: null }, BACKGROUND_CONTEXT);
			await waitFor(
				() => sawUserText(attachedAlpha.transcript.state.value, alphaMarker),
				"the alpha marker in alpha's transcript",
			);

			// The second presentation attaches the other session: no entry bleeds between them.
			const second = await openPresentation(host);
			const attachedBeta = await attachSession(second, beta.sessionId);
			const betaMarker = `web-loop-beta-${Date.now()}`;
			await attachedBeta.controller.prompt({ message: betaMarker, images: null }, BACKGROUND_CONTEXT);
			await waitFor(
				() => sawUserText(attachedBeta.transcript.state.value, betaMarker),
				"the beta marker in beta's transcript",
			);

			expect(sawUserText(attachedAlpha.transcript.state.value, betaMarker)).toBe(false);
			expect(sawUserText(attachedBeta.transcript.state.value, alphaMarker)).toBe(false);
			expect(
				transcriptBlocks("en", attachedAlpha.transcript.state.value).filter((block) => block.kind === "user"),
			).toHaveLength(1);

			await attachedBeta.dispose();
			await attachedAlpha.dispose();
			await second.dispose();
			await first.dispose();
		},
		240_000,
	);

	test(
		"accepts a follow-up while a turn runs, lists it as queued, and settles on abort",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-queue" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			const marker = `web-loop-run-${Date.now()}`;
			const accepted = await attached.controller.prompt({ message: marker, images: null }, BACKGROUND_CONTEXT);
			expect(accepted).toMatchObject({ accepted: true });
			// The run is in flight from here: its live document is what the page reads as busy.
			await waitFor(() => isBusy(attached.transcript.state.value), "the run to be in flight");

			const queuedMarker = `web-loop-queued-${Date.now()}`;
			const queued = await attached.controller.followUp({ message: queuedMarker, images: null }, BACKGROUND_CONTEXT);
			expect(queued).toMatchObject({ accepted: true });
			await waitFor(
				() =>
					queuedInputs("en", attached.transcript.state.value).some((item) => item.text.includes(queuedMarker)),
				"the follow-up in the queue",
			);

			await attached.controller.abort(BACKGROUND_CONTEXT);
			await waitFor(
				() =>
					!isBusy(attached.transcript.state.value) &&
					queuedInputs("en", attached.transcript.state.value).length === 0,
				"the aborted run to settle and the queue to empty",
			);
			// The aborted turn is still a committed user entry: the input was not lost.
			expect(sawUserText(attached.transcript.state.value, marker)).toBe(true);

			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"shows each session's working directory, and removes one behind a confirmation",
		async () => {
			const sessionDir = await makeDirectory("web-loop-remove-sessions-");
			const host = await startWebHost({
				port: 0,
				directory: await makeDirectory("web-loop-remove-server-"),
				sessionDir,
			});
			hosts.add(host);
			const first = await openPresentation(host);
			// A second presentation is the other browser tab: it must see the removal too.
			const second = await openPresentation(host);

			const created = await first.management.create({ id: "web-loop-remove" }, BACKGROUND_CONTEXT);
			const onDisk = join(sessionDir, created.sessionId);
			expect(existsSync(onDisk)).toBe(true);
			await waitFor(
				() => (second.directory.state.value?.sessions ?? []).some((session) => session.sessionId === created.sessionId),
				"the session in the second roster",
			);

			// The directory the host publishes carries the working directory the roster shows.
			const summary = first.directory.state.value?.sessions.find((session) => session.sessionId === created.sessionId);
			expect(summary).toMatchObject({ cwd: process.cwd() });

			// The page confirms before it asks: the row it renders names the session it would remove.
			expect(rosterItems("en", first.directory.state.value, created.sessionId, Date.now())[0]?.remove).toMatchObject({
				id: SESSION_REMOVE_ACTION,
				data: created.sessionId,
			});

			await first.management.remove(created.sessionId, BACKGROUND_CONTEXT);
			await waitFor(
				() => !(first.directory.state.value?.sessions ?? []).some((session) => session.sessionId === created.sessionId),
				"the session to leave the first roster",
			);
			await waitFor(
				() => !(second.directory.state.value?.sessions ?? []).some((session) => session.sessionId === created.sessionId),
				"the session to leave the second roster",
			);
			// Its storage is gone from the host's session directory.
			expect(existsSync(onDisk)).toBe(false);

			await second.dispose();
			await first.dispose();
		},
		240_000,
	);

	test(
		"publishes the approvals surface: nothing pending, and an unknown decision is refused",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-approvals" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			// The service's state reaches the client, and its list starts empty.
			await waitFor(() => attached.approvals.state.value !== undefined, "the approvals state");
			expect(attached.approvals.state.value?.pending).toEqual([]);
			// A decision for a request that is not pending reports that nothing was waiting.
			expect(await attached.approvals.decide("approval-none", true, BACKGROUND_CONTEXT)).toBe(false);

			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"lists the session's conversations, pages its history, and talks to it",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-conversations" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			// The root is the only conversation at first, and it is marked as such.
			await waitFor(
				() => (attached.conversations.state.value?.conversations ?? []).length > 0,
				"the conversation list",
			);
			const list = attached.conversations.state.value?.conversations ?? [];
			expect(list).toHaveLength(1);
			expect(list[0]).toMatchObject({ root: true, label: "main" });
			expect(attached.conversations.state.value?.selected).toBe(list[0]?.id);
			const rootId = list[0]?.id ?? "";

			// Two prompts, one after the other settles: a prompt while one runs is rejected as busy.
			for (const marker of ["first marker", "second marker"]) {
				expect(
					await attached.conversations.prompt(rootId, { message: marker, images: null }, BACKGROUND_CONTEXT),
				).toMatchObject({ accepted: true });
				await waitFor(() => sawUserText(attached.transcript.state.value, marker), `the ${marker} to commit`);
				await waitFor(() => !isBusy(attached.transcript.state.value), "the turn to settle");
			}
			// A page that starts below what the transcript shows is empty at the start of a
			// conversation: the oldest entry it shows is the oldest entry there is.
			const shownOldest = attached.transcript.state.value?.entries[0]?.id ?? 0;
			const older = await attached.conversations.older(rootId, String(shownOldest), null, 5, BACKGROUND_CONTEXT);
			expect(older.entries).toEqual([]);
			expect(older.cursor).toBeUndefined();

			// Without that bound a page is the newest slice of the stored history, and it carries what
			// the transcript itself carries: the user entries are the same.
			const page = await attached.conversations.older(rootId, null, null, 10, BACKGROUND_CONTEXT);
			// A page small enough to leave history behind carries a cursor, and the next page walks older.
			const newest = await attached.conversations.older(rootId, null, null, 2, BACKGROUND_CONTEXT);
			expect(newest.entries).toHaveLength(2);
			expect(newest.cursor).toBeDefined();
			const next = await attached.conversations.older(rootId, null, newest.cursor ?? null, 2, BACKGROUND_CONTEXT);
			expect(next.entries.every((entry) => entry.id < newest.entries[0]!.id)).toBe(true);
			const texts = page.entries
				.flatMap((entry) => entry.model ?? [])
				.filter((message) => message.role === "user")
				.map((message) => JSON.stringify(message.content));
			expect(texts.some((text) => text.includes("first marker"))).toBe(true);
			expect(texts.some((text) => text.includes("second marker"))).toBe(true);

			// Focusing the root keeps its own live transcript rather than a second view.
			await attached.conversations.select(rootId, BACKGROUND_CONTEXT);
			expect(attached.conversations.state.value?.selected).toBe(rootId);
			expect(attached.conversations.state.value?.view).toBeNull();

			// The live task graph is published alongside, and asking for a refresh settles.
			expect(Array.isArray(attached.conversations.state.value?.tasks)).toBe(true);
			await attached.conversations.refresh(BACKGROUND_CONTEXT);
			expect((attached.conversations.state.value?.conversations ?? []).length).toBe(1);

			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"browses the session's working directory and runs a command in it",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-workspace" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			// The listing is the Session's working directory, and it activates with real entries.
			await waitFor(
				() => (attached.workspace.state.value?.view.kind === "listing" ? attached.workspace.state.value.view.entries.length : 0) > 0,
				"the working directory listing",
			);
			const workspace = attached.workspace.state.value;
			expect(workspace?.cwd).toBe(process.cwd());
			const listing = workspace?.view;
			if (listing?.kind !== "listing") throw new Error("the workspace did not list its directory");
			// The entries are the real ones on disk, in the directory order the provider sorts.
			const onDisk = await readdir(process.cwd());
			const listed = listing.entries.map((entry) => entry.name);
			expect(listed.length).toBeGreaterThan(0);
			expect(listed.every((name) => onDisk.includes(name))).toBe(true);
			expect(listed.length).toBeLessThanOrEqual(onDisk.length);

			// Reading a file returns its real bytes, and walking into a directory lists that one.
			const target = listing.entries.find((entry) => entry.kind === "file");
			expect(target).toBeDefined();
			for (const entry of listing.entries.filter((candidate) => candidate.kind === "dir").slice(0, 1)) {
				await attached.workspace.open(entry.name, BACKGROUND_CONTEXT);
				await waitFor(
					() =>
						attached.workspace.state.value?.view.kind === "listing" &&
						attached.workspace.state.value.view.path === entry.name,
					`the ${entry.name} listing`,
				);
				const nested = attached.workspace.state.value?.view;
				if (nested?.kind === "listing") {
					expect(nested.parent).toBe(".");
					await attached.workspace.open(".", BACKGROUND_CONTEXT);
				}
			}
			await attached.workspace.read(target?.name ?? "", BACKGROUND_CONTEXT);
			await waitFor(() => attached.workspace.state.value?.view.kind === "text", "the file's text");
			const text = attached.workspace.state.value?.view;
			if (text?.kind !== "text") throw new Error("the workspace did not read the file");
			expect(text.path).toBe(target?.name);
			expect(text.text).toBe(await readFile(join(process.cwd(), target?.name ?? ""), "utf8"));

			// A path above the working directory is refused rather than resolved.
			await attached.workspace.read("../package.json", BACKGROUND_CONTEXT);
			await waitFor(() => attached.workspace.state.value?.view.kind === "denied", "the refusal");
			expect(attached.workspace.state.value?.view).toMatchObject({ kind: "denied", path: "../package.json" });
			await attached.workspace.read("no-such-file-anywhere.txt", BACKGROUND_CONTEXT);
			await waitFor(() => attached.workspace.state.value?.view.kind === "missing", "the missing path");

			// The terminal runs in the same directory and streams its real output.
			const marker = `web-loop-terminal-${Date.now()}`;
			expect(await attached.terminal.run(`echo ${marker}`, BACKGROUND_CONTEXT)).toEqual({ ok: true });
			await waitFor(() => attached.terminal.state.value?.status !== "running", "the command to finish");
			expect(attached.terminal.state.value).toMatchObject({ status: "done", exitCode: 0 });
			expect(attached.terminal.state.value?.output).toContain(marker);

			// A second command is refused while one runs, and stopping leaves it cancelled.
			const slow = attached.terminal.run("sleep 30; echo never", BACKGROUND_CONTEXT);
			await waitFor(() => attached.terminal.state.value?.status === "running", "the slow command");
			expect(await attached.terminal.run("echo too-soon", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });
			await attached.terminal.stop(BACKGROUND_CONTEXT);
			expect(await slow).toEqual({ ok: true });
			await waitFor(() => attached.terminal.state.value?.status === "cancelled", "the cancellation");
			expect(attached.terminal.state.value?.output ?? "").not.toContain("never");

			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"runs the session's own commands through the real client",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-commands" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			await waitFor(() => (attached.commands.state.value?.commands ?? []).length > 0, "the command catalogue");
			const catalogue = attached.commands.state.value?.commands ?? [];
			expect(catalogue.map((command) => command.name)).toEqual(["model", "thinking", "compact", "reload"]);
			expect(catalogue.find((command) => command.name === "model")?.argumentHint).toBe("<provider/model>");

			await waitFor(() => attached.models.state.value !== undefined, "the models state");
			// /thinking takes a level the attached model reports, and says so when it does not.
			const levels = await attached.models.getThinkingLevels(BACKGROUND_CONTEXT);
			const level = levels[levels.length - 1] ?? "low";
			expect(await attached.commands.run("thinking", level, BACKGROUND_CONTEXT)).toEqual({
				ok: true,
				note: `Thinking level: ${level}.`,
			});
			await waitFor(
				() => attached.models.state.value?.configuration.thinkingLevel === level,
				"the level the command selected",
			);
			const rejected = await attached.commands.run("thinking", "nonsense", BACKGROUND_CONTEXT);
			expect(rejected.ok).toBe(false);
			expect(rejected.ok ? "" : rejected.problem).toContain("Unknown thinking level");

			// /model selects a catalogue entry and completes from the same catalogue.
			const catalog = attached.models.state.value?.catalog.availableModels ?? [];
			if (catalog.length === 0) {
				// Without the repository's model data there is nothing to select; the problem is the answer.
				expect(await attached.commands.run("model", "provider/model", BACKGROUND_CONTEXT)).toMatchObject({
					ok: false,
				});
				expect(await attached.commands.run("model", "", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });
			} else {
				const target = catalog[0]!;
				expect(
					await attached.commands.run("model", `${target.provider}/${target.modelId}`, BACKGROUND_CONTEXT),
				).toEqual({ ok: true, note: `Selected ${target.provider}/${target.modelId}.` });
				await waitFor(
					() => attached.models.state.value?.configuration.model?.modelId === target.modelId,
					"the model the command selected",
				);
				const completions = await attached.commands.complete("model", target.modelId, BACKGROUND_CONTEXT);
				expect(completions.some((completion) => completion.value === `${target.provider}/${target.modelId}`)).toBe(
					true,
				);
			}

			// /compact is the same durable task the header's control reaches.
			expect(await attached.commands.run("compact", "keep the markers", BACKGROUND_CONTEXT)).toEqual({
				ok: true,
				note: "Compacting the conversation.",
			});
			// /reload rebuilds this session's plugin generation, and an unknown name is a problem.
			expect(await attached.commands.run("reload", "", BACKGROUND_CONTEXT)).toEqual({
				ok: true,
				note: "Reloaded this session's plugins.",
			});
			expect(await attached.commands.run("nope", "", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });

			await attached.controller.abort(BACKGROUND_CONTEXT);
			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"sends an image with a prompt, commits it in the entry, and reads it back",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-images" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			// A real 1x1 PNG: the bytes the page would read out of a picked file.
			const png =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
			expect(Buffer.from(png, "base64").subarray(0, 4).toString("hex")).toBe("89504e47");

			const marker = `web-loop-image-${Date.now()}`;
			const accepted = await attached.controller.prompt(
				{ message: marker, images: [{ type: "image", data: png, mimeType: "image/png" }] },
				BACKGROUND_CONTEXT,
			);
			expect(accepted).toMatchObject({ accepted: true });

			// The committed entry carries the image with its media type, and the projection shows it.
			const blockOf = (): ReturnType<typeof transcriptBlocks>[number] | undefined =>
				transcriptBlocks("en", attached.transcript.state.value).find(
					(block) => block.kind === "user" && block.text.includes(marker),
				);
			await waitFor(() => blockOf() !== undefined, "the image prompt to commit");
			expect(blockOf()?.images).toEqual([{ dataUrl: `data:image/png;base64,${png}`, alt: "image/png" }]);
			// The committed entry itself carries the bytes the page sent, not a re-encoding.
			const committed = attached.transcript.state.value?.entries.find((candidate) => {
				const message = candidate.model?.[0];
				return message?.role === "user" && JSON.stringify(message.content).includes(marker);
			});
			const content = committed?.model?.[0]?.role === "user" ? committed.model[0].content : undefined;
			const image =
				typeof content === "string" ? undefined : content?.find((block) => block.type === "image");
			expect(image).toEqual({ type: "image", data: png, mimeType: "image/png" });

			// A second presentation sees the same image: it is the durable entry, not page state.
			const second = await attachSession(presentation, created.sessionId);
			await waitFor(
				() =>
					transcriptBlocks("en", second.transcript.state.value).some(
						(block) => block.kind === "user" && (block.images ?? []).length === 1,
					),
				"the image in a second presentation",
			);
			expect(
				transcriptBlocks("en", second.transcript.state.value).find((block) => block.kind === "user")?.images,
			).toEqual([{ dataUrl: `data:image/png;base64,${png}`, alt: "image/png" }]);

			await attached.controller.abort(BACKGROUND_CONTEXT);
			await second.dispose();
			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"withdraws one queued input, steers another, compacts, and refreshes the catalog",
		async () => {
			const host = await startLoopHost();
			const presentation = await openPresentation(host);
			const created = await presentation.management.create({ id: "web-loop-run-control" }, BACKGROUND_CONTEXT);
			const attached = await attachSession(presentation, created.sessionId);

			const marker = `web-loop-run-control-${Date.now()}`;
			const accepted = await attached.controller.prompt({ message: marker, images: null }, BACKGROUND_CONTEXT);
			expect(accepted).toMatchObject({ accepted: true });
			await waitFor(() => isBusy(attached.transcript.state.value), "the run to be in flight");

			// Two queued inputs, then withdraw exactly the one whose strip the page rendered.
			const withdrawnMarker = `web-loop-withdraw-${Date.now()}`;
			const keptMarker = `web-loop-keep-${Date.now()}`;
			await attached.controller.followUp({ message: withdrawnMarker, images: null }, BACKGROUND_CONTEXT);
			await attached.controller.followUp({ message: keptMarker, images: null }, BACKGROUND_CONTEXT);
			await waitFor(
				() => queuedInputs("en", attached.transcript.state.value).length === 2,
				"both follow-ups in the queue",
			);

			const strip = queuedInputs("en", attached.transcript.state.value).find((item) =>
				item.text.includes(withdrawnMarker),
			);
			expect(strip).toBeDefined();
			// The strip's own control names its submission, which is what the page sends back.
			expect(strip?.cancel).toMatchObject({ id: QUEUE_CANCEL_ACTION, data: strip?.id });
			expect(await attached.controller.cancelQueued(strip?.id ?? "", BACKGROUND_CONTEXT)).toMatchObject({
				outcome: "cancelled",
			});
			await waitFor(
				() => queuedInputs("en", attached.transcript.state.value).length === 1,
				"the withdrawn input to leave the queue",
			);
			expect(queuedInputs("en", attached.transcript.state.value)[0]?.text).toContain(keptMarker);

			// A steer is an admission of its own: the durable inbox records its mode.
			const steerMarker = `web-loop-steer-${Date.now()}`;
			expect(
				await attached.controller.steer({ message: steerMarker, images: null }, BACKGROUND_CONTEXT),
			).toMatchObject({ accepted: true });
			await waitFor(
				() =>
					inboxOf(attached.transcript.state.value as ConversationView).items.some((item) => item.mode === "steer"),
				"the steer in the durable inbox",
			);

			// Compaction on demand: the request reaches the durable task the live document shows.
			expect(
				await attached.controller.compact({ customInstructions: "keep the marker" }, BACKGROUND_CONTEXT),
			).toMatchObject({ accepted: true });
			await waitFor(
				() => (liveOf(attached.transcript.state.value as ConversationView).compactions ?? []).length > 0,
				"the compaction task in the live document",
			);

			// A catalog refresh settles instead of staying in flight.
			await attached.models.refresh(BACKGROUND_CONTEXT);
			await waitFor(
				() => attached.models.state.value?.refresh.status !== "refreshing",
				"the catalog refresh to settle",
			);
			expect(["done", "warning"]).toContain(attached.models.state.value?.refresh.status);

			await attached.controller.abort(BACKGROUND_CONTEXT);
			await waitFor(() => !isBusy(attached.transcript.state.value), "the aborted run to settle");
			await attached.dispose();
			await presentation.dispose();
		},
		240_000,
	);

	test(
		"replicates a model and thinking-level change, per session",
		async () => {
			const host = await startLoopHost();
			const first = await openPresentation(host);
			const alpha = await first.management.create({ id: "web-loop-models-a" }, BACKGROUND_CONTEXT);
			const attachedAlpha = await attachSession(first, alpha.sessionId);

			await waitFor(() => attachedAlpha.models.state.value !== undefined, "the models state");
			const catalog = attachedAlpha.models.state.value?.catalog.availableModels ?? [];
			// The model data ships with the repository; without it the picker's empty state is the
			// observable and the round trip cannot be driven (recorded under Risks in the plan).
			if (catalog.length === 0) {
				expect(modelPicker("en", attachedAlpha.models.state.value, [], true).empty).toBe("No models available.");
				return;
			}

			const target = catalog.find((model) => model.reasoning) ?? catalog[0]!;
			await attachedAlpha.models.select({ provider: target.provider, modelId: target.modelId }, BACKGROUND_CONTEXT);
			await waitFor(
				() => attachedAlpha.models.state.value?.configuration.model?.modelId === target.modelId,
				"the replicated model selection",
			);
			expect(attachedAlpha.models.state.value?.configuration.model).toEqual({
				provider: target.provider,
				modelId: target.modelId,
			});

			const levels = await attachedAlpha.models.getThinkingLevels(BACKGROUND_CONTEXT);
			expect(levels.length).toBeGreaterThan(0);
			const level = levels.find((candidate) => candidate !== attachedAlpha.models.state.value?.configuration.thinkingLevel);
			if (level !== undefined) {
				await attachedAlpha.models.selectThinking(level, BACKGROUND_CONTEXT);
				await waitFor(
					() => attachedAlpha.models.state.value?.configuration.thinkingLevel === level,
					"the replicated thinking level",
				);
				expect(attachedAlpha.models.state.value?.configuration.thinkingLevel).toBe(level);
			}

			// The projection the page renders reads exactly that configuration.
			const picker = modelPicker("en", attachedAlpha.models.state.value, levels, true);
			expect(picker.label).toBe(target.name);
			expect(picker.groups.flatMap((group) => group.options).filter((option) => option.selected)).toEqual([
				{ provider: target.provider, modelId: target.modelId, label: target.name, selected: true },
			]);

			// A second session carries its own configuration: changing alpha's model left beta alone.
			const second = await openPresentation(host);
			const beta = await second.management.create({ id: "web-loop-models-b" }, BACKGROUND_CONTEXT);
			const attachedBeta = await attachSession(second, beta.sessionId);
			expect(attachedBeta.models.state.value?.configuration.model).not.toEqual({
				provider: target.provider,
				modelId: target.modelId,
			});
			const other = catalog.find(
				(model) => model.provider !== target.provider || model.modelId !== target.modelId,
			);
			if (other !== undefined) {
				await attachedBeta.models.select({ provider: other.provider, modelId: other.modelId }, BACKGROUND_CONTEXT);
				await waitFor(
					() => attachedBeta.models.state.value?.configuration.model?.modelId === other.modelId,
					"beta's own model selection",
				);
				expect(attachedAlpha.models.state.value?.configuration.model).toEqual({
					provider: target.provider,
					modelId: target.modelId,
				});
			}

			await attachedBeta.dispose();
			await attachedAlpha.dispose();
			await second.dispose();
			await first.dispose();
		},
		240_000,
	);
});

describe("web client management surfaces", () => {
	test("edits settings, skills, and MCP servers through the host's service catalogue", async () => {
		const host = await startLoopHost();
		const administration = await openAdministration(host);
		const agentDir = process.env.AMAZME_CODING_AGENT_DIR!;

		// Settings: the host publishes its catalogue, and a write lands in the agent directory.
		await waitFor(
			() => (administration.settings.state.value?.descriptors.length ?? 0) > 0,
			"the settings catalogue to hydrate",
		);
		const steering = administration.settings.state.value?.descriptors.find(
			(descriptor) => descriptor.id === "steeringMode",
		);
		expect(steering).toBeDefined();
		await administration.settings.set("steeringMode", "all", BACKGROUND_CONTEXT);
		await waitFor(
			() =>
				administration.settings.state.value?.descriptors.find((d) => d.id === "steeringMode")?.value === "all",
			"the steering mode in the settings state",
		);
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({ steeringMode: "all" });
		// A value the field cannot take is rejected over the wire too, and the file keeps the old one.
		// (The remote boundary reports its own message; the field's own wording is not what crosses it.)
		await expect(administration.settings.set("steeringMode", "sometimes", BACKGROUND_CONTEXT)).rejects.toThrow();
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({ steeringMode: "all" });

		// Skills: a created skill is listed by the host's own loader and readable back.
		await administration.skills.write(
			{ name: "web-turn-report", content: "---\nname: web-turn-report\ndescription: Report a turn\n---\n\nBody.\n" },
			BACKGROUND_CONTEXT,
		);
		await waitFor(
			() => administration.skills.state.value?.skills.some((skill) => skill.name === "web-turn-report") === true,
			"the created skill in the skills state",
		);
		expect(administration.skills.state.value?.directory).toBe(join(agentDir, "skills"));
		await expect(administration.skills.read("web-turn-report", BACKGROUND_CONTEXT)).resolves.toContain("Body.");
		await administration.skills.remove("web-turn-report", BACKGROUND_CONTEXT);
		await waitFor(
			() => administration.skills.state.value?.skills.length === 0,
			"the removed skill to leave the skills state",
		);

		// Plugins: an MCP server lands in the agent directory's mcp.json and comes back with its patch.
		await administration.plugins.addMcpServer(
			"web-loop-mcp",
			JSON.stringify({ url: "https://mcp.example/mcp" }),
			BACKGROUND_CONTEXT,
		);
		await waitFor(
			() => administration.plugins.state.value?.mcp.servers.some((server) => server.name === "web-loop-mcp") === true,
			"the added MCP server in the plugins state",
		);
		expect(administration.plugins.state.value?.mcp.globalPath).toBe(join(agentDir, "mcp.json"));
		await administration.plugins.setMcpServer("web-loop-mcp", { enabled: false }, BACKGROUND_CONTEXT);
		await waitFor(
			() =>
				administration.plugins.state.value?.mcp.servers.find((server) => server.name === "web-loop-mcp")?.enabled ===
				false,
			"the disabled MCP server",
		);
		await administration.plugins.removeMcpServer("web-loop-mcp", BACKGROUND_CONTEXT);
		await waitFor(
			() => administration.plugins.state.value?.mcp.servers.length === 0,
			"the removed MCP server to leave the plugins state",
		);

		await administration.dispose();
		await host.close();
	}, 240_000);
});
