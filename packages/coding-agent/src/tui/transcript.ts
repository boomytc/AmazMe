import type { AgentEvent, AgentMessage } from "@amazme/agent";
import type { AssistantMessage, ToolResultMessage } from "@amazme/ai";

export type ScrollKind = "user" | "assistant" | "thinking" | "tool";

export interface ScrollEntry {
  kind: ScrollKind;
  text: string;
  toolCallId?: string;
  toolName?: string;
  open?: boolean;
}

/**
 * Scroll area for one fullscreen view. Lines come only from AgentEvents that
 * already happened: user text, assistant deltas, thinking deltas, and a tool
 * block from execution start through execution end.
 */
export class Transcript {
  readonly entries: ScrollEntry[] = [];
  busy = false;
  private streamed = false;

  apply(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        this.busy = true;
        this.streamed = false;
        this.closeOpen();
        return;
      case "turn_end":
        this.busy = false;
        this.streamed = false;
        this.closeOpen();
        return;
      case "message_start":
        if (event.message.role === "user") this.entries.push({ kind: "user", text: userText(event.message) });
        return;
      case "message_update":
        this.appendUpdate(event);
        return;
      case "message_end":
        if (event.message.role === "assistant") this.seedAssistant(event.message);
        return;
      case "tool_execution_start":
        this.closeOpen();
        this.entries.push({
          kind: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          text: `${event.toolName} 开始 ${preview(event.args)}`.trimEnd(),
        });
        return;
      case "tool_execution_update": {
        const entry = this.toolEntry(event.toolCallId);
        if (entry) entry.text += `\n${nameOf(entry)} 更新 ${event.partial}`;
        return;
      }
      case "tool_execution_end": {
        const line = `${event.toolName} 结束${event.isError ? " 错误" : ""} ${resultText(event.result)}`.trimEnd();
        const entry = this.toolEntry(event.toolCallId);
        if (entry) entry.text += `\n${line}`;
        else this.entries.push({ kind: "tool", toolCallId: event.toolCallId, toolName: event.toolName, text: line });
        return;
      }
      default:
        return;
    }
  }

  lines(): string[] {
    return this.entries.map(formatEntry);
  }

  private appendUpdate(event: Extract<AgentEvent, { type: "message_update" }>): void {
    const kind = deltaKind(event.assistantMessageEvent.type);
    const delta = event.delta;
    if (!kind || delta.length === 0) return;
    this.streamed = true;
    const last = this.entries[this.entries.length - 1];
    if (last?.kind === kind && last.open) {
      last.text += delta;
      return;
    }
    this.closeOpen();
    this.entries.push({ kind, text: delta, open: true });
  }

  private seedAssistant(message: AssistantMessage): void {
    if (this.streamed) {
      this.streamed = false;
      this.closeOpen();
      return;
    }
    for (const block of message.content) {
      if (block.type === "text" && block.text.length > 0) this.entries.push({ kind: "assistant", text: block.text });
      else if (block.type === "thinking" && block.thinking.length > 0) this.entries.push({ kind: "thinking", text: block.thinking });
    }
  }

  private toolEntry(toolCallId: string): ScrollEntry | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry?.kind === "tool" && entry.toolCallId === toolCallId) return entry;
    }
    return undefined;
  }

  private closeOpen(): void {
    for (const entry of this.entries) entry.open = false;
  }
}

export function formatEntry(entry: ScrollEntry): string {
  if (entry.kind === "user") return `用户 ${entry.text}`;
  if (entry.kind === "assistant") return `助手 ${entry.text}`;
  if (entry.kind === "thinking") return `思考 ${entry.text}`;
  return `工具 ${entry.text}`;
}

export function preview(value: unknown): string {
  if (value === undefined) return "";
  try {
    const text = JSON.stringify(value) ?? "";
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  } catch {
    return "";
  }
}

function deltaKind(type: string): "assistant" | "thinking" | undefined {
  if (type === "text_delta") return "assistant";
  if (type === "thinking_delta") return "thinking";
  return undefined;
}

function userText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function resultText(result: ToolResultMessage): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function nameOf(entry: ScrollEntry): string {
  return entry.toolName ?? entry.text.split(" ")[0] ?? "tool";
}
