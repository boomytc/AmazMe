import type {
  AssistantEvent,
  AssistantEventStream,
  AssistantMessage,
  Context,
  JsonSchema,
  Message,
  Model,
  StreamOptions,
  TextContent,
  ThinkingLevel,
  ToolResultMessage,
} from "@amazme/ai";

/**
 * One model call. `Models.streamSimple` matches this shape, so callers can pass
 * `models.streamSimple.bind(models)`.
 * A synchronous event stream or a promise of one are both valid.
 * Request failures belong in the stream's terminal event. A throw or a rejected
 * promise fails the turn and must still leave the agent idle.
 */
export type StreamFn = (
  model: Model,
  context: Context,
  options?: StreamOptions,
) => AssistantEventStream | Promise<AssistantEventStream>;

export type QueueMode = "all" | "one-at-a-time";
export type ToolExecutionMode = "parallel" | "sequential";
export type ReplayPolicy = "safe" | "never";

export interface CustomMessage {
  role: "custom";
  name: string;
  content: string;
  timestamp: number;
}

export type AgentMessage = Message | CustomMessage;

export interface ToolResult {
  content: TextContent[];
  isError?: boolean;
  terminate?: boolean;
}

export interface ToolContext {
  telemetryContext?: import("@amazme/telemetry").TelemetryContext;
  signal: AbortSignal;
  onUpdate?: (partial: string, options?: { checkpoint?: boolean }) => void;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  replay?: ReplayPolicy;
  executionMode?: ToolExecutionMode;
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AssistantMessage; assistantMessageEvent: AssistantEvent; delta: string }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; partial: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResultMessage; isError: boolean };

export interface AgentState {
  systemPrompt: string;
  model: Model;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
}

export interface PrepareRequestInput {
  messages: AgentMessage[];
  model: Model;
  thinkingLevel: ThinkingLevel;
}

export interface PrepareRequestUpdate {
  messages?: AgentMessage[];
  model?: Model;
  thinkingLevel?: ThinkingLevel;
}

export interface FinishTurnInput {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  messages: AgentMessage[];
}

export type FinishTurnDecision = { action: "end" } | { action: "continue" };

export type { AssistantMessage, Model, TextContent, ThinkingLevel, ToolResultMessage };
