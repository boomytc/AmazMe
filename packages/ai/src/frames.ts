import { isCompletionsThinkingField, type AssistantContent, type AssistantEvent, type AssistantFrame, type AssistantMessage, type StopReason, type Usage } from "./types.ts";
import { emptyUsage } from "./transform.ts";

/** Compact recovery record. A complete-looking prefix is not a settled response. */
export function frameFromEvent(event: AssistantEvent): AssistantFrame | undefined {
  switch (event.type) {
    case "text_delta":
    case "text_end": {
      const block = event.partial.content[event.contentIndex];
      const signature = block?.type === "text" ? block.textSignature : undefined;
      if (event.type === "text_end" && signature === undefined) return undefined;
      return { type: "text_delta", contentIndex: event.contentIndex, delta: event.type === "text_delta" ? event.delta : "", ...(signature !== undefined ? { textSignature: signature } : {}) };
    }
    case "thinking_delta":
    case "thinking_end": {
      const block = event.partial.content[event.contentIndex];
      const thinkingField = block?.type === "thinking" && isCompletionsThinkingField(block.thinkingField)
        ? block.thinkingField
        : undefined;
      if (event.type === "thinking_end" && (block?.type !== "thinking" || (block.thinkingSignature === undefined && !block.redacted))) return undefined;
      return {
        type: "thinking_delta",
        contentIndex: event.contentIndex,
        delta: event.type === "thinking_delta" ? event.delta : "",
        ...(thinkingField ? { thinkingField } : {}),
        ...(block?.type === "thinking" && block.thinkingSignature !== undefined ? { thinkingSignature: block.thinkingSignature } : {}),
        ...(block?.type === "thinking" && block.redacted ? { redacted: true } : {}),
      };
    }
    case "toolcall_end":
      return {
        type: "toolcall",
        contentIndex: event.contentIndex,
        id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: event.toolCall.arguments,
        ...(event.toolCall.thoughtSignature !== undefined ? { thoughtSignature: event.toolCall.thoughtSignature } : {}),
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
      const textSignature = frame.textSignature ?? (current?.type === "text" ? current.textSignature : undefined);
      slots.set(frame.contentIndex, { type: "text", text, ...(textSignature !== undefined ? { textSignature } : {}) });
    } else if (frame.type === "thinking_delta") {
      const current = slots.get(frame.contentIndex);
      const thinking = (current?.type === "thinking" ? current.thinking : "") + frame.delta;
      const thinkingField = current?.type === "thinking" && current.thinkingField
        ? current.thinkingField
        : frame.thinkingField;
      const thinkingSignature = frame.thinkingSignature ?? (current?.type === "thinking" ? current.thinkingSignature : undefined);
      const redacted = frame.redacted ?? (current?.type === "thinking" ? current.redacted : undefined);
      slots.set(frame.contentIndex, {
        type: "thinking",
        thinking,
        ...(thinkingField ? { thinkingField } : {}),
        ...(thinkingSignature !== undefined ? { thinkingSignature } : {}),
        ...(redacted ? { redacted: true } : {}),
      });
    } else if (frame.type === "toolcall") {
      slots.set(frame.contentIndex, {
        type: "toolCall",
        id: frame.id,
        name: frame.name,
        arguments: frame.arguments,
        ...(frame.thoughtSignature !== undefined ? { thoughtSignature: frame.thoughtSignature } : {}),
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
