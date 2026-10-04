import type { AssistantEventStream, Context, JsonSchema, Message, Model, StreamOptions, ToolResultContent } from "@amazme/ai";
import type { TelemetryContext } from "@amazme/telemetry";

export type QueueMode = "all" | "one-at-a-time";
export type ToolExecutionMode = "parallel" | "sequential";
export type ReplayPolicy = "safe" | "never";

export interface CustomMessage {
  role: "custom";
  name: string;
  content: string;
  timestamp: number;
}

export type HarnessMessage = Message | CustomMessage;

export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
  terminate?: boolean;
}

export interface ToolContext {
  telemetryContext?: TelemetryContext;
  signal: AbortSignal;
  onUpdate?: (partial: string, options?: { checkpoint?: boolean }) => void;
}

/** Executable durable tool. Replay and checkpoint semantics belong to this runtime. */
export interface HarnessTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  replay?: ReplayPolicy;
  executionMode?: ToolExecutionMode;
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

/** The model capabilities used by the runtime; no catalog mutation or credential store is required. */
export interface HarnessModels {
  readonly telemetryContext?: TelemetryContext;
  getModel(providerId: string, modelId: string): Model | undefined;
  streamSimple(model: Model, context: Context, options?: StreamOptions): AssistantEventStream;
}
