import { type Context, defineFacet, type Facet, type MutableReplicatedState } from "@amazme/chord";
import type { ModelThinkingLevel } from "@amazme/ai";
import { getAgentDir } from "../../config.ts";
import { loadPromptTemplates, expandPromptTemplate, type PromptTemplate } from "../../core/prompt-templates.ts";
import { skillCommandPrompt } from "../../core/skill-command.ts";
import { loadSkills, type Skill } from "../../core/skills.ts";
import { AgentController } from "./agent-controller.ts";
import {
	Commands,
	type CommandCompletion,
	type CommandExpansion,
	type CommandResult,
	type CommandSummary,
	type CommandsState,
} from "./commands.ts";
import { Models } from "./models.ts";
import { SessionPlugins } from "./plugins.ts";

/**
 * The session's own commands: the built-ins a web presentation needs, with textual arguments
 * instead of dialogs. A presentation supplies the interaction (the composer's palette); the host
 * supplies the effect, and every effect goes through the session services the page already depends
 * on. Everything else in the catalogue is a resource the session loaded — a prompt template or a
 * skill — which the presentation expands with `expand` and sends on its own prompt path.
 */
const BUILTIN_COMMANDS: readonly Omit<CommandSummary, "source">[] = [
	{ name: "model", description: "Select the conversation's model", argumentHint: "<provider/model>" },
	{ name: "thinking", description: "Set the reasoning level", argumentHint: "<level>" },
	{ name: "compact", description: "Summarize the conversation so far", argumentHint: "[instructions]" },
	{ name: "reload", description: "Rebuild this session's plugin generation" },
];

const THINKING_DESCRIPTIONS: Readonly<Record<ModelThinkingLevel, string>> = {
	off: "No reasoning",
	minimal: "Very brief reasoning",
	low: "Light reasoning",
	medium: "Moderate reasoning",
	high: "Deep reasoning",
	xhigh: "Extra-high reasoning",
	max: "Maximum reasoning",
};

/** The resources that contribute commands to one session: its prompt templates and its skills. */
export interface CommandResources {
	readonly templates: readonly PromptTemplate[];
	readonly skills: readonly Skill[];
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
}

/**
 * The session's command resources, read with the same loaders the prompt path uses, so the palette
 * lists exactly the templates and skills a command can reach. `enableSkillCommands` decides whether
 * skills are commands at all, as it does in the terminal.
 */
export function loadCommandResources(options: CommandsServiceOptions): CommandResources {
	const agentDir = getAgentDir();
	const settings = options.settings;
	const templates = loadPromptTemplates({
		cwd: options.cwd,
		agentDir,
		promptPaths: settings?.getPromptTemplatePaths() ?? [],
		includeDefaults: true,
	}).templates;
	if (settings !== undefined && !settings.getEnableSkillCommands()) return { templates, skills: [] };
	const skills = loadSkills({
		cwd: options.cwd,
		agentDir,
		skillPaths: settings?.getSkillPaths() ?? [],
		includeDefaults: true,
	}).skills;
	return { templates, skills };
}

/** One row per command: the built-ins first, then the templates, then the skills as `/skill:<name>`. */
export function commandCatalog(resources: CommandResources): CommandSummary[] {
	const builtins: CommandSummary[] = BUILTIN_COMMANDS.map((command) => ({ ...command, source: "builtin" }));
	const templates: CommandSummary[] = resources.templates.map((template) => ({
		name: template.name,
		description: template.description,
		...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }),
		source: "template",
	}));
	const skills: CommandSummary[] = resources.skills.map((skill) => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		argumentHint: "[args]",
		source: "skill",
	}));
	return [...builtins, ...templates, ...skills];
}

/**
 * The prompt a resource command stands for. A template substitutes its arguments the way the
 * terminal does; a skill becomes its `<skill>` block. A built-in and an unknown name have no prompt.
 */
