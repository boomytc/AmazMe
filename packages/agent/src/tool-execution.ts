import { validateArguments, type ToolResultMessage } from "@amazme/ai";
import { createTypedSpanStarter, type TelemetryContext } from "@amazme/telemetry";
import { agentTelemetrySchema } from "./telemetry.ts";
import type { AgentEvent, AgentTool, ToolResult, ToolExecutionMode } from "./types.ts";

type Emit = (event: AgentEvent) => Promise<void> | void;
type Call = { id: string; name: string; arguments: unknown };

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
      await Promise.all(pending);
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
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
  const sequential = mode === "sequential" || calls.some((call) => tools.find((tool) => tool.name === call.name)?.executionMode === "sequential");
  if (sequential) return runSequential(calls, tools, signal, emit, telemetryContext);
  return runParallel(calls, tools, signal, emit, telemetryContext);
}

async function runSequential(
  calls: Call[],
  tools: AgentTool[],
  signal: AbortSignal,
  emit: Emit,
  telemetryContext: TelemetryContext | undefined,
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
  const messages: ToolResultMessage[] = [];
  const flags: boolean[] = [];
  for (const call of calls) {
    if (signal.aborted) break;
    const outcome = await tracked(call, telemetryContext, signal, (span) => settleCall(call, tools, signal, emit, span, false));
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
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
  const batch: Array<{ call: Call; cancelled: boolean }> = [];
  for (const call of calls) {
    if (signal.aborted) break;
    await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    const cancelled = signal.aborted;
    batch.push({ call, cancelled });
    if (cancelled) break;
  }
  const messages = new Array<ToolResultMessage>(batch.length);
  const flags = new Array<boolean>(batch.length).fill(false);
  await Promise.all(batch.map(async ({ call, cancelled }, index) => {
    const outcome = await tracked(call, telemetryContext, signal, (span) => settleCall(call, tools, signal, emit, span, true, cancelled));
    messages[index] = outcome.message;
    flags[index] = outcome.terminate;
  }));
  return { messages, terminate: flags.length > 0 && flags.every(Boolean) };
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
  started: boolean,
  cancelled = false,
): Promise<{ message: ToolResultMessage; terminate: boolean }> {
  if (!started) {
    await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    if (signal.aborted) return finish(call, errorResult("cancelled"), emit);
  } else if (cancelled) {
    return finish(call, errorResult("cancelled"), emit);
  }
  const tool = tools.find((item) => item.name === call.name);
  const invalid = tool ? validateArguments(tool.parameters, call.arguments) : `Unknown tool: ${call.name}`;
  if (!tool || invalid) return finish(call, errorResult(invalid || "unavailable"), emit);
  const gate = createUpdateGate((partial) => emit({ type: "tool_execution_update", toolCallId: call.id, partial }));
  let result: ToolResult;
  try {
    result = await tool.execute(call.arguments, {
      signal,
      telemetryContext: span,
      onUpdate: (partial) => gate.accept(partial),
    });
  } catch (error) {
    result = errorResult(error instanceof Error ? error.message : String(error));
  } finally {
    gate.close();
  }
  await gate.finished();
  return finish(call, result, emit);
}

async function finish(
  call: Call,
  result: ToolResult,
  emit: Emit,
): Promise<{ message: ToolResultMessage; terminate: boolean }> {
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    isError: result.isError === true,
    timestamp: Date.now(),
  };
  await emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: message, isError: message.isError });
  return { message, terminate: result.terminate === true };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
