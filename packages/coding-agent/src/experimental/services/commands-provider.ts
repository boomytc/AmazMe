import { type Context, defineFacet, type Facet } from "@amazme/chord";
import type { ModelThinkingLevel } from "@amazme/ai";
import { AgentController } from "./agent-controller.ts";
import { Commands, type CommandCompletion, type CommandResult, type CommandSummary, type CommandsState } from "./commands.ts";
import { Models } from "./models.ts";
import { SessionPlugins } from "./plugins.ts";

/**
 * The session's commands, as a web presentation needs them: the four built-ins the TUI's registry
 * carries, with textual arguments instead of dialogs. A presentation supplies the interaction (the
 * composer's palette); the host supplies the effect, and every effect goes through the session
 * services the page already depends on.
 */
const COMMANDS: readonly CommandSummary[] = [
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

function failure(problem: string): CommandResult {
	return { ok: false, problem };
}

export function createCommandsFacet(): Facet {
	return defineFacet({
		id: "@pi/commands",
		setup(env) {
			const models = env.use(Models);
			const controller = env.use(AgentController);
			const sessionPlugins = env.use(SessionPlugins);
			// The catalogue is fixed, so its state is published once and never revised.
			const state = env.replicatedState<CommandsState>({ revision: 1, commands: [...COMMANDS] });
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
							return { ok: true, note: "Reloaded this session's plugins." };
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
			});
		},
	});
}
