import { validateArguments, type ToolResultMessage } from "@amazme/ai";
import { createTypedSpanStarter, type TelemetryContext } from "@amazme/telemetry";
import { agentTelemetrySchema } from "./telemetry.ts";
import type {
  AfterToolCall,
  AfterToolCallUpdate,
  AgentEvent,
  AgentTool,
  BeforeToolCall,
  ToolExecutionMode,
  ToolResult,
} from "./types.ts";

type Emit = (event: AgentEvent) => Promise<void> | void;
type Call = { id: string; name: string; arguments: unknown };

interface ToolCallCallbacks {
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
}

interface UpdateGate {
  accept(partial: string): void;
  close(): void;
  finished(): Promise<void>;
}

function createUpdateGate(publish: (partial: string) => Promise<void> | void): UpdateGate {
  let accepting = true;
  const pending: Promise<void>[] = [];
  return {
    accept(partial: string): void {
      if (!accepting) return;
      const task = Promise.resolve()
        .then(() => publish(partial))
        .then(() => undefined);
      pending.push(task);
      void task.catch(() => undefined);
    },
    close(): void {
      accepting = false;
    },
    async finished(): Promise<void> {
      accepting = false;
      await settleAll(pending);
    },
  };
}

export async function executeAgentTools(
  calls: Call[],
  tools: AgentTool[],
  mode: ToolExecutionMode,
  signal: AbortSignal,
  emit: Emit,
  telemetryContext: TelemetryContext | undefined,
  callbacks: ToolCallCallbacks,
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
  const sequential = mode === "sequential" || calls.some((call) => tools.find((tool) => tool.name === call.name)?.executionMode === "sequential");
  if (sequential) return runSequential(calls, tools, signal, emit, telemetryContext, callbacks);
  return runParallel(calls, tools, signal, emit, telemetryContext, callbacks);
}

async function runSequential(
  calls: Call[],
  tools: AgentTool[],
  signal: AbortSignal,
  emit: Emit,
  telemetryContext: TelemetryContext | undefined,
  callbacks: ToolCallCallbacks,
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
  const messages: ToolResultMessage[] = [];
  const flags: boolean[] = [];
  for (const call of calls) {
    const outcome = await tracked(call, telemetryContext, signal, (span) => settleCall(call, tools, signal, emit, span, callbacks));
    messages.push(outcome.message);
    flags.push(outcome.terminate);
  }
  return { messages, terminate: flags.length > 0 && flags.every(Boolean) };
}

async function runParallel(
  calls: Call[],
  tools: AgentTool[],
  signal: AbortSignal,
  emit: Emit,
  telemetryContext: TelemetryContext | undefined,
  callbacks: ToolCallCallbacks,
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
  const outcomes = await settleAll(calls.map((call) =>
    tracked(call, telemetryContext, signal, (span) => settleCall(call, tools, signal, emit, span, callbacks))));
  return { messages: outcomes.map((outcome) => outcome.message), terminate: outcomes.length > 0 && outcomes.every((outcome) => outcome.terminate) };
}

function tracked(
  call: Call,
  telemetryContext: TelemetryContext | undefined,
  signal: AbortSignal,
  run: (span: TelemetryContext) => Promise<{ message: ToolResultMessage; terminate: boolean }>,
): Promise<{ message: ToolResultMessage; terminate: boolean }> {
  return createTypedSpanStarter(telemetryContext, [agentTelemetrySchema])(
    "amazme.tool.execute",
    { tool: call.name, toolCallId: call.id },
    async (span) => {
      const outcome = await run(span);
      if (outcome.message.isError || signal.aborted) span.setStatus({ status: "error" });
      return outcome;
    });
}

async function settleCall(
  call: Call,
  tools: AgentTool[],
  signal: AbortSignal,
  emit: Emit,
  span: TelemetryContext,
  callbacks: ToolCallCallbacks,
): Promise<{ message: ToolResultMessage; terminate: boolean }> {
  if (signal.aborted) return outcomeFor(call, errorResult("cancelled"));
  await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
  if (signal.aborted) return finish(call, errorResult("cancelled"), emit);
  const tool = tools.find((item) => item.name === call.name);
  const invalid = tool ? validateArguments(tool.parameters, call.arguments) : `Unknown tool: ${call.name}`;
  if (!tool || invalid) return finish(call, errorResult(invalid || "unavailable"), emit);
  if (signal.aborted) return finish(call, errorResult("cancelled"), emit);
  const decision = await callbacks.beforeToolCall?.(
    { toolCallId: call.id, toolName: call.name, args: call.arguments },
    signal,
  );
  if (decision?.action === "block") return finish(call, errorResult(decision.reason), emit);
  if (signal.aborted) return finish(call, errorResult("cancelled"), emit);
  const gate = createUpdateGate((partial) => emit({ type: "tool_execution_update", toolCallId: call.id, partial }));
  let result: ToolResult;
  let executed = false;
  try {
    result = await tool.execute(call.arguments, {
      signal,
      telemetryContext: span,
      onUpdate: (partial) => gate.accept(partial),
    });
    executed = true;
  } catch (error) {
    result = errorResult(error instanceof Error ? error.message : String(error));
  } finally {
    gate.close();
  }
  await gate.finished();
  if (executed) {
    const update = await callbacks.afterToolCall?.(
      { toolCallId: call.id, toolName: call.name, args: call.arguments, result },
      signal,
    );
    result = applyAfter(result, update);
  }
  return finish(call, result, emit);
}

async function finish(
  call: Call,
  result: ToolResult,
  emit: Emit,
): Promise<{ message: ToolResultMessage; terminate: boolean }> {
  const outcome = outcomeFor(call, result);
  const { message } = outcome;
  await emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: message, isError: message.isError });
  return outcome;
}

function outcomeFor(call: Call, result: ToolResult): { message: ToolResultMessage; terminate: boolean } {
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    isError: result.isError === true,
    timestamp: Date.now(),
  };
  return { message, terminate: result.terminate === true };
}

async function settleAll<T>(tasks: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(tasks);
  return settled.map((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  });
}

function applyAfter(result: ToolResult, update: AfterToolCallUpdate | undefined): ToolResult {
  if (!update) return result;
  const next: ToolResult = { content: update.content ?? result.content };
  const isError = update.isError !== undefined ? update.isError : result.isError;
  const terminate = update.terminate !== undefined ? update.terminate : result.terminate;
  if (isError !== undefined) next.isError = isError;
  if (terminate !== undefined) next.terminate = terminate;
  return next;
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