export function expandResourceCommand(
	resources: CommandResources,
	name: string,
	args: string,
): CommandExpansion {
	if (name.startsWith("skill:")) {
		const skill = resources.skills.find((candidate) => candidate.name === name.slice("skill:".length));
		if (skill === undefined) return { ok: false, problem: `Unknown skill: ${name.slice("skill:".length)}` };
		try {
			return { ok: true, prompt: skillCommandPrompt(skill, args) };
		} catch (error) {
			return { ok: false, problem: error instanceof Error ? error.message : String(error) };
		}
	}
	const template = resources.templates.find((candidate) => candidate.name === name);
	if (template === undefined) return { ok: false, problem: `Unknown command: /${name}` };
	// The terminal's own call, with the same template object: one substitution, two clients.
	const line = args.length === 0 ? `/${name}` : `/${name} ${args}`;
	return { ok: true, prompt: expandPromptTemplate(line, [template]) };
}

export function createCommandsFacet(options: CommandsServiceOptions): Facet {
	return defineFacet({
		id: "@pi/commands",
		setup(env) {
			const models = env.use(Models);
			const controller = env.use(AgentController);
			const sessionPlugins = env.use(SessionPlugins);
			let resources = loadCommandResources(options);
			// The catalogue is published once and revised whenever the session's resources are re-read.
			const state: MutableReplicatedState<CommandsState> = env.replicatedState<CommandsState>({
				revision: 1,
				commands: commandCatalog(resources),
			});
			const republish = async (context: Context): Promise<void> => {
				// A catalogue built from settings the session has not re-read would answer with the
				// previous switch, so the settings files are read again before the resources are.
				await options.settings?.reload().catch(() => undefined);
				resources = loadCommandResources(options);
				state.change(context, (draft) => {
					draft.revision += 1;
					draft.commands = commandCatalog(resources);
				});
			};
			env.provide(Commands, {
				state,
				async run(name: string, args: string, callContext: Context): Promise<CommandResult> {
					switch (name) {
						case "model": {
							const catalog = models.state.value?.catalog.availableModels ?? [];
							const exact = catalog.find(
								(model) => `${model.provider}/${model.modelId}` === args || model.modelId === args,
							);
							if (args.length === 0) {
								return failure("Give the model as provider/model, for example /model kimi-coding/kimi-for-coding.");
							}
							if (exact === undefined) return failure(`Unknown model: ${args}.`);
							await models.select({ provider: exact.provider, modelId: exact.modelId }, callContext);
							return { ok: true, note: `Selected ${exact.provider}/${exact.modelId}.` };
						}
						case "thinking": {
							const wanted = args.toLowerCase();
							const levels = await models.getThinkingLevels(callContext);
							if (!(levels as readonly string[]).includes(wanted)) {
								return failure(`Unknown thinking level "${args}". Available: ${levels.join(", ")}.`);
							}
							await models.selectThinking(wanted as ModelThinkingLevel, callContext);
							return { ok: true, note: `Thinking level: ${wanted}.` };
						}
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
							// A template or skill added since startup becomes a command with the reload.
							await republish(callContext);
							return { ok: true, note: "Reloaded this session's plugins and command resources." };
						}
						default:
							return failure(`Unknown command: /${name}`);
					}
				},
				async complete(name: string, prefix: string, callContext: Context): Promise<readonly CommandCompletion[]> {
					const normalized = prefix.toLowerCase();
					if (name === "model") {
						return (models.state.value?.catalog.availableModels ?? [])
							.filter((model) =>
								`${model.provider}/${model.modelId} ${model.name}`.toLowerCase().includes(normalized),
							)
							.map((model) => ({
								value: `${model.provider}/${model.modelId}`,
								label: model.modelId,
								description: model.provider,
							}));
					}
					if (name === "thinking") {
						return (await models.getThinkingLevels(callContext))
							.filter((level) => level.includes(normalized))
							.map((level) => ({ value: level, label: level, description: THINKING_DESCRIPTIONS[level] }));
					}
					return [];
				},
				async expand(name: string, args: string): Promise<CommandExpansion> {
					return expandResourceCommand(resources, name, args);
				},
				async refresh(context: Context): Promise<void> {
					await republish(context);
				},
			});
		},
	});
}

function failure(problem: string): CommandResult {
	return { ok: false, problem };
}
