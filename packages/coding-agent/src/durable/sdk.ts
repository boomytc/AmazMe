import type { AssistantMessage, ImageContent, Message, ModelThinkingLevel } from "@amazme/ai";
import type { AgentEvent, ModelRef } from "@amazme/durable";

export interface DurableSessionOptions {
	readonly cwd?: string;
	readonly modelRuntime?: unknown;
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: ModelThinkingLevel | string;
	readonly tools?: readonly string[];
	readonly noTools?: boolean;
	readonly systemPrompt?: string;
	readonly noExtensions?: boolean;
	readonly noSession?: boolean;
	readonly initialMessage?: string;
	readonly initialImages?: readonly ImageContent[];
}

export interface DurablePromptOptions {
	readonly images?: readonly ImageContent[];
}

/** Shape kept so existing type imports compile. The function never returns a session. */
export interface DurableSession {
	readonly id: string;
	readonly conversationId: string;
	readonly model: ModelRef | undefined;
	readonly thinkingLevel: ModelThinkingLevel | undefined;
	prompt(text: string, options?: DurablePromptOptions): Promise<AssistantMessage | undefined>;
	steer(text: string, options?: DurablePromptOptions): Promise<AssistantMessage | undefined>;
	followUp(text: string, options?: DurablePromptOptions): Promise<AssistantMessage | undefined>;
	abort(): Promise<void>;
	compact(instructions?: string): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	setThinkingLevel(level: ModelThinkingLevel): Promise<void>;
	messages(): readonly Message[];
	subscribe(listener: (events: readonly AgentEvent[]) => void): () => void;
	dispose(): Promise<void>;
}

export async function createDurableSession(_options: DurableSessionOptions = {}): Promise<DurableSession> {
	throw new Error("old_session_runtime_removed\n会话由 Python 后端提供，不再创建旧 durable 会话");
}
