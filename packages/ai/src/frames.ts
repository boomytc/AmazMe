import { isCompletionsThinkingField, type AssistantContent, type AssistantEvent, type AssistantFrame, type AssistantMessage, type StopReason, type Usage } from "./types.ts";
import { emptyUsage } from "./transform.ts";

/** Compact recovery record. A complete-looking prefix is not a settled response. */
export function frameFromEvent(event: AssistantEvent): AssistantFrame | undefined {
  switch (event.type) {
    case "text_delta":
      return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "thinking_delta": {
      const block = event.partial.content[event.contentIndex];
      const thinkingField = block?.type === "thinking" && isCompletionsThinkingField(block.thinkingField)
        ? block.thinkingField
        : undefined;
      return {
        type: "thinking_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
        ...(thinkingField ? { thinkingField } : {}),
      };
    }
    case "toolcall_end":
      return {
        type: "toolcall",
        contentIndex: event.contentIndex,
        id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: event.toolCall.arguments,
      };
    case "done":
      return {
        type: "stop",
        stopReason: event.reason,
        ...(event.message.errorMessage ? { errorMessage: event.message.errorMessage } : {}),
      };
    case "error":
      return {
        type: "stop",
        stopReason: event.error.stopReason === "aborted" ? "aborted" : "error",
        ...(event.error.errorMessage ? { errorMessage: event.error.errorMessage } : {}),
      };
    default:
      return undefined;
  }
}

/** Assemble by contentIndex. The order of end events does not reorder blocks. */
export function reduceFrames(frames: readonly AssistantFrame[]): {
  content: AssistantContent[];
  stopReason?: StopReason;
  errorMessage?: string;
} {
  const slots = new Map<number, AssistantContent>();
  let stopReason: StopReason | undefined;
  let errorMessage: string | undefined;
  for (const frame of frames) {
    if (frame.type === "text_delta") {
      const current = slots.get(frame.contentIndex);
      const text = (current?.type === "text" ? current.text : "") + frame.delta;
      slots.set(frame.contentIndex, { type: "text", text });
    } else if (frame.type === "thinking_delta") {
      const current = slots.get(frame.contentIndex);
      const thinking = (current?.type === "thinking" ? current.thinking : "") + frame.delta;
      const thinkingField = current?.type === "thinking" && current.thinkingField
        ? current.thinkingField
        : frame.thinkingField;
      slots.set(frame.contentIndex, {
        type: "thinking",
        thinking,
        ...(thinkingField ? { thinkingField } : {}),
      });
    } else if (frame.type === "toolcall") {
      slots.set(frame.contentIndex, {
        type: "toolCall",
        id: frame.id,
        name: frame.name,
        arguments: frame.arguments,
      });
    } else {
      stopReason = frame.stopReason;
      errorMessage = frame.errorMessage;
    }
  }
  const content: AssistantContent[] = [];
  for (const index of [...slots.keys()].sort((left, right) => left - right)) {
    const block = slots.get(index);
    if (block) content.push(block);
  }
  return { content, stopReason, errorMessage };
}

export function messageFromFrames(
  model: { api: string; provider: string; id: string },
  frames: readonly AssistantFrame[],
  usage: Usage = emptyUsage(),
): AssistantMessage {
  const reduced = reduceFrames(frames);
  return {
    role: "assistant",
    content: reduced.content.length > 0 ? reduced.content : [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: reduced.stopReason ?? "aborted",
    ...(reduced.errorMessage ? { errorMessage: reduced.errorMessage } : {}),
    timestamp: Date.now(),
  };
}
