import { activationFacet, disposeResources } from "@amazme/protocol/services";
import { type Facet, type JsonValue } from "@amazme/chord";
import type { ModelThinkingLevel } from "@amazme/ai";
import type { Context } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { AgentController } from "../../core/plugins/agent-controller.ts";
import { type ModelSummary, Models, type Models as ModelsService, selectableModels } from "./models.ts";
import { PresentationPlugins } from "./plugins.ts";
import { Commands } from "./commands.ts";
import { PresentationUI } from "./presentation-ui.ts";
import { type SlashCommandContribution, SlashCommands } from "../../core/plugins/slash-commands.ts";

const THINKING_DESCRIPTIONS: Record<ModelThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning",
	low: "Light reasoning",
	medium: "Moderate reasoning",
	high: "Deep reasoning",
	xhigh: "Extra-high reasoning",
	max: "Maximum reasoning" };

export function createBuiltInSlashCommandsFacet(options: {
	reloadPresentationPlugins(data: JsonValue): Promise<void>;
	authenticate?(mode: "login" | "logout", provider: string | undefined, context: Context): Promise<void>;
}): Facet {
	return activationFacet(
		"@pi/slash-commands-builtin",
		[SlashCommands, Models, AgentController, PresentationUI, PresentationPlugins, Commands],
		async (services) => {
			const disposers: Array<() => void | Promise<void>> = [];
			try {
				const commands = services.get(SlashCommands);
				const models = services.get(Models);
				const controller = services.get(AgentController);
				const ui = services.get(PresentationUI);
				const presentationPlugins = services.get(PresentationPlugins);
				const catalog = services.get(Commands);
				await (() => {
					if (options.authenticate)
						for (const mode of ["login", "logout"] as const)
							disposers.push(
								commands.replace({
									name: mode,
									description: mode === "login" ? "Sign in to a model provider" : "Remove saved provider credentials",
									argumentHint: "[provider]",
									getArgumentCompletions(prefix) {
										return (models.state.value?.authentication?.providers ?? [])
											.filter(
												(provider) =>
													provider.id.includes(prefix) &&
													(mode === "login" ? provider.methods.length > 0 : provider.configured),
											)
											.map((provider) => ({ value: provider.id, label: provider.name }));
									},
									run: (args, context) => options.authenticate!(mode, args || undefined, context).then(() => undefined),
								}),
							);
					disposers.push(commands.replace(modelCommand(models, ui)));
					disposers.push(commands.replace(thinkingCommand(models, ui)));
					disposers.push(commands.replace(compactCommand(controller, ui)));
					disposers.push(
						commands.replace({
							name: "reload",
							description: "Reload server-selected plugins",
							async run(_args, context) {
								ui.showStatus("Reloading plugins…", context);
								const data = await presentationPlugins.reload(context);
								const result = await catalog.run("reload", "", context);
								if (!result.ok) throw new Error(result.problem);
								await options.reloadPresentationPlugins(data);
								ui.showStatus("Reloaded plugins and resources.", context);
								return undefined;
							},
						}),
					);
				})();

				return () => disposeResources(disposers);
			} catch (error) {
				await disposeResources(disposers);
				throw error;
			}
		},
	);
}

function modelCommand(models: ModelsService, ui: PresentationUI): SlashCommandContribution {
	return {
		name: "model",
		description: "Select model",
		argumentHint: "<provider/model>",
		getArgumentCompletions(prefix) {
			const normalized = prefix.toLowerCase();
			return selectableModels(models.state.value)
				.filter((model) => `${model.provider}/${model.modelId} ${model.name}`.toLowerCase().includes(normalized))
				.map((model) => ({
					value: `${model.provider}/${model.modelId}`,
					label: model.modelId,
					description: model.provider }));
		},
		async run(args, context) {
			const state = models.state.value;
			if (state === undefined) throw new Error("Models service is not ready");
			let selected = exactModel(state.catalog.availableModels, args);
			if (args.length > 0 && selected === undefined) {
				throw new Error(`Unknown model: ${args}`);
			}
			if (selected === undefined) {
				const choices = selectableModels(state);
				if (choices.length === 0) {
					ui.showStatus(state.catalog.availableModels.length === 0
						? "No configured models. Use /login to connect a provider."
						: "No models are enabled. Use /scoped_models to change the list. The active model is unchanged.", context);
					return undefined;
				}
				const value = await ui.select(
					"Select model:",
					choices.map((model) => ({
						value: `${model.provider}/${model.modelId}`,
						label:
							state.configuration.model?.provider === model.provider &&
							state.configuration.model.modelId === model.modelId
								? `${model.name} (selected)`
								: model.name,
						description: `${model.provider}/${model.modelId}` })),
					state.configuration.model === null
						? undefined
						: `${state.configuration.model.provider}/${state.configuration.model.modelId}`,
					context,
				);
				if (value === undefined) return undefined;
				selected = exactModel(state.catalog.availableModels, value);
				if (selected === undefined) throw new Error(`Unknown model: ${value}`);
			}
			await models.select({ provider: selected.provider, modelId: selected.modelId }, context);
			ui.showStatus(`Selected ${selected.provider}/${selected.modelId}.`, context);
			return undefined;
		} };
}

function thinkingCommand(models: ModelsService, ui: PresentationUI): SlashCommandContribution {
	return {
		name: "thinking",
		description: "Set thinking level",
		argumentHint: "<level>",
		async getArgumentCompletions(prefix) {
			const levels = await models.getThinkingLevels(BACKGROUND_CONTEXT);
			return levels.filter((level) => level.includes(prefix.toLowerCase()))
				.map((level) => ({ value: level, label: level, description: THINKING_DESCRIPTIONS[level] }));
		},
		async run(args, context) {
			const levels = await models.getThinkingLevels(context);
			let selected = levels.find((level) => level === args.toLowerCase());
			if (args.length > 0 && selected === undefined) {
				throw new Error(`Unknown thinking level "${args}". Available levels: ${levels.join(", ")}.`);
			}
			if (selected === undefined) {
				const value = await ui.select(
					"Select thinking level:",
					levels.map((level) => ({
						value: level,
						label: models.state.value?.configuration.thinkingLevel === level ? `${level} (selected)` : level,
						description: THINKING_DESCRIPTIONS[level] })),
					models.state.value?.configuration.thinkingLevel,
					context,
				);
				if (value === undefined) return undefined;
				selected = levels.find((level) => level === value);
				if (selected === undefined) throw new Error(`Unknown thinking level: ${value}`);
			}
			await models.selectThinking(selected, context);
			ui.showStatus(`Thinking level: ${selected}.`, context);
			return undefined;
		} };
}

function compactCommand(controller: AgentController, ui: PresentationUI): SlashCommandContribution {
	return {
		name: "compact",
		description: "Manually compact the session context",
		argumentHint: "<instructions>",
		run(args, context) {
			ui.showStatus("Compacting…", context);
			return controller.compact({ customInstructions: args.length === 0 ? null : args }, context);
		} };
}

function exactModel(models: readonly ModelSummary[], query: string): ModelSummary | undefined {
	if (query.length === 0) return undefined;
	const normalized = query.toLowerCase();
	const matches = models.filter(
		(model) =>
			`${model.provider}/${model.modelId}`.toLowerCase() === normalized ||
			model.modelId.toLowerCase() === normalized,
	);
	return matches.length === 1 ? matches[0] : undefined;
}
