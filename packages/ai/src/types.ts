export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface JsonSchema {
  type?: string;
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

export interface Model {
  id: string;
  name: string;
  provider: string;
  api: string;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number };
}

export interface StreamOptions {
  telemetryContext?: import("@amazme/telemetry").TelemetryContext;
  signal?: AbortSignal;
  apiKey?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ProviderHeaders {
  [name: string]: string;
}

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
