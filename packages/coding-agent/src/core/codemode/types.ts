import type { ImageContent, Models, TextContent, TSchema, Usage } from "@amazme/ai";

export interface CodemodeToolInfo {
	readonly name: string;
	readonly description: string;
	readonly parameters: TSchema;
	readonly outputSchema?: TSchema;
}

export interface CodemodeNamespace {
	readonly name: string;
	readonly description?: string;
	readonly instructions?: string;
}

export type CodemodeModelRuntime = Pick<
	Models,
	"getModelsOfType" | "getAvailableOfType" | "getModelOfType" | "classify" | "generateImages"
>;

export interface CodemodeStoreWrites {
	set: Record<string, unknown>;
	delete: string[];
}

export interface CodemodeNestedOutcome {
	readonly toolCall: { readonly id: string };
	readonly isError: boolean;
	readonly result: {
		readonly content?: (TextContent | ImageContent)[];
		readonly value?: unknown;
	};
}

export interface CodemodeHost {
	readonly tools: readonly CodemodeToolInfo[];
	readonly models?: CodemodeModelRuntime;
	readonly store?: Readonly<Record<string, unknown>>;
	executeTool(name: string, args: unknown, signal: AbortSignal): Promise<CodemodeNestedOutcome>;
	saveStore?(writes: CodemodeStoreWrites): void | Promise<void>;
}

export interface CodemodeNestedCall {
	id: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
	cost?: number;
}

export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	fullOutputPath?: string;
}

export interface CodemodeResult {
	content: (TextContent | ImageContent)[];
	details: CodemodeToolDetails;
	usage?: Usage;
	isError?: boolean;
}

export interface CodemodeExecutionOptions {
	getToolNamespace?: (name: string) => CodemodeNamespace | undefined;
	getToolGuidelines?: () => ReadonlyMap<string, readonly string[]>;
}

export interface CodemodeLoadout {
	readonly declared: readonly CodemodeToolInfo[];
	readonly callable: readonly CodemodeToolInfo[];
	getExposure(name: string): "direct" | "model-only" | "codemode" | "deferred" | "hidden";
	getNamespace(name: string): CodemodeNamespace | undefined;
	getPromptGuidelines(name: string): readonly string[];
}

export interface CodemodeLoadoutChanges {
	descriptions: Record<string, string>;
	hiddenDeclarations: string[];
}

export interface CodemodePresentationOptions {
	mode?: "on" | "only";
	inlineBudget?: number;
	models?: boolean;
}
