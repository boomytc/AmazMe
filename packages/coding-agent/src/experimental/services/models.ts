import { type Context, defineService, type ReplicatedState } from "@amazme/chord";
import type { ModelThinkingLevel } from "@amazme/ai";

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
	};
	configuration: {
		model: ModelRef | null;
		thinkingLevel: ModelThinkingLevel;
	};
	refresh: { status: "idle" | "refreshing" | "done" } | { status: "warning"; errors: Record<string, string> };
}

export interface Models {
	readonly state: ReplicatedState<ModelsState>;
	cycleThinking(context: Context): Promise<void>;
	getThinkingLevels(context: Context): Promise<ModelThinkingLevel[]>;
	refresh(context: Context): Promise<void>;
	select(model: ModelRef, context: Context): Promise<void>;
	selectThinking(level: ModelThinkingLevel, context: Context): Promise<void>;
}

export const Models = defineService<Models>("amazme.models");
