import { type Context, defineService, type ReplicatedState } from "@amazme/chord";
import type { AuthType, ModelThinkingLevel } from "@amazme/ai";
import type { ProviderAuthState } from "../../core/provider-login.ts";
import type { ModelScopeConfig } from "../../core/model-scope.ts";

export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface ModelSummary extends ModelRef {
	name: string;
	reasoning: boolean;
	/** The model's context window, so a presentation can show occupancy without a second catalog. */
	contextWindow: number;
}

export interface ModelsState {
	catalog: {
		revision: number;
		availableModels: ModelSummary[];
		/** null includes all catalog models; [] deliberately presents an empty list. */
		enabledModelIds: string[] | null;
	};
	/** Model and thinking level of the currently selected conversation. */
	configuration: {
		model: ModelRef | null;
		thinkingLevel: ModelThinkingLevel;
	};
	refresh: { status: "idle" | "refreshing" | "done" } | { status: "warning"; errors: Record<string, string> };
	/** Transient provider interaction metadata, never submitted credentials or tokens. */
	authentication: ProviderAuthState | null;
}

export interface Models {
	readonly state: ReplicatedState<ModelsState>;
	cycleThinking(context: Context): Promise<void>;
	cycleModel(direction: "forward" | "backward", context: Context): Promise<void>;
	getModelScope(context: Context): Promise<ModelScopeConfig>;
	setModelScope(models: readonly string[] | null, persist: boolean, context: Context): Promise<void>;
	saveDefaults(model: ModelRef, thinking: ModelThinkingLevel, context: Context): Promise<void>;
	getThinkingLevels(context: Context): Promise<ModelThinkingLevel[]>;
	refresh(context: Context): Promise<void>;
	select(model: ModelRef, context: Context): Promise<void>;
	selectThinking(level: ModelThinkingLevel, context: Context): Promise<void>;
	startLogin(provider: string, method: AuthType, context: Context): Promise<string>;
	submitLoginPrompt(id: string, promptId: string, value: string, context: Context): Promise<boolean>;
	cancelLogin(id: string, context: Context): Promise<boolean>;
	logout(provider: string, context: Context): Promise<void>;
}

export const Models = defineService<Models>("amazme.models");

export function selectableModels(state: ModelsState | undefined): ModelSummary[] {
	if (!state) return [];
	const { availableModels, enabledModelIds } = state.catalog;
	return enabledModelIds === null ? availableModels
		: enabledModelIds.flatMap((id) => availableModels.filter((model) => `${model.provider}/${model.modelId}` === id));
}
