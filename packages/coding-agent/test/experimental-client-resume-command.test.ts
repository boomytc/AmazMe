import { type MutableReplicatedState, replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { ServiceHost } from "@amazme/protocol/services";
import { ProcessTerminal, TuiMainScreen } from "@amazme/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { cli } from "../src/cli/host/cli.ts";
import { AgentController } from "../src/core/plugins/agent-controller.ts";
import { createAgentController } from "../src/core/plugins/agent-controller-provider.ts";
import { IDLE_LANE } from "../src/durable/conversation-view.ts";
import { type ClientTuiServer, ExperimentalClientTui } from "../src/host/client-tui.ts";
import { Conversations } from "../src/host/services/conversations.ts";
import {
	type ServerConnectionState,
	type ServerServiceSource,
	type SessionAttachmentState,
	type SessionServiceSource,
} from "../src/host/services/connection.ts";
import { SessionInsights, type SessionInsightsState } from "../src/host/services/insights.ts";
import { Models, type ModelsState } from "../src/host/services/models.ts";
import { Commands } from "../src/host/services/commands.ts";
import { PresentationPlugins } from "../src/host/services/plugins.ts";
import {
	SessionDirectory,
	type SessionDirectoryState,
	SessionManagement,
	type SessionSummary,
} from "../src/host/services/sessions.ts";
import { SessionSettings, Settings, type SettingsState } from "../src/host/services/settings.ts";
import { Transcript } from "../src/host/services/transcript.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { connectTestHost } from "./native-host-support.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const sessionId = "paused-session";

function session(id: string, createdAt: number): SessionSummary {
	return { serverId, sessionId: id, createdAt, cwd: "/tmp/session-cwd", source: "host" };
}

function publishReplacement<T extends object>(state: MutableReplicatedState<T>, value: T): void {
	state.replace(BACKGROUND_CONTEXT, value);
}

function testSource(provider: ServiceHost) {
	return {
		async catalogue() {
			await provider.ready();
			return provider.catalogue.filter((entry) => !entry.local);
		},
		open(options: Parameters<ServerServiceSource["open"]>[0]) {
			const peer = connectTestHost(provider.host);
			for (const service of options.services) peer.scope.get(service);
			return {
				get: peer.scope.get.bind(peer.scope),
				ready: peer.scope.ready.bind(peer.scope),
				dispose: () => peer.close(),
			};
		},
		async dispose() {},
	};
}

function settingsState(): SettingsState {
	return {
		revision: 1,
		agentDir: "/tmp/agent",
		cwd: "/tmp/session-cwd",
		paths: { global: "/tmp/agent/settings.json" },
		projectTrusted: true,
		descriptors: [],
		errors: [],
	};
}

function submit(component: ExperimentalClientTui, line: string): void {
	component.handleInput(line);
	component.handleInput("\u001b");
	component.handleInput("\r");
}

describe("interactive client resume command", () => {
	beforeAll(() => initTheme("dark"));

	test("starts with --connect and --session-id and continues a paused turn with /resume-run", async () => {
		const parsed = cli.parse([
			"client",
			"--connect",
			"unix:///tmp/amazme-resume-run.sock",
			"--session-id",
			sessionId,
		]);
		expect(parsed).toEqual({
			ok: true,
			command: {
				command: "client",
				connect: { transport: "unix", path: "/tmp/amazme-resume-run.sock" },
				sessionId,
			},
		});
		if (!parsed.ok || parsed.command.command !== "client") throw new Error("client command did not parse");

		const directoryState = replicatedState<SessionDirectoryState>({
			revision: 1,
			sessions: [session(sessionId, 1)],
		});
		const attachment = replicatedState<SessionAttachmentState>({ status: "detached" });
		const connectionState = replicatedState<ServerConnectionState>({ status: "connected", since: "now" });
		const modelsState = replicatedState<ModelsState>({
			catalog: { revision: 1, enabledModelIds: null, availableModels: [] },
			configuration: { model: null, thinkingLevel: "off" },
			refresh: { status: "idle" },
			authentication: null,
		});
		const durable = await openFauxConversation();
		const transcriptState = await durable.conversation.viewState(BACKGROUND_CONTEXT);
		const rootConversationId = String(durable.conversation.id);
		const insightsState = replicatedState<SessionInsightsState>({
			revision: 1,
			reviewRevision: 0,
			conversationId: rootConversationId,
			paused: "calls",
			calls: 3,
			cleanup: { tools: 0, images: 0 },
			files: [],
			notes: [],
			skipped: 0,
			at: 0,
			verification: [],
		});
		const resume = vi.fn(async () => {});
		const serverProvider = new ServiceHost("server");
		serverProvider.provide(SessionDirectory, { state: directoryState });
		serverProvider.provide(PresentationPlugins, {
			async prepareSession() {
				return {};
			},
			async reload() {
				return {};
			},
		});
		serverProvider.provide(SessionManagement, {
			async create() {
				throw new Error("The requested session already exists");
			},
			async remove() {},
			async attach() {
				publishReplacement(attachment, { status: "attaching", sessionId });
			},
			async detach() {
				publishReplacement(attachment, { status: "detached" });
			},
			async rename(id) {
				const current = directoryState.value.sessions.find((item) => item.sessionId === id);
				if (current === undefined) throw new Error(`Unknown session: ${id}`);
				return current;
			},
		});
		serverProvider.provide(Settings, {
			state: replicatedState(settingsState()),
			async set() {},
			async adjustFontSizes() {},
			async reload() {},
		});
		const sessionProvider = new ServiceHost("session");
		sessionProvider.provide(Commands, {
			state: replicatedState({ revision: 1, commands: [] }),
			async run() {
				return { ok: true as const, note: "" };
			},
			async complete() {
				return [];
			},
			async expand() {
				return { ok: false as const, problem: "No fixture resources" };
			},
			async refresh() {},
		});
		sessionProvider.provide(Models, {
			state: modelsState,
			async suggestPrompt() {
				return null;
			},
			async cycleThinking() {},
			async cycleModel() {},
			async getModelScope() {
				return { allModels: [], enabledModelIds: null };
			},
			async setModelScope() {},
			async saveDefaults() {},
			async getThinkingLevels() {
				return ["off"];
			},
			async refresh() {},
			async select() {},
			async selectThinking() {},
			async startLogin() {
				throw new Error("Fixture does not log in");
			},
			async submitLoginPrompt() {
				return false;
			},
			async cancelLogin() {
				return false;
			},
			async logout() {},
		});
		sessionProvider.provide(AgentController, createAgentController(durable.harness, () => durable.conversation));
		sessionProvider.provide(Transcript, { state: transcriptState });
		sessionProvider.provide(Conversations, {
			async retryTask() { throw new Error("Fixture does not retry tasks"); },
			state: replicatedState({
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
			}),
			async rename() {},
			async setArchived() {},
			async cancelSummaries() {},
			async select() {},
			async returnPoints() {
				return [];
			},
			async leave() {
				throw new Error("Fixture does not leave branches");
			},
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
		sessionProvider.provide(SessionSettings, {
			state: replicatedState(settingsState()),
			async reload() {},
		});
		sessionProvider.provide(SessionInsights, {
			state: insightsState,
			async refresh() {},
			async diff() {
				return "";
			},
			resume,
		});
		await Promise.all([serverProvider.ready(), sessionProvider.ready()]);
		const serverServices: ServerServiceSource = {
			...testSource(serverProvider),
			connection: connectionState,
		};
		const sessionServices: SessionServiceSource = {
			...testSource(sessionProvider),
			attachment,
			async whenAttached(id) {
				publishReplacement(attachment, { status: "attached", sessionId: id });
			},
			async whenDetached() {
				publishReplacement(attachment, { status: "detached" });
			},
		};
		const server: ClientTuiServer = {
			serverId,
			radius: false,
			server: serverServices,
			session: sessionServices,
		};
		const ui = new TuiMainScreen(new ProcessTerminal());
		const component = await ExperimentalClientTui.create({
			command: parsed.command,
			ui,
			servers: [server],
			requestRender() {},
			finish() {},
		});
		try {
			expect(component.render(80).join("\n")).toContain(`Session: ${sessionId}`);
			expect(component.render(80).join("\n")).not.toContain("Invalid slash command name");

			submit(component, "/resume_run");
			await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Unknown slash command: /resume_run"));
			expect(resume).not.toHaveBeenCalled();

			submit(component, "/resume-run");
			await vi.waitFor(() => expect(resume).toHaveBeenCalledWith(rootConversationId, expect.anything()));
			await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("已允许继续当前回合。"));
		} finally {
			await component.close();
			await Promise.all([serverProvider.dispose(), sessionProvider.dispose()]);
			transcriptState.dispose();
			await durable.close();
		}
	});
});
