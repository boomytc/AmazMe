import { serviceFacet, type ServiceValue, disposeResources } from "@amazme/protocol/services";
import { replicatedState } from "@amazme/chord";
import { type Context, type Facet, type MutableReplicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { getAgentDir } from "../../config.ts";
import { loadPromptTemplates } from "../../core/prompt-templates.ts";
import { loadSkills } from "../../core/skills.ts";
import { expandResourceCommand, type CommandResources } from "../../core/resource-command.ts";
import type { ResourceLoader } from "../../core/resource-loader.ts";
import { AgentController } from "../../core/plugins/agent-controller.ts";
import {
	Commands,
	type CommandCompletion,
	type CommandExpansion,
	type CommandResult,
	type CommandSummary,
	type CommandsState } from "./commands.ts";
import { SessionPlugins } from "./plugins.ts";
import { SlashCommands } from "../../core/plugins/slash-commands.ts";

/** Shared task operations; presentations call Models for model and account configuration. */
const BUILTIN_COMMANDS: readonly Omit<CommandSummary, "source">[] = [
	{ name: "compact", description: "Summarize the conversation so far", argumentHint: "[instructions]" },
	{ name: "reload", description: "Reload skills, tools, plugins, and MCP connections" },
];

/** One command a plugin registered with this session, as the catalogue lists it. */
export interface PluginCommandSummary {
	readonly name: string;
	readonly description?: string;
	readonly argumentHint?: string;
}

/**
 * The settings a command catalogue reads: where the session's resources live, and whether skills are
 * commands at all. `SettingsManager` satisfies this as it stands.
 */
export interface CommandResourceSettings {
	getPromptTemplatePaths(): string[];
	getSkillPaths(): string[];
	getEnableSkillCommands(): boolean;
	/** Re-read the settings files, so a change made in a panel reaches this session. */
	reload(): Promise<void>;
}

export interface CommandsServiceOptions {
	/** The session's working directory: project templates and skills are read from it. */
	readonly cwd: string;
	/** The session's settings, read for the configured resource paths and the skill-command switch. */
	readonly settings?: CommandResourceSettings;
	/** The default worker's prompt and command resources share this owner. */
	readonly resourceLoader?: ResourceLoader;
	/** Runs after plugins and skill files are re-read: reconnect MCP and enable newly saved tools. */
	readonly onReloaded?: (context: Context) => Promise<void>;
}

/**
 * The session's command resources, read with the same loaders the prompt path uses, so the palette
 * lists exactly the templates and skills a command can reach. `enableSkillCommands` decides whether
 * skills are commands at all, as it does in the terminal.
 */
export function loadCommandResources(options: CommandsServiceOptions): CommandResources {
	const agentDir = getAgentDir();
	const settings = options.settings;
	if (options.resourceLoader !== undefined) {
		return {
			templates: options.resourceLoader.getPrompts().prompts,
			skills: settings?.getEnableSkillCommands() === false ? [] : options.resourceLoader.getSkills().skills };
	}
	const templates = loadPromptTemplates({
		cwd: options.cwd,
		agentDir,
		promptPaths: settings?.getPromptTemplatePaths() ?? [],
		includeDefaults: true }).templates;
	if (settings !== undefined && !settings.getEnableSkillCommands()) return { templates, skills: [] };
	const skills = loadSkills({
		cwd: options.cwd,
		agentDir,
		skillPaths: settings?.getSkillPaths() ?? [],
		includeDefaults: true }).skills;
	return { templates, skills };
}

/** Shared work actions and resource commands; each presentation owns its settings controls. */
export function commandCatalog(
	resources: CommandResources,
	pluginCommands: readonly PluginCommandSummary[] = [],
): CommandSummary[] {
	const builtins: CommandSummary[] = BUILTIN_COMMANDS.map((command) => ({
		...command,
		source: "builtin" }));
	const plugins: CommandSummary[] = pluginCommands.map((command) => ({
		name: command.name,
		description: command.description ?? "",
		...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
		source: "plugin" }));
	const templates: CommandSummary[] = resources.templates.map((template) => ({
		name: template.name,
		description: template.description,
		...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }),
		source: "template" }));
	const skills: CommandSummary[] = resources.skills.map((skill) => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		argumentHint: "[args]",
		source: "skill" }));
	return [...builtins, ...plugins, ...templates, ...skills];
}

