import {
  type AssistantEventStream,
  type AssistantMessage,
  findToolCalls,
  type Message,
  type Model,
  type StreamOptions,
  type SystemMessage,
  type ToolResultMessage,
} from "@amazme/ai";
import type { TelemetryContext } from "@amazme/telemetry";
import { applyAfter, executeAgentTools } from "./tool-execution.ts";
import type {
  AfterToolCall,
  AfterToolCallInput,
  AfterToolCallUpdate,
  AgentEvent,
  AgentHook,
  AgentMessage,
  AgentTool,
  BeforeToolCall,
  BeforeToolCallDecision,
  BeforeToolCallInput,
  FinishTurnDecision,
  FinishTurnInput,
  PrepareRequestUpdate,
  ThinkingLevel,
  ToolExecutionMode,
  ToolResult,
  TransformContext,
} from "./types.ts";

export type Emit = (event: AgentEvent) => Promise<void> | void;

export interface LoopHooks {
  prepareRequest?: (
    input: { messages: AgentMessage[]; model: Model; thinkingLevel: ThinkingLevel },
    signal: AbortSignal,
  ) => Promise<PrepareRequestUpdate | undefined> | PrepareRequestUpdate | undefined;
  finishTurn?: (input: FinishTurnInput, signal: AbortSignal) => Promise<FinishTurnDecision | undefined> | FinishTurnDecision | undefined;
  /** Ordered hooks folded into the single before, after, and transform callbacks. */
  hooks: readonly AgentHook[];
  takeSteering: () => AgentMessage[];
  takeFollowUp: () => AgentMessage[];
  stream: (
    model: Model,
    messages: AgentMessage[],
    tools: AgentTool[],
    thinkingLevel: ThinkingLevel,
    signal: AbortSignal,
  ) => AssistantEventStream | Promise<AssistantEventStream>;
}

export interface LoopInput {
  telemetryContext?: TelemetryContext;
  messages: AgentMessage[];
  model: Model;
  tools: AgentTool[];
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  toolExecution: ToolExecutionMode;
  prompts: AgentMessage[];
  signal: AbortSignal;
  hooks: LoopHooks;
}

/**
 * In-memory turn loop. Agent messages stay intact until the stream call.
 * `prepareRequest` may replace that transcript. The ordered `hooks` list is
 * folded into one `transformContext`, which replaces only the messages for
 * the current model call.
 * Steering enters after the assistant turn. Follow-up enters only when the
 * loop would otherwise stop. A length stop never executes tool calls.
 */
