export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

/**
 * Chat APIs this package can type. Other API strings stay on the unified stream options.
 * `azure-openai-responses` is Pi's distinct catalog id; its module shares the responses parser.
 */
export type KnownApi =
  | "openai-completions"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "google-vertex"
  | "bedrock-converse-stream"
  | "mistral-conversations"
  | "pi-messages"
  | "faux";

export type Api = KnownApi | (string & {});

export type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

/**
 * JSON Schema tool arguments checked by validateArguments. Standard constraints,
 * local references and x-* annotations are supported; unknown keywords and
 * malformed schemas fail closed. External references are never fetched.
 * Values are not coerced or filled with defaults.
 */
export interface JsonSchema {
  [keyword: string]: unknown;
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  properties?: Record<string, JsonSchema | boolean>;
  required?: string[];
  items?: JsonSchema | boolean;
  additionalProperties?: boolean | JsonSchema;
}

export interface TextContent {
  type: "text";
  text: string;
  /** Opaque native replay metadata, valid only for the originating model. */
  textSignature?: string;
}

/** Completions fields that may carry thinking. No other name is written back. */
export type CompletionsThinkingField = "reasoning_content" | "reasoning" | "reasoning_text";

export function isCompletionsThinkingField(value: unknown): value is CompletionsThinkingField {
  return value === "reasoning_content" || value === "reasoning" || value === "reasoning_text";
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /**
   * Field this fragment was received on. Replay writes only this name.
   * Absent when the thinking did not come from a completions field.
   */
  thinkingField?: CompletionsThinkingField;
  /** Opaque native thinking signature or redacted payload. */
  thinkingSignature?: string;
  redacted?: boolean;
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
  /** Google thought signature belonging to this function-call part. */
  thoughtSignature?: string;
}

export type UserContent = TextContent | ImageContent;
export type ToolResultContent = TextContent | ImageContent;
export type AssistantContent = TextContent | ThinkingContent | ToolCall;

