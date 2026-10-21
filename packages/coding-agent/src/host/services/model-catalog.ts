import { remoteService } from "@amazme/protocol/services";
import type { Context, ReplicatedState } from "@amazme/chord";
import type { AuthType, ModelThinkingLevel } from "@amazme/ai";
import type { ProviderAuthState } from "../../core/provider-login.ts";
import type { ModelRef, ModelsState, ModelSummary } from "./models.ts";

export interface ModelSelection {
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
}
export interface CatalogModel extends ModelSummary {
	readonly levels: ModelThinkingLevel[];
	readonly available: boolean;
}
export interface ProviderConnection {
	readonly id: string;
	readonly name: string;
	readonly configured: boolean;
	readonly source?: string;
	readonly baseUrl: string;
	readonly api: string;
	readonly modelCount: number;
	readonly custom: boolean;
	readonly modelIds?: string[];
	readonly verification: {
		readonly status: "idle" | "checking" | "success" | "error";
		readonly checkedAt?: number;
		readonly modelId?: string;
	};
}
export interface ProviderConfiguration {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly api: string;
	/** Custom model IDs, one entry per model; omitted preserves the catalog. */
	readonly modelIds?: readonly string[];
}
export interface ModelCatalogState {
	readonly revision: number;
	readonly models: CatalogModel[];
	readonly providers: ProviderConnection[];
	readonly authentication: ProviderAuthState;
	readonly enabledModelIds: string[] | null;
	readonly defaults: ModelSelection | null;
	readonly refresh: ModelsState["refresh"];
	readonly error: string | null;
}
/** Public catalog and credentials outlive the page's current conversation. Secrets never enter state. */
export interface ModelCatalog {
	readonly state: ReplicatedState<ModelCatalogState>;
	resolve(projectId: string | null, context: Context): Promise<ModelsState>;
	models(provider: string, context: Context): Promise<CatalogModel[]>;
	refresh(context: Context): Promise<void>;
	configureProvider(input: ProviderConfiguration, context: Context): Promise<void>;
	setModelEnabled(model: ModelRef, enabled: boolean, context: Context): Promise<void>;
	saveDefaults(selection: ModelSelection, context: Context): Promise<void>;
	testConnection(model: ModelRef, context: Context): Promise<void>;
	/** `modelId` null checks every model of the provider. Failures name the models that did not answer. */
	testModels(provider: string, modelId: string | null, context: Context): Promise<{ ok: boolean; failed: string[] }>;
	startLogin(provider: string, method: AuthType, context: Context): Promise<string>;
	submitLoginPrompt(id: string, promptId: string, value: string, context: Context): Promise<boolean>;
	cancelLogin(id: string, context: Context): Promise<boolean>;
	logout(provider: string, context: Context): Promise<void>;
}
export const ModelCatalog = remoteService<ModelCatalog>("amazme.model-catalog", { resolve: 1, models: 1, refresh: 0, configureProvider: 1, setModelEnabled: 2, saveDefaults: 1, testConnection: 1, testModels: 2, startLogin: 2, submitLoginPrompt: 3, cancelLogin: 1, logout: 1 }, ["state"]);