export async function runAgentLoop(input: LoopInput, emit: Emit): Promise<AgentMessage[]> {
  const produced: AgentMessage[] = [];
  let messages = [...input.messages];
  let model = input.model;
  let thinkingLevel = input.thinkingLevel;
  let tools = input.tools;
  const signal = input.signal;
  const slot = foldHooks(input.hooks);

  await emit({ type: "agent_start" });
  const initial = adoptDeclared(messages, tools, input.systemPrompt, produced);
  messages = initial.messages;
  for (const message of initial.added) {
    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });
  }
  await emit({ type: "turn_start" });
  for (const prompt of input.prompts) {
    messages = append(messages, produced, prompt);
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  let queued = input.hooks.takeSteering();
  let explicitContinue = false;

  while (true) {
    let moreTools = true;
    while (moreTools || queued.length > 0) {
      for (const message of queued) {
        messages = append(messages, produced, message);
        await emit({ type: "message_start", message });
        await emit({ type: "message_end", message });
      }
      queued = [];
      const adopted = adoptDeclared(messages, tools, input.systemPrompt, produced);
      messages = adopted.messages;
      for (const message of adopted.added) {
        await emit({ type: "message_start", message });
        await emit({ type: "message_end", message });
      }

      const prepared = await input.hooks.prepareRequest?.({ messages, model, thinkingLevel }, signal);
      if (prepared?.messages) messages = prepared.messages;
      if (prepared?.model) model = prepared.model;
      if (prepared?.thinkingLevel) thinkingLevel = prepared.thinkingLevel;

      const requestMessages = await requestContext(slot.transformContext, messages, signal);
      const message = await streamAssistant(input, model, requestMessages, tools, thinkingLevel, signal, emit);
      messages = append(messages, produced, message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await input.hooks.finishTurn?.({ message, toolResults: [], messages }, signal);
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: produced });
        return produced;
      }

      const calls = findToolCalls(message);
      let toolResults: ToolResultMessage[] = [];
      moreTools = false;
      if (calls.length > 0) {
        const executed =
          message.stopReason === "length"
            ? await failTruncated(calls, emit)
            : await executeAgentTools(calls, tools, input.toolExecution, signal, emit, input.telemetryContext, {
                beforeToolCall: slot.beforeToolCall,
                afterToolCall: slot.afterToolCall,
              });
        toolResults = executed.messages;
        moreTools = !executed.terminate;
        for (const result of toolResults) {
          messages = append(messages, produced, result);
          await emit({ type: "message_start", message: result });
          await emit({ type: "message_end", message: result });
        }
      }

      const decision = await input.hooks.finishTurn?.({ message, toolResults, messages }, signal);
      await emit({ type: "turn_end", message, toolResults });
      if (signal.aborted || decision?.action === "end") {
        await emit({ type: "agent_end", messages: produced });
        return produced;
      }
      explicitContinue = decision?.action === "continue";
      queued = input.hooks.takeSteering();
      if (moreTools || queued.length > 0) explicitContinue = false;
      if (moreTools || queued.length > 0) await emit({ type: "turn_start" });
    }

    const followUp = input.hooks.takeFollowUp();
    if (followUp.length > 0) {
      explicitContinue = false;
      queued = followUp;
      await emit({ type: "turn_start" });
      continue;
    }
    if (explicitContinue) {
      explicitContinue = false;
      await emit({ type: "turn_start" });
      continue;
    }
    break;
  }

  await emit({ type: "agent_end", messages: produced });
  return produced;
}

interface HookSlot {
  beforeToolCall: BeforeToolCall;
  afterToolCall: AfterToolCall;
  transformContext: TransformContext;
}

/** Fold the ordered list into the one before, after, and transform callback this loop already calls. */
function foldHooks(source: LoopHooks): HookSlot {
  return {
    beforeToolCall: (call, requestSignal) => walkBefore(source.hooks, call, requestSignal),
    afterToolCall: (call, requestSignal) => walkAfter(source.hooks, call, requestSignal),
    transformContext: (messages, requestSignal) => walkTransform(source.hooks, messages, requestSignal),
  };
}

export async function walkBefore(
  hooks: readonly AgentHook[],
  call: BeforeToolCallInput,
  signal: AbortSignal,
): Promise<BeforeToolCallDecision | undefined> {
  for (const hook of hooks) {
    if (!hook.beforeToolCall) continue;
    const decision = await hook.beforeToolCall(call, signal);
    if (decision?.action === "block") return decision;
  }
  return undefined;
}

export async function walkAfter(
  hooks: readonly AgentHook[],
  call: AfterToolCallInput,
  signal: AbortSignal,
): Promise<AfterToolCallUpdate | undefined> {
  let result = call.result;
  let changed = false;
  for (const hook of hooks) {
    if (!hook.afterToolCall) continue;
    const update = await hook.afterToolCall({ ...call, result }, signal);
    if (!update) continue;
    result = applyAfter(result, update);
    changed = true;
  }
  return changed ? toAfterUpdate(result) : undefined;
}

export async function walkTransform(
  hooks: readonly AgentHook[],
  messages: AgentMessage[],
  signal: AbortSignal,
): Promise<AgentMessage[] | undefined> {
  let current = messages;
  let replaced = false;
  for (const hook of hooks) {
    if (!hook.transformContext) continue;
    const next = await hook.transformContext(current.slice(), signal);
    if (!Array.isArray(next)) continue;
    current = next;
    replaced = true;
  }
  return replaced ? current : undefined;
}

function toAfterUpdate(result: ToolResult): AfterToolCallUpdate {
  const update: AfterToolCallUpdate = { content: result.content };
  if (result.isError !== undefined) update.isError = result.isError;
  if (result.terminate !== undefined) update.terminate = result.terminate;
  return update;
}

