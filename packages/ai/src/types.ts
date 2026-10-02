export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

/** Chat APIs this package can type. Other API strings stay on the unified stream options. */
export type KnownApi = "openai-completions" | "faux";

export type Api = KnownApi | (string & {});

export type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

/**
 * Tool-argument subset checked by validateArguments.
 * An object may declare properties, required, and boolean additionalProperties.
 * An array may declare items. Every other JSON Schema keyword is rejected.
 * Omitted additionalProperties allows unknown fields. An array without items allows any element.
 * Values are not coerced.
 */
export interface JsonSchema {
  type: JsonSchemaType;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ImageContent {
  type: "image";
  mimeType: string;
  data: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

export type UserContent = TextContent | ImageContent;
export type AssistantContent = TextContent | ThinkingContent | ToolCall;

export interface Usage {
  input: number;
  output: number;
  totalTokens: number;
  cost: { input: number; output: number; total: number };
}

export interface SystemMessage {
  role: "system";
  content: string;
  timestamp: number;
  toolsAdded?: string[];
  toolsRemoved?: string[];
}

export interface UserMessage {
  role: "user";
  content: string | UserContent[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  retryable?: boolean;
  overflow?: boolean;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  isError: boolean;
  timestamp: number;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: ToolDefinition[];
}

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  provider: string;
  api: TApi;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  /** USD per 1,000,000 tokens. Absent knowledge stays unset; rates are not invented. */
  cost: { input: number; output: number };
  /**
   * When true, the model can think. `thinkingLevelMap` maps a level to the protocol parameter.
   * `null` marks that level unsupported. A missing key uses the level name.
   * Models that do not reason accept only "off" and do not send a thinking parameter.
   */
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface StreamOptions {
  telemetryContext?: import("@amazme/telemetry").TelemetryContext;
  signal?: AbortSignal;
  apiKey?: string;
  thinkingLevel?: ThinkingLevel;
  /** Provider defaults can be overridden for one request, regardless of its protocol. */
  baseUrl?: string;
  headers?: ProviderHeaders;
}

export interface ProviderHeaders {
  [name: string]: string;
}

/** Protocol options for `api: "openai-completions"`. */
export interface OpenAICompletionsOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

export interface ApiOptionsMap {
  "openai-completions": OpenAICompletionsOptions;
  faux: StreamOptions;
}

/** Known APIs use their own options. Any other API stays on the unified options. */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap ? ApiOptionsMap[TApi] : StreamOptions;

export type AssistantEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string; partial: AssistantMessage }
  | { type: "text_end"; partial: AssistantMessage }
  | { type: "thinking_start"; partial: AssistantMessage }
  | { type: "thinking_delta"; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: StopReason; message: AssistantMessage }
  | { type: "error"; error: AssistantMessage };

export interface AssistantFrame {
  type: "text_delta" | "thinking_delta" | "toolcall" | "stop";
  delta?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  stopReason?: StopReason;
  errorMessage?: string;
}

export interface AuthResult {
  apiKey: string;
  source: "request" | "store" | "env" | "ambient";
}

export interface ApiKeyCredential {
  type: "api_key";
  key: string;
}

export type Credential = ApiKeyCredential;

export interface CredentialStore {
  get(providerId: string): Promise<Credential | undefined>;
  set(providerId: string, credential: Credential): Promise<void>;
  delete(providerId: string): Promise<void>;
}
