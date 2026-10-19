import { resolve } from "node:path";
import { type MutableReplicatedState, replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { ServiceHost } from "@amazme/protocol/services";
import type { PluginArtifact } from "../src/core/plugins/artifact.ts";
import { connectTestHost } from "./native-host-support.ts";
import { fauxAssistantMessage } from "@amazme/ai";
import { ProcessTerminal, TuiMainScreen } from "@amazme/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type ClientTuiServer, ExperimentalClientTui } from "../src/host/client-tui.ts";
import { createPresentationFacetData } from "../src/host/plugins/bundled.ts";
import { AgentController } from "../src/core/plugins/agent-controller.ts";
import { Conversations } from "../src/host/services/conversations.ts";
import { IDLE_LANE, type ConversationsState } from "../src/durable/conversation-view.ts";
import { createAgentController } from "../src/core/plugins/agent-controller-provider.ts";
import type {
	ServerConnectionState,
	ServerServiceSource,
	SessionAttachmentState,
	SessionServiceSource,
} from "../src/host/services/connection.ts";
import { Models, type ModelsState } from "../src/host/services/models.ts";
import { Commands } from "../src/host/services/commands.ts";
import { PresentationPlugins, SessionPlugins } from "../src/host/services/plugins.ts";
import {
	SessionDirectory,
	type SessionDirectoryState,
	SessionManagement,
	type SessionSummary,
} from "../src/host/services/sessions.ts";
import { Transcript } from "../src/host/services/transcript.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

const serverId = "00000000-0000-4000-8000-000000000001";

function session(sessionId: string, createdAt: number, cwd = "/tmp/session-cwd"): SessionSummary {
	return { serverId, sessionId, createdAt, cwd, source: "host" };
}

function testSource(provider: ServiceHost) {
 return {
  async catalogue() { await provider.ready(); return provider.catalogue.filter(entry => !entry.local); },
  open(options: Parameters<ServerServiceSource["open"]>[0]) {
   const peer = connectTestHost(provider.host);
   for (const service of options.services) peer.scope.get(service);
   return { get: peer.scope.get.bind(peer.scope), ready: peer.scope.ready.bind(peer.scope), dispose: () => peer.close() };
  },
  async dispose() {},
 };
}

function publishReplacement<T extends object>(state: MutableReplicatedState<T>, value: T): void {
	state.replace(BACKGROUND_CONTEXT, value);
}

describe("experimental client TUI", () => {
	beforeAll(() => initTheme("dark"));

	test.each([
		["new", { command: "client" as const }, "two", 1],
		["continued", { command: "client" as const, continue: true }, "one", 0],
		["plugin-selected", { command: "client" as const, pluginPackages: ["./example-plugin"] }, "two", 1],
	] as const)(
		"opens a %s Session directly and exercises the full lifecycle only for a new Session",
		async (kind, command, sessionId, creates) => {
			const directoryState = replicatedState<SessionDirectoryState>({ revision: 1, sessions: [session("one", 1)] });
			const attachment = replicatedState<SessionAttachmentState>({ status: "detached" });
			const connectionState = replicatedState<ServerConnectionState>({ status: "connected", since: "now" });
			const modelsState = replicatedState<ModelsState>({
				catalog: {
					revision: 1,
					enabledModelIds: null,
					availableModels: [
						{ provider: "test", modelId: "one", name: "Model One", reasoning: false, contextWindow: 1000 },
						{ provider: "test", modelId: "two", name: "Model Two", reasoning: true, contextWindow: 1000 },
					],
				},
				configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
				refresh: { status: "idle" },
				authentication: null,
			});
			const create = vi.fn(async () => {
				const created = session("two", 2);
				directoryState.change(BACKGROUND_CONTEXT, (draft) => {
					draft.revision = 2;
					draft.sessions.push(created);
				});
				return created;
			});
			const select = vi.fn(async (model: { provider: string; modelId: string }) => {
				modelsState.change(BACKGROUND_CONTEXT, (draft) => {
					draft.configuration.model = model;
				});
			});
			const selectThinking = vi.fn(async (thinkingLevel: "off" | "high") => {
				modelsState.change(BACKGROUND_CONTEXT, (draft) => {
					draft.configuration.thinkingLevel = thinkingLevel;
				});
			});
			let finishPrompt!: () => void;
			const promptFinished = new Promise<void>((resolve) => {
				finishPrompt = resolve;
			});
			const prompts: string[] = [];
			const durable = await openFauxConversation([
				async (context) => {
					const last = context.messages.at(-1);
					if (last?.role === "user") {
						prompts.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
					}
					await promptFinished;
					return fauxAssistantMessage("remote answer");
				},
			]);
			const transcriptState = await durable.conversation.viewState(BACKGROUND_CONTEXT);

			const reloadArtifact: PluginArtifact = {
    name: "test-tui-plugin/tui",
    code: 'import { defineFacet } from "@amazme/chord"; import { AgentController } from "@amazme/coding-agent/host/plugin"; export default defineFacet(() => {}, { uses: [AgentController.contract] });',
   };
			const reloadData = createPresentationFacetData([reloadArtifact]);
			const prepareSessionPlugins = vi.fn(async () => reloadData);
			const reloadPresentationPlugins = vi.fn(async () => reloadData);
			const reloadSessionPlugins = vi.fn(async () => {});
			const serverProvider = new ServiceHost("server");
			serverProvider.provide(SessionDirectory, { state: directoryState });
			serverProvider.provide(PresentationPlugins, {
				prepareSession: prepareSessionPlugins,
				reload: reloadPresentationPlugins,
			});
			serverProvider.provide(SessionManagement, {
				create,
				async remove() {},
				async attach(sessionId) {
					publishReplacement(attachment, { status: "attaching", sessionId });
				},
				async detach() {
					publishReplacement(attachment, { status: "detached" });
				},
				async rename(sessionId) {
					const current = directoryState.value.sessions.find((session) => session.sessionId === sessionId);
					if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
					return current;
				},
			});
			const rootConversationId = String(durable.conversation.id);
			const conversationsState = replicatedState<ConversationsState>({
				revision: 1,
				selected: rootConversationId,
				branchSummarySkipPrompt: false,
				lane: { ...IDLE_LANE, model: "faux/faux-1" },
				conversations: [
					{
						id: rootConversationId,
						label: "main",
						root: true,
						role: "main" as const,
						depth: 0,
						children: 0,
						hasEntries: false,
					},
				],
				tasks: [],
				view: null,
			});
			const sessionProvider = new ServiceHost("session");
			sessionProvider.provide(SessionPlugins, { reload: reloadSessionPlugins });
			sessionProvider.provide(Commands, {
				state: replicatedState({ revision: 1, commands: [] }),
				async run() { await reloadSessionPlugins(); return { ok: true, note: "Reloaded." }; },
				async complete() { return []; },
				async expand() { return { ok: false, problem: "No fixture resources" }; },
				async refresh() {},
			});
			sessionProvider.provide(Models, {
				state: modelsState,
				async suggestPrompt() {
					return null;
				},
				async cycleThinking() {},
				async cycleModel() {},
				async getModelScope() { return { allModels: [], enabledModelIds: null }; },
				async setModelScope() {},
						async saveDefaults() {},
				async getThinkingLevels() {
					return ["off", "high"];
				},
				async refresh() {},
				select,
				selectThinking,
				async startLogin() { throw new Error("Fixture does not log in"); },
				async submitLoginPrompt() { return false; },
				async cancelLogin() { return false; },
				async logout() {},
			});
			sessionProvider.provide(AgentController, createAgentController(durable.harness, () => durable.conversation));
			sessionProvider.provide(Transcript, { state: transcriptState });
			const retryTask = vi.fn(async (taskId: string) => {
				conversationsState.change(BACKGROUND_CONTEXT, (draft) => {
					draft.tasks = draft.tasks.map(({ blocked: _parked, ...task }) =>
						task.id === taskId ? { ...task, status: "running", restarts: 0 } : { ...task, blocked: _parked },
					);
				});
			});
			sessionProvider.provide(Conversations, {
				retryTask,
				state: conversationsState,
				async rename() { throw new Error("Fixture does not rename branches"); },
				async setArchived() { throw new Error("Fixture does not archive branches"); },
				async cancelSummaries() {},
				async select() {},
				async returnPoints() { return []; },
				async leave() { throw new Error("Fixture does not leave branches"); },
				async fork() {
					return { conversationId: null, error: { code: "fork", message: "unused" } };
				},
				async refresh() {},
				async older() {
					return { entries: [] };
				},
				async prompt() {
					return { accepted: false, operationId: null, error: { code: "unused", message: "unused" } };
				},
				async steer() {
					return { accepted: false, entryId: null, error: { code: "unused", message: "unused" } };
				},
				async followUp() {
					return { accepted: false, entryId: null, error: { code: "unused", message: "unused" } };
				},
				async abort() {},
				async cancelQueued() {
					return { outcome: "not_found" as const };
				},
				async compact() {
					return { accepted: false, operationId: null, error: { code: "unused", message: "unused" } };
				},
			});

			await Promise.all([serverProvider.ready(), sessionProvider.ready()]);
   const serverServices: ServerServiceSource = { ...testSource(serverProvider), connection: connectionState };
   const sessionServices: SessionServiceSource = {
    ...testSource(sessionProvider), attachment,
    async whenAttached(sessionId) { publishReplacement(attachment, { status: "attached", sessionId }); },
    async whenDetached() { publishReplacement(attachment, { status: "detached" }); },
   };
			const server: ClientTuiServer = {
				serverId,
				radius: true,
				server: serverServices,
				session: sessionServices,
			};
			let finished = false;
			const requestRender = vi.fn();
			const ui = new TuiMainScreen(new ProcessTerminal());
			const component = await ExperimentalClientTui.create({
				command,
				ui,
				servers: [server],
				requestRender,
				finish() {
					finished = true;
				},
			});
			try {
				expect(create).toHaveBeenCalledTimes(creates);
				expect(prepareSessionPlugins).toHaveBeenCalledWith(
					{
						sessionId,
						packagePaths:
							"pluginPackages" in command
								? command.pluginPackages.map((packagePath) => resolve(packagePath))
								: null,
					},
					expect.anything(),
				);
				expect(attachment.value).toEqual({ status: "attached", sessionId });
				expect(select).not.toHaveBeenCalled();
				expect(component.render(80).join("\n")).toContain(`Server: ${serverId}`);
				expect(component.render(80).join("\n")).toContain(`Session: ${sessionId}`);
				expect(component.render(80).join("\n")).toContain("Main · idle");
				expect(component.render(80).join("\n")).not.toContain("Experimental Sessions");
				expect(component.render(80).join("\n")).not.toContain("Experimental Models");

				// Startup selection is the only behavior specific to continue and plugin-selected Sessions.
				if (kind !== "new") return;

				component.handleInput("hello");
				component.handleInput("\r");
				await vi.waitFor(() => expect(prompts).toEqual(["hello"]));
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Working..."));
				finishPrompt();
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("remote answer"));
				expect(component.render(80).join("\n")).toContain("hello");
				expect(component.render(80).join("\n")).not.toContain("Working...");

				component.handleInput("/reload");
				component.handleInput("\u001b");
				component.handleInput("\r");
				await vi.waitFor(() => {
					expect(reloadPresentationPlugins).toHaveBeenCalledOnce();
					expect(reloadSessionPlugins).toHaveBeenCalledOnce();
				});
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Reloaded plugins and resources."));

				publishReplacement(attachment, { status: "detached" });
				publishReplacement(connectionState, {
					status: "disconnected",
					since: "later",
					reason: "network lost",
					retryAt: null,
				});
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("retrying"));
				component.handleInput("\u0003");
				expect(finished).toBe(true);
				finished = false;
				component.handleInput("\u0004");
				expect(finished).toBe(true);
				finished = false;
				publishReplacement(connectionState, { status: "connecting", attempt: 1 });
				publishReplacement(connectionState, { status: "connected", since: "reconnected" });
				publishReplacement(attachment, { status: "attached", sessionId });
				await vi.waitFor(() => expect(component.render(80).join("\n")).not.toContain("Reattaching"));

				component.handleInput("/model");
				component.handleInput("\u001b");
				component.handleInput("\r");
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Select model:"));
				component.handleInput("\u001b[B");
				component.handleInput("\r");
				await vi.waitFor(() =>
					expect(select).toHaveBeenCalledWith({ provider: "test", modelId: "two" }, expect.anything()),
				);
				expect(modelsState.value.configuration.model).toEqual({ provider: "test", modelId: "two" });
				await vi.waitFor(() => expect(component.render(80).join("\n")).not.toContain("Select model:"));

				component.handleInput("/thinking");
				component.handleInput("\u001b");
				component.handleInput("\r");
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Select thinking level:"));
				component.handleInput("\u001b[B");
				component.handleInput("\r");
				await vi.waitFor(() => expect(selectThinking).toHaveBeenCalledWith("high", expect.anything()));
				expect(modelsState.value.configuration.thinkingLevel).toBe("high");

				// A task parked by the configured restart limit is visible and retryable from the host TUI.
				conversationsState.change(BACKGROUND_CONTEXT, (draft) => {
					draft.tasks = [
						{
							id: "12",
							kind: "amazme.generation",
							conversationId: rootConversationId,
							background: false,
							status: "pending",
							blocked: "restart_limit",
							restarts: 3,
							restartLimit: 3,
							phase: "generate",
							waitsOn: [],
							conversations: [],
						},
					];
				});
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Task #12 paused"));
				const parkedScreen = component.render(80).join("\n");
				expect(parkedScreen).toContain("limit 3");
				expect(parkedScreen).not.toContain("limit 5");
				component.handleInput("\x1bOS");
				await vi.waitFor(() => expect(retryTask).toHaveBeenCalledWith("12", expect.anything()));
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Retried task #12."));
				expect(component.render(80).join("\n")).not.toContain("Task #12 paused");

				// Several parked tasks: the shortcut opens a selector instead of guessing.
				conversationsState.change(BACKGROUND_CONTEXT, (draft) => {
					draft.tasks = ["13", "14"].map((id) => ({
						id,
						kind: "amazme.generation",
						conversationId: rootConversationId,
						background: false,
						status: "pending",
						blocked: "restart_limit" as const,
						restarts: 2,
						restartLimit: 2,
						phase: "generate",
						waitsOn: [],
						conversations: [],
					}));
				});
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Task #13 paused"));
				component.handleInput("\x1bOS");
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Retry which paused task?"));
				component.handleInput("\u001b[B");
				component.handleInput("\r");
				await vi.waitFor(() => expect(retryTask).toHaveBeenCalledWith("14", expect.anything()));

				component.handleInput("\u0003");
				await vi.waitFor(() => expect(finished).toBe(true));

				await component.close();
				const rendersAfterClose = requestRender.mock.calls.length;
				directoryState.change(BACKGROUND_CONTEXT, (draft) => {
					draft.revision = 3;
					draft.sessions = [];
				});
				publishReplacement(attachment, { status: "detached" });
				modelsState.change(BACKGROUND_CONTEXT, (draft) => {
					draft.refresh = { status: "refreshing" };
				});
				expect(requestRender).toHaveBeenCalledTimes(rendersAfterClose);
			} finally {
				await component.close();
				await Promise.all([serverProvider.dispose(), sessionProvider.dispose()]);
				transcriptState.dispose();
				await durable.close();
			}
		},
	);
});