async function requestContext(
  transform: TransformContext | undefined,
  messages: AgentMessage[],
  signal: AbortSignal,
): Promise<AgentMessage[]> {
  if (!transform) return messages;
  const transformed = await transform(messages.slice(), signal);
  return Array.isArray(transformed) ? transformed : messages;
}

function append(messages: AgentMessage[], produced: AgentMessage[], message: AgentMessage): AgentMessage[] {
  produced.push(message);
  return [...messages, message];
}

async function streamAssistant(
  input: LoopInput,
  model: Model,
  messages: AgentMessage[],
  tools: AgentTool[],
  thinkingLevel: ThinkingLevel,
  signal: AbortSignal,
  emit: Emit,
): Promise<AssistantMessage> {
  const stream = await input.hooks.stream(model, messages, tools, thinkingLevel, signal);
  let latest: AssistantMessage | undefined;
  let started = false;
  for await (const event of stream) {
    if (event.type === "done") {
      latest = event.message;
      break;
    }
    if (event.type === "error") {
      latest = event.error;
      break;
    }
    latest = event.partial;
    if (event.type === "start" || !started) {
      started = true;
      await emit({ type: "message_start", message: event.partial });
    }
    if (event.type === "start") continue;
    const delta = "delta" in event && typeof event.delta === "string" ? event.delta : "";
    await emit({ type: "message_update", message: event.partial, assistantMessageEvent: event, delta });
  }
  const finalMessage = latest ?? (await stream.result());
  if (!started) await emit({ type: "message_start", message: finalMessage });
  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}

async function failTruncated(
  calls: Array<{ id: string; name: string }>,
  emit: Emit,
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
  const messages: ToolResultMessage[] = [];
  for (const call of calls) {
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "Tool call discarded because the assistant response was truncated" }],
      isError: true,
      timestamp: Date.now(),
    };
    messages.push(message);
    await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: {} });
    await emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: message, isError: message.isError });
  }
  return { messages, terminate: false };
}

function adoptDeclared(
  messages: AgentMessage[],
  tools: AgentTool[],
  systemPrompt: string,
  produced: AgentMessage[],
): { messages: AgentMessage[]; added: AgentMessage[] } {
  const next = declareToolChanges(messages, tools, systemPrompt);
  if (next === messages) return { messages, added: [] };
  const added: AgentMessage[] = [];
  if (next.length === messages.length + 1 && next[0] !== messages[0]) {
    const system = next[0];
    if (system) {
      added.push(system);
      produced.push(system);
    }
    return { messages: next, added };
  }
  for (const message of next.slice(messages.length)) {
    added.push(message);
    produced.push(message);
  }
  return { messages: next, added };
}

function declareToolChanges(messages: AgentMessage[], tools: AgentTool[], systemPrompt: string): AgentMessage[] {
  const current = new Set(tools.map((tool) => tool.name));
  const declared = declaredTools(messages);
  if (declared.size === 0 && !messages.some((message) => message.role === "system")) {
    const initial: SystemMessage = {
      role: "system",
      content: systemPrompt,
      timestamp: Date.now(),
      toolsAdded: [...current],
    };
    return [initial, ...messages];
  }
  const added = [...current].filter((name) => !declared.has(name));
  const removed = [...declared].filter((name) => !current.has(name));
  if (added.length === 0 && removed.length === 0) return messages;
  const update: SystemMessage = {
    role: "system",
    content: "",
    timestamp: Date.now(),
    toolsAdded: added,
    toolsRemoved: removed,
  };
  return [...messages, update];
}

function declaredTools(messages: AgentMessage[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const name of message.toolsAdded ?? []) names.add(name);
    for (const name of message.toolsRemoved ?? []) names.delete(name);
  }
  return names;
}

export function toProviderMessages(messages: AgentMessage[]): Message[] {
  return messages.filter((message): message is Message => message.role !== "custom");
}

export function streamOptions(thinkingLevel: ThinkingLevel, signal: AbortSignal): StreamOptions {
  return { thinkingLevel, signal };
}
