import {
	type Context,
	createRemoteServiceEndpoint,
	type JsonValue,
	RemoteServiceProvider,
	replicatedState,
} from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { RoutedServerServiceAttachment, RoutedServerServiceHost } from "@amazme/server";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { Plugins, PresentationPlugins, type Plugins as PluginsService } from "./plugins.ts";
import { createFeedbackService } from "./feedback-provider.ts";
import { Feedback } from "./feedback.ts";
import { createPluginsService } from "./plugins-provider.ts";
import {
	Settings,
	type SettingsError,
	type Settings as SettingsService,
	type SettingsState,
} from "./settings.ts";
import { createSchedulesService } from "./schedules-provider.ts";
import { Schedules } from "./schedules.ts";
import { applySetting, describeSettings, publishSettings, settingsErrors } from "./settings-provider.ts";
import { Skills, type Skills as SkillsService } from "./skills.ts";
import { createSkillsService } from "./skills-provider.ts";
import {
	type SessionCreateOptions,
	SessionDirectory,
	type SessionDirectoryState,
	SessionManagement,
	type SessionSummary,
} from "./sessions.ts";

/** What the server administration surface reads and writes. */
export interface ServerAdministrationOptions {
	readonly settings: {
		/** The host's own settings manager: the same files the CLI and the Session workers read. */
		readonly manager: SettingsManager;
		readonly agentDir: string;
		readonly cwd: string;
		readonly paths: { readonly global: string; readonly project?: string };
	};
	/** The agent directory the reader's ratings file lives in. */
	readonly feedback: {
		readonly agentDir: string;
	};
	/** The agent directory the planned prompts live in, and the run one of them performs. */
	readonly schedules: {
		readonly agentDir: string;
		run(sessionId: string, prompt: string, context: Context): Promise<string>;
	};
	/** The server's default plugin package selection, as the plugin profile stores it. */
	readonly pluginPackages: {
		readonly list: () => readonly string[];
		readonly set: (paths: readonly string[]) => Promise<readonly string[]>;
	};
}

export interface ExperimentalServerServices {
	readonly host: RoutedServerServiceHost;
	refresh(context?: Context): Promise<void>;
	nameAutomatically(sessionId: string, name: string, context?: Context): Promise<void>;
	dispose(): Promise<void>;
}