export function createCommandsFacet(options: CommandsServiceOptions): Facet {
	return serviceFacet(
		"@pi/commands",
		Commands,
		[AgentController, SessionPlugins, SlashCommands],
		async (services) => {
			const disposers: Array<() => void | Promise<void>> = [];
			try {
				const controller = services.get(AgentController);
				const sessionPlugins = services.get(SessionPlugins);
				const slashCommands = services.get(SlashCommands);
				let resources = loadCommandResources(options);
				const pluginCommands = (): PluginCommandSummary[] =>
					slashCommands.list().map((command) => ({
						name: command.name,
						...(command.description === undefined ? {} : { description: command.description }),
						...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
					}));
				// The catalogue is published once and revised whenever the session's resources or the
				// plugin registrations move. Plugin registrations are read after activation: a facet
				// cannot use another facet's service while it is still starting.
				const state: MutableReplicatedState<CommandsState> = replicatedState<CommandsState>({
					revision: 1,
					commands: commandCatalog(resources),
				});
				const republish = async (context: Context, resourcesReloaded = false): Promise<void> => {
					// A catalogue built from settings the session has not re-read would answer with the
					// previous switch, so the settings files are read again before the resources are.
					if (!resourcesReloaded || options.resourceLoader === undefined) {
						if (options.resourceLoader === undefined) await options.settings?.reload().catch(() => undefined);
						else await options.resourceLoader.reload();
					}
					resources = loadCommandResources(options);
					state.change(context, (draft) => {
						draft.revision += 1;
						draft.commands = commandCatalog(resources, pluginCommands());
					});
				};
				// Publish actual registrations at activation and retirement, using the existing registry.
				await (() => {
					disposers.push(
						slashCommands.subscribe(() => {
							state.change(BACKGROUND_CONTEXT, (draft) => {
								draft.revision += 1;
								draft.commands = commandCatalog(resources, pluginCommands());
							});
						}),
					);
				})();
				const implementation: ServiceValue<typeof Commands> = {
					state,
					async run(name: string, args: string, callContext: Context): Promise<CommandResult> {
						switch (name) {
							case "compact": {
								const trimmed = args.trim();
								const response = await controller.compact(
									{ customInstructions: trimmed.length === 0 ? null : trimmed },
									callContext,
								);
								return response.accepted
									? { ok: true, note: "Compacting the conversation." }
									: failure(response.error.message);
							}
							case "reload": {
								await sessionPlugins.reload(callContext);
								// Skill files and templates are already re-read; publish them before MCP or tools can fail.
								await republish(callContext, true);
								await options.onReloaded?.(callContext);
								return { ok: true, note: "Reloaded skills, tools, plugins, and MCP connections." };
							}
							default: {
								// A plugin's command runs here, with the same call the client TUI makes.
								const contribution = slashCommands.list().find((command) => command.name === name);
								if (contribution !== undefined) {
									const outcome = await contribution.run(args, callContext);
									return { ok: true, note: describeRun(outcome) };
								}
								return failure(`Unknown command: /${name}`);
							}
						}
					},
					async complete(name: string, prefix: string, _callContext: Context): Promise<readonly CommandCompletion[]> {
						const contribution = slashCommands.list().find((command) => command.name === name);
						return (await contribution?.getArgumentCompletions?.(prefix)) ?? [];
					},
					async expand(name: string, args: string): Promise<CommandExpansion> {
						return expandResourceCommand(resources, name, args);
					},
					async refresh(context: Context): Promise<void> {
						await republish(context);
					},
				};

				return { value: implementation, close: () => disposeResources(disposers) };
			} catch (error) {
				await disposeResources(disposers);
				throw error;
			}
		},
	);
}

function failure(problem: string): CommandResult {
	return { ok: false, problem };
}

/** What a plugin command's own result says, so the connection line has something to show. */
function describeRun(outcome: unknown): string {
	if (outcome === undefined) return "Done.";
	if (typeof outcome === "object" && outcome !== null) {
		const response = outcome as { accepted?: unknown; error?: { message?: unknown } | null; note?: unknown };
		if (typeof response.note === "string") return response.note;
		if (response.accepted === false) {
			const message = response.error?.message;
			return typeof message === "string" ? message : "The session refused the command.";
		}
	}
	return "Done.";
}
