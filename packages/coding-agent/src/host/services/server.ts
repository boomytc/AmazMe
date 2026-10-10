import {
	type Context,
	createRemoteServiceEndpoint,
	decodeServiceControlCall,
	type JsonValue,
	RemoteServiceProvider,
	replicatedState,
} from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { RoutedServerServiceAttachment, RoutedServerServiceHost } from "@amazme/server";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { PluginRuntime } from "../../core/plugins/runtime.ts";
import { collectDiagnostics, type DiagnosticOptions } from "../../core/local-diagnostics.ts";
import { loadCodingResources } from "../../durable/harness-setup.ts";
import { Diagnostics } from "./diagnostics.ts";
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
	readonly diagnosticHost?: DiagnosticOptions["host"];
	readonly diagnosticResources?: readonly string[];
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
	/** Selected server facets own their services and resources. Absent means no plugin host. */
	plugins?: PluginRuntime;
}): Promise<ExperimentalServerServices> {
	const definitions = [SessionDirectory, SessionManagement, PresentationPlugins, Settings, Skills, Plugins, Feedback, Diagnostics]
		.map(service => ({ service, mode: "singleton" as const }));
	const builtinIds = new Set(definitions.map(({ service }) => service.id));
	if (options.plugins?.services.catalogue.some(entry => builtinIds.has(entry.serviceId))) {
		throw new Error("Server plugins cannot replace built-in services");
	}
	let revision = 1;
	const directory = replicatedState<SessionDirectoryState>({
		revision,
		sessions: await options.list(BACKGROUND_CONTEXT),
	});
	const attachments = new Set<RoutedServerServiceAttachment>();
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
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
		{ agentDir, cwd, resources: await loadCodingResources(manager, cwd) },
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
				if (disposed) throw new Error("Server services are disposed");
				let preparedPluginPackagePaths: readonly string[] | undefined;
				// A client that just arrived sees the sessions that exist now, including terminal ones
				// created while this host was running.
				void refreshNow(BACKGROUND_CONTEXT).catch(() => undefined);
				const provider = new RemoteServiceProvider(definitions);
				provider.provide(SessionDirectory, { state: directory });
				provider.provide(Diagnostics, {
					async report(context) {
						context.abortSignal?.throwIfAborted();
						const report = await collectDiagnostics({ cwd, agentDir, projectTrusted: manager.isProjectTrusted(), host: options.administration.diagnosticHost, resources: options.administration.diagnosticResources });
						context.abortSignal?.throwIfAborted();
						return report;
					},
				});
				provider.provide(Settings, {
					state: settingsState,
					set: (id, value, context) =>
						serialize(async () => {
							settingsErrorList = await applySetting(manager, id, value);
							await skills.service.reload(context);
							publishSettings(settingsState, context, { manager, agentDir, cwd, paths, errors: settingsErrorList });
						}),
					reload: (context) =>
						serialize(async () => {
							await skills.service.reload(context);
							settingsErrorList = settingsErrors(manager);
							publishSettings(settingsState, context, { manager, agentDir, cwd, paths, errors: settingsErrorList });
						}),
				});
				provider.provide(Skills, {
					state: skills.service.state,
					read: (name, context) => serialize(() => skills.service.read(name, context)),
					write: (request, context) => serialize(() => skills.service.write(request, context)),
					remove: (name, context) => serialize(() => skills.service.remove(name, context)),
					importSkill: (path, context) => serialize(() => skills.service.importSkill(path, context)),
					reload: (context) => serialize(() => skills.service.reload(context)),
				});
				provider.provide(Feedback, {
					state: feedback.service.state,
					rate: (request, context) => serialize(() => feedback.service.rate(request, context)),
					retract: (request, context) => serialize(() => feedback.service.retract(request, context)),
					reload: (context) => serialize(() => feedback.service.reload(context)),
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
				const attachment = createProviderAttachment(provider, () => attachments.delete(attachment), options.plugins?.services);
				attachments.add(attachment);
				return attachment;
			},
		},
		refresh: (context = BACKGROUND_CONTEXT) => serialize(() => refreshNow(context)),
		nameAutomatically: (sessionId, name, context = BACKGROUND_CONTEXT) => serialize(async () => {
			await options.nameAutomatically(sessionId, name, context);
			await refreshNow(context);
		}),
		dispose() {
			if (disposePromise !== undefined) return disposePromise;
			disposed = true;
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			disposePromise = promise;
			void (async () => {
				const releases = await Promise.allSettled([
					options.plugins?.close(),
					...[...attachments].map((attachment) => attachment.release(BACKGROUND_CONTEXT)),
				]);
				attachments.clear();
				await mutationTail;
				const errors = releases.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, "Failed to stop server services");
			})().then(resolve, reject);
			return promise;
		},
	};
}

function createProviderAttachment(
	provider: RemoteServiceProvider,
	onRelease: () => void,
	additional?: RemoteServiceProvider,
): RoutedServerServiceAttachment {
	const endpoint = createRemoteServiceEndpoint(provider);
	const pluginEndpoint = additional === undefined ? undefined : createRemoteServiceEndpoint(additional);
	const pluginIds = new Set(additional?.catalogue.map(entry => entry.serviceId));
	const subscriptions = new Map<string, typeof endpoint>();
	let released = false;
	return {
		async invokeService(call, publish, context) {
			if (released) return Promise.reject(new Error("Server service attachment is released"));
			const control = decodeServiceControlCall(call);
			if (control?.type === "catalogue") return [...provider.catalogue, ...(additional?.catalogue ?? [])];
			const target = control?.type === "unsubscribe"
				? subscriptions.get(control.subscriptionId) ?? endpoint
				: pluginIds.has(control?.type === "subscribe" ? control.serviceId : call.serviceId) ? pluginEndpoint! : endpoint;
			if (control?.type === "subscribe") {
				if (subscriptions.has(control.subscriptionId)) throw new Error("Service subscription ID is already active");
				subscriptions.set(control.subscriptionId, target);
			}
			try {
				const result = await target.invoke(call, publish, context);
				if (control?.type === "unsubscribe") subscriptions.delete(control.subscriptionId);
				return result;
			} catch (error) {
				if (control?.type === "subscribe") subscriptions.delete(control.subscriptionId);
				throw error;
			}
		},
		release() {
			if (released) return;
			released = true;
			endpoint.dispose();
			pluginEndpoint?.dispose();
			subscriptions.clear();
			provider.dispose();
			onRelease();
		},
	};
}