export interface Usage {
  /**
   * Prompt tokens that missed the provider cache.
   * `input + cacheRead + cacheWrite` is the full prompt length for this turn.
   * An omitted cache count is not a zero: it is left out of that sum, and it is not subtracted from `input`.
   */
  input: number;
  output: number;
  totalTokens: number;
  /**
   * USD for this turn. Rates are USD per 1,000,000 tokens.
   * `input` is only the cache-miss charge.
   * Cache writes use `cost.cacheWrite`, or the input rate when that rate is unset.
   * `total` sums the known charges. A model with no price list stores zeros; `usageCost` returns null.
   * Cache-read tokens with no hit price are filled in here as 0. That zero is partial, not a confirmed
   * price: `usageCost` returns `total: null` for the same turn.
   * Chat Completions leaves `total` null when the response did not report usage.
   * That null is an empty quote, not a zero-dollar turn.
   */
  cost: { input: number; output: number; total: number | null };
  /**
   * Prompt tokens served from the provider cache.
   * Omitted when the response did not report a cache read. A reported 0 stays 0.
   * These tokens are not part of `input` and are not billed at the input rate.
   */
  cacheRead?: number;
  /**
   * Prompt tokens written into the provider cache.
   * Omitted when the response did not report a cache write. A reported 0 stays 0.
   * These tokens are not part of `input`.
   * With no cache-write rate, `usageCost` bills them at the input rate.
   */
  cacheWrite?: number;
  /**
   * Reasoning tokens already included in `output`, and in `totalTokens` when the provider sent a total.
   * They are not added again, and `usageCost` does not price them separately.
   * Google Generative AI and Vertex report this as `usageMetadata.thoughtsTokenCount`.
   * Chat Completions may report `completion_tokens_details.reasoning_tokens`. DeepSeek's schema
   * documents that breakdown of `completion_tokens`. The published deepseek-flash examples omit it.
   * Responses (OpenAI, Azure, Codex) may report `output_tokens_details.reasoning_tokens`.
   * A missing count stays unset and is not estimated. A reported 0 stays 0.
   */
  reasoning?: number;
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
  /**
   * Milliseconds to wait, taken from an HTTP error's Retry-After.
   * Clamped to 0..120_000. Omitted when the header is missing or neither delay-seconds nor an HTTP-date.
   */
  retryAfterMs?: number;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ToolResultContent[];
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

/** JSON a classifier may send as state, instructions, or criteria. */
export type ClassifierValue =
  | string
  | number
  | boolean
  | null
  | ClassifierValue[]
  | { [key: string]: ClassifierValue };

export interface ClassifierModel {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
  /** Tokens the classifier accepts. Absent when the provider did not publish a window. */
  contextWindow?: number;
  /**
   * USD per 1,000,000 tokens. Omitted when the price is unknown.
   * `input` prices cache misses. A listed 0 is a real price.
   */
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

export interface ClassifierQuestion {
  type: "choice" | "score" | "bool";
  /** Plain text or structured JSON. Omitted when the question has no instructions. */
  instructions?: ClassifierValue;
  /**
   * Choice descriptions, ordered score levels, or noul true/false descriptions.
   * Each value may itself be structured JSON.
   */
  criteria?: ClassifierValue;
}

export interface ClassifierContext {
  /** Shared by every question. A string, a JSON object, or an array. */
  state: string | ClassifierValue[] | { [key: string]: ClassifierValue };
  questions: Record<string, ClassifierQuestion>;
}

/** Wire `noul` mapped to a yes-probability. */
export interface BoolClassifierAnswer {
  type: "bool";
  probability: number;
}

export interface ChoiceClassifierAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreClassifierAnswer {
  type: "score";
  score: number;
  confidence: number;
  /** Present when the response included a probability for each level. */
  probabilities?: Record<string, number>;
  /** Present when the response included the ordered level labels. */
  legend?: Record<string, string>;
}

export type ClassifierAnswer = BoolClassifierAnswer | ChoiceClassifierAnswer | ScoreClassifierAnswer;

export interface ClassifierResult {
  api: string;
  provider: string;
  model: string;
  answers: Record<string, ClassifierAnswer>;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  /**
   * Counts from `usage.input_tokens` and `usage.output_tokens`, priced with `usageCost`.
   * Kept when the answer body does not validate.
   */
  usage?: Usage;
}

export interface ImageModel {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
}

export interface ImageRequest {
  prompt: string;
}

export interface ImageResult {
  api: string;
  provider: string;
  model: string;
  images: string[];
  stopReason: "stop" | "error";
  errorMessage?: string;
}

export interface SpecialCallOptions extends StreamOptions {
  fetch?: typeof fetch;
}

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  provider: string;
  api: TApi;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  /**
   * USD per 1,000,000 tokens. Omitted when the price is unknown; rates are not invented.
   * A listed 0 is a real price. `input` prices cache misses. `cacheRead` prices cache hits when that rate is known.
   * `cacheWrite` prices cache writes when that rate is known. An unset write rate bills those tokens at `input`.
   */
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** Per-model endpoint. A request `baseUrl` still overrides it, then the provider default. */
  baseUrl?: string;
  /**
   * When true, the model can think. `thinkingLevelMap` maps a level to the protocol parameter.
   * `null` marks that level unsupported. A missing key uses the level name.
   * Omitting the map on a reasoning model is the empty exclusion list: every level is kept.
   * Models that do not reason accept only "off" and do not send a thinking parameter.
   */
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  /**
   * Chat Completions compatibility for the thinking switch, when `reasoning_effort` alone is not that switch.
   * `"thinking"` is DeepSeek's request body. Both `deepseek-flash` and `deepseek-v4-pro` set it.
   * https://api-docs.deepseek.com/api/create-chat-completion Request: `thinking`, `reasoning_effort`.
   * https://api-docs.deepseek.com/guides/thinking_mode Thinking Mode Toggle and Effort Control.
   * `thinking.type` is `enabled` or `disabled`. `reasoning_effort` on that body is `none` | `low` | `high` | `max`.
   * `off` and `none` send `{ thinking: { type: "disabled" } }` and omit `reasoning_effort`, including an explicit effort.
   * `low` and `high` send `enabled` plus that same effort. Any other effort is an error.
   * The endpoint would rewrite `minimal`, `medium`, and `xhigh`. This client does not send the rewritten value.
   * `max` is a documented effort and is not one of `ThinkingLevel`.
   */
  thinkingSwitch?: "thinking";
}

export type CompletionsOutputTokenField = "max_completion_tokens" | "max_tokens";

export interface StreamOptions {
  telemetryContext?: import("@amazme/telemetry").TelemetryContext;
  signal?: AbortSignal;
  apiKey?: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * Output-token cap for this generation, including protocol-counted thinking tokens.
   * Omitted means the model-declared cap. The final request is still limited by that cap
   * and by the remaining context. This is not an input-compaction threshold.
   */
  maxTokens?: number;
  /** Provider defaults can be overridden for one request, regardless of its protocol. */
  baseUrl?: string;
  headers?: ProviderHeaders;
  /**
   * Provider config resolved beside the key: project, location, profile, gateway ids.
   * A Bedrock request may also carry the signing keys for that one call. Those keys are not stored.
   */
  env?: Record<string, string | undefined>;
  /** Optional conversation id. OpenCode copies it onto `x-opencode-session` beside the request. */
  sessionId?: string;
  /**
   * Where the registry resolved `apiKey`. Completions 401 errors name `store` or `env`.
   * The key itself is never copied into that error text.
   */
  keySource?: AuthResult["source"];
}

export interface ProviderHeaders {
  [name: string]: string;
}

/** Protocol options for `api: "openai-completions"`. */
export interface OpenAICompletionsOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /**
   * The one body field that carries the output cap.
   * Official OpenAI uses `max_completion_tokens`. A compatible endpoint may set `max_tokens`.
   */
  outputTokenField?: CompletionsOutputTokenField;
}

