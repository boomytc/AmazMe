import type { AssistantContent, AssistantEvent, AssistantFrame, AssistantMessage, StopReason, Usage } from "./types.ts";
import { emptyUsage } from "./transform.ts";

/** Compact recovery record. A complete-looking prefix is not a settled response. */
export function frameFromEvent(event: AssistantEvent): AssistantFrame | undefined {
  switch (event.type) {
    case "text_delta":
      return { type: "text_delta", delta: event.delta };
    case "thinking_delta":
      return { type: "thinking_delta", delta: event.delta };
    case "toolcall_end":
      return {
        type: "toolcall",
        id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: event.toolCall.arguments,
      };
    case "done":
      return { type: "stop", stopReason: event.reason, errorMessage: event.message.errorMessage };
    case "error":
      return { type: "stop", stopReason: "error", errorMessage: event.error.errorMessage };
    default:
      return undefined;
  }
}

export function reduceFrames(frames: readonly AssistantFrame[]): {
  content: AssistantContent[];
  stopReason?: StopReason;
  errorMessage?: string;
} {
  let text = "";
  let thinking = "";
  const content: AssistantContent[] = [];
  let stopReason: StopReason | undefined;
  let errorMessage: string | undefined;
  const flushText = () => {
    if (text.length > 0) {
      content.push({ type: "text", text });
      text = "";
    }
  };
  const flushThinking = () => {
    if (thinking.length > 0) {
      content.push({ type: "thinking", thinking });
      thinking = "";
    }
  };
  for (const frame of frames) {
    if (frame.type === "text_delta") {
      flushThinking();
      text += frame.delta ?? "";
    } else if (frame.type === "thinking_delta") {
      flushText();
      thinking += frame.delta ?? "";
    } else if (frame.type === "toolcall") {
      flushText();
      flushThinking();
      content.push({
        type: "toolCall",
        id: frame.id ?? "call",
        name: frame.name ?? "unknown",
        arguments: frame.arguments ?? {},
      });
    } else if (frame.type === "stop") {
      stopReason = frame.stopReason;
      errorMessage = frame.errorMessage;
    }
  }
  flushText();
  flushThinking();
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
