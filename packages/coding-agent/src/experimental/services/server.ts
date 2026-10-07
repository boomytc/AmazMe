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
import { createPluginsService } from "./plugins-provider.ts";
import {
	Settings,
	type SettingsError,
	type Settings as SettingsService,
	type SettingsState,
} from "./settings.ts";
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
	/** The server's default plugin package selection, as the plugin profile stores it. */
	readonly pluginPackages: {
		readonly list: () => readonly string[];
		readonly set: (paths: readonly string[]) => Promise<readonly string[]>;
	};
}

export interface ExperimentalServerServices {
	readonly host: RoutedServerServiceHost;
	refresh(context?: Context): Promise<void>;
	dispose(): Promise<void>;
}

export async function createExperimentalServerServices(options: {
	list(context: Context): Promise<SessionSummary[]>;
	create(createOptions: SessionCreateOptions, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
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
				const provider = new RemoteServiceProvider([
					{ service: SessionDirectory, mode: "singleton" },
					{ service: SessionManagement, mode: "singleton" },
					{ service: PresentationPlugins, mode: "singleton" },
					{ service: Settings, mode: "singleton" },
					{ service: Skills, mode: "singleton" },
					{ service: Plugins, mode: "singleton" },
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
						}),
					detach: (context) =>
						serialize(async () => {
							await presentation.detachSession(context);
							preparedPluginPackagePaths = undefined;
						}),
				});
				const attachment = createProviderAttachment(provider, () => attachments.delete(attachment));
				attachments.add(attachment);
				return attachment;
			},
		},
		refresh: (context = BACKGROUND_CONTEXT) => serialize(() => refreshNow(context)),
		async dispose() {
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