export interface OpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

export interface AzureOpenAIResponsesOptions extends OpenAIResponsesOptions {
  azureApiVersion?: string;
  azureResourceName?: string;
  azureBaseUrl?: string;
  azureDeploymentName?: string;
}

export type OpenAICodexResponsesOptions = OpenAIResponsesOptions;
export type AnthropicMessagesOptions = StreamOptions;
export type GoogleGenerativeAIOptions = StreamOptions;

export interface GoogleVertexOptions extends StreamOptions {
  project?: string;
  location?: string;
}

export interface BedrockOptions extends StreamOptions {
  region?: string;
}

export type MistralOptions = StreamOptions;
export type PiMessagesOptions = StreamOptions;

export interface ApiOptionsMap {
  "openai-completions": OpenAICompletionsOptions;
  "openai-responses": OpenAIResponsesOptions;
  "azure-openai-responses": AzureOpenAIResponsesOptions;
  "openai-codex-responses": OpenAICodexResponsesOptions;
  "anthropic-messages": AnthropicMessagesOptions;
  "google-generative-ai": GoogleGenerativeAIOptions;
  "google-vertex": GoogleVertexOptions;
  "bedrock-converse-stream": BedrockOptions;
  "mistral-conversations": MistralOptions;
  "pi-messages": PiMessagesOptions;
  faux: StreamOptions;
}

/** Known APIs use their own options. Any other API stays on the unified options. */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap ? ApiOptionsMap[TApi] : StreamOptions;

export type AssistantEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: StopReason; message: AssistantMessage }
  | { type: "error"; error: AssistantMessage };

/**
 * Recovery record for one stream. `contentIndex` is assigned when the block first
 * appears and is not a server tool index. A stop frame does not settle the response.
 */
export type AssistantFrame =
  | { type: "text_delta"; contentIndex: number; delta: string; textSignature?: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string; thinkingField?: CompletionsThinkingField; thinkingSignature?: string; redacted?: boolean }
  | { type: "toolcall"; contentIndex: number; id: string; name: string; arguments: unknown; thoughtSignature?: string }
  | { type: "stop"; stopReason: StopReason; errorMessage?: string };

export interface AuthResult {
  apiKey?: string;
  source: "request" | "store" | "env" | "ambient" | "oauth";
  headers?: ProviderHeaders;
  baseUrl?: string;
  env?: Record<string, string>;
}

export interface ApiKeyCredential {
  type: "api_key";
  /** Absent when the credential only carries non-secret env such as an AWS profile or a project id. */
  key?: string;
  env?: Record<string, string>;
}

/** OAuth token. `refresh` may be empty when the provider issues a non-expiring key (OpenRouter). */
export interface OAuthCredential {
  type: "oauth";
  refresh: string;
  access: string;
  /** Epoch milliseconds. Refresh runs before a request when this is within 60 seconds. */
  expires: number;
  accountId?: string;
  clientId?: string;
}

export type Credential = ApiKeyCredential | OAuthCredential;

export interface CredentialStore {
  get(providerId: string): Promise<Credential | undefined>;
  set(providerId: string, credential: Credential): Promise<void>;
  delete(providerId: string): Promise<void>;
  /**
   * Serialized read-modify-write for one provider. Return undefined to leave the entry unchanged.
   * A rejection writes nothing, including when a refresh fails halfway.
   */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>;
}