export async function createExperimentalServerServices(options: {
	list(context: Context): Promise<SessionSummary[]>;
	create(createOptions: SessionCreateOptions, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	rename(sessionId: string, name: string, context: Context): Promise<SessionSummary>;
	nameAutomatically(sessionId: string, name: string, context: Context): Promise<void>;
	prepareSessionPlugins(
		sessionId: string,
		packagePaths: readonly string[] | undefined,
		context: Context,
	): Promise<{ readonly packagePaths: readonly string[]; readonly presentationPlugins: JsonValue }>;
	reloadPresentationPlugins(packagePaths: readonly string[], context: Context): Promise<JsonValue>;
	administration: ServerAdministrationOptions;
}): Promise<ExperimentalServerServices> {
	let revision = 1;
	const directory = replicatedState<SessionDirectoryState>({
		revision,
		sessions: await options.list(BACKGROUND_CONTEXT),
	});
	const attachments = new Set<RoutedServerServiceAttachment>();
	let mutationTail = Promise.resolve();

	// The administration surfaces: one Settings/Skills/Plugins instance per server, shared with every
	// attached client, so two tabs see the same catalogue and the same files.
	const { manager, agentDir, cwd, paths } = options.administration.settings;
	let settingsErrorList: SettingsError[] = settingsErrors(manager);
	const settingsState = replicatedState<SettingsState>({
		revision: 1,
		agentDir,
		cwd,
		paths,
		projectTrusted: manager.isProjectTrusted(),
		descriptors: describeSettings(manager),
		errors: [...settingsErrorList],
	});
	const skills = createSkillsService(
		{ agentDir, cwd, skillPaths: () => manager.getSkillPaths() },
		replicatedState,
	);
	skills.refresh(BACKGROUND_CONTEXT);
	const plugins = createPluginsService(
		{
			agentDir,
			cwd,
			projectTrusted: manager.isProjectTrusted(),
			packages: options.administration.pluginPackages,
		},
		replicatedState,
	);
	plugins.reload(BACKGROUND_CONTEXT);
	// The reader's ratings of individual answers, in one file beside the settings.
	const feedback = createFeedbackService(
		{ agentDir: options.administration.feedback.agentDir },
		replicatedState,
	);
	void feedback.activate(BACKGROUND_CONTEXT);
	// The planned prompts: the reader's own file, and the timer that runs them.
	const schedules = createSchedulesService(
		{ agentDir: options.administration.schedules.agentDir, run: options.administration.schedules.run },
		replicatedState,
	);
	await schedules.activate(BACKGROUND_CONTEXT);
	schedules.start();

	const refreshNow = async (context: Context): Promise<void> => {
		const sessions = await options.list(context);
		revision += 1;
		directory.change(context, (draft) => {
			draft.revision = revision;
			draft.sessions = sessions;
		});
	};
	const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = mutationTail.catch(() => {}).then(operation);
		mutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	return {
		host: {
			attachClient(presentation) {
				let preparedPluginPackagePaths: readonly string[] | undefined;
				// A client that just arrived sees the sessions that exist now, including terminal ones
				// created while this host was running.
				void refreshNow(BACKGROUND_CONTEXT).catch(() => undefined);
				const provider = new RemoteServiceProvider([
					{ service: SessionDirectory, mode: "singleton" },
					{ service: SessionManagement, mode: "singleton" },
					{ service: PresentationPlugins, mode: "singleton" },
					{ service: Settings, mode: "singleton" },
					{ service: Skills, mode: "singleton" },
					{ service: Plugins, mode: "singleton" },
					{ service: Feedback, mode: "singleton" },
					{ service: Schedules, mode: "singleton" },
				]);
				provider.provide(SessionDirectory, { state: directory });
				provider.provide(Settings, {
					state: settingsState,
					set: (id, value, context) =>
						serialize(async () => {
							settingsErrorList = await applySetting(manager, id, value);
							publishSettings(settingsState, context, { manager, agentDir, cwd, paths, errors: settingsErrorList });
						}),
					reload: (context) =>
						serialize(async () => {
							await manager.reload();
							settingsErrorList = settingsErrors(manager);
							publishSettings(settingsState, context, { manager, agentDir, cwd, paths, errors: settingsErrorList });
						}),
				});
				provider.provide(Skills, skills.service);
				provider.provide(Feedback, {
					state: feedback.service.state,
					rate: (request, context) => serialize(() => feedback.service.rate(request, context)),
					retract: (request, context) => serialize(() => feedback.service.retract(request, context)),
					reload: (context) => serialize(() => feedback.service.reload(context)),
				});
				// The schedule store keeps its own write queue: a manual run awaits a whole turn, so
				// it must not hold the server's shared mutation tail while it does.
				provider.provide(Schedules, {
					state: schedules.service.state,
					add: (input, context) => schedules.service.add(input, context),
					remove: (id, context) => schedules.service.remove(id, context),
					setEnabled: (id, enabled, context) => schedules.service.setEnabled(id, enabled, context),
					runNow: (id, context) => schedules.service.runNow(id, context),
					reload: (context) => schedules.service.reload(context),
				});
				const pluginsService: PluginsService = {
					state: plugins.service.state,
					setPackages: (packagePaths, context) =>
						serialize(() => plugins.service.setPackages(packagePaths, context)),
					setMcpServer: (name, patch, context) =>
						serialize(() => plugins.service.setMcpServer(name, patch, context)),
					addMcpServer: (name, json, context) => serialize(() => plugins.service.addMcpServer(name, json, context)),
					removeMcpServer: (name, context) => serialize(() => plugins.service.removeMcpServer(name, context)),
					reload: (context) => serialize(() => plugins.service.reload(context)),
				};
				provider.provide(Plugins, pluginsService);
				provider.provide(PresentationPlugins, {
					prepareSession: ({ sessionId, packagePaths }, context) =>
						serialize(async () => {
							const selected = await options.prepareSessionPlugins(
								sessionId,
								packagePaths ?? undefined,
								context,
							);
							preparedPluginPackagePaths = selected.packagePaths;
							return selected.presentationPlugins;
						}),
					reload: (context) =>
						serialize(() => {
							if (preparedPluginPackagePaths === undefined) {
								throw new Error("No Session plugin selection is prepared");
							}
							return options.reloadPresentationPlugins(preparedPluginPackagePaths, context);
						}),
				});
				provider.provide(SessionManagement, {
					create: (createOptions, context) =>
						serialize(async () => {
							const created = await options.create(createOptions, context);
							await refreshNow(context);
							return created;
						}),
					remove: (sessionId, context) =>
						serialize(async () => {
							await presentation.prepareSessionRemoval(sessionId, context);
							await options.remove(sessionId, context);
							await refreshNow(context);
						}),
					attach: (sessionId, context) =>
						serialize(async () => {
							await presentation.attachSession(sessionId, context);
							// Attaching can adopt a terminal session, which moves it into the host's own
							// list: the roster reports what a session is now, not what it was at startup.
							await refreshNow(context);
						}),
					detach: (context) =>
						serialize(async () => {
							await presentation.detachSession(context);
							preparedPluginPackagePaths = undefined;
						}),
					rename: (sessionId, name, context) =>
						serialize(async () => {
							const renamed = await options.rename(sessionId, name, context);
							await refreshNow(context);
							return renamed;
						}),
				});
				const attachment = createProviderAttachment(provider, () => attachments.delete(attachment));
				attachments.add(attachment);
				return attachment;
			},
		},
		refresh: (context = BACKGROUND_CONTEXT) => serialize(() => refreshNow(context)),
		nameAutomatically: (sessionId, name, context = BACKGROUND_CONTEXT) => serialize(async () => {
			await options.nameAutomatically(sessionId, name, context);
			await refreshNow(context);
		}),
		async dispose() {
			schedules.stop();
			const releases = await Promise.allSettled(
				[...attachments].map((attachment) => attachment.release(BACKGROUND_CONTEXT)),
			);
			attachments.clear();
			await mutationTail;
			const errors = releases.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Failed to release server service attachments");
		},
	};
}

function createProviderAttachment(
	provider: RemoteServiceProvider,
	onRelease: () => void,
): RoutedServerServiceAttachment {
	const endpoint = createRemoteServiceEndpoint(provider);
	let released = false;
	return {
		invokeService(call, publish, context) {
			if (released) return Promise.reject(new Error("Server service attachment is released"));
			return endpoint.invoke(call, publish, context);
		},
		release() {
			if (released) return;
			released = true;
			endpoint.dispose();
			provider.dispose();
			onRelease();
		},
	};
}
