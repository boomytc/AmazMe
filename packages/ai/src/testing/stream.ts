import type { AssistantContent, AssistantEvent } from "../types.ts";

type BlockKind = "text" | "thinking" | "tool";
type BlockPhase = "start" | "delta" | "end";

/**
 * Lifecycle and identity checks shared by faux and protocol fixtures.
 * Wire shape, output caps, and image URLs stay in the protocol tests.
 * Returns a list of problems; it does not throw and does not import a test runner.
 */
export function checkAssistantStream(events: readonly AssistantEvent[]): string[] {
  const problems: string[] = [];
  const terminals = events.filter((event) => event.type === "done" || event.type === "error");
  if (terminals.length === 0) problems.push("stream has no terminal event");
  if (terminals.length > 1) problems.push("stream has more than one terminal event");
  const terminalIndex = events.findIndex((event) => event.type === "done" || event.type === "error");
  if (terminalIndex >= 0 && terminalIndex !== events.length - 1) problems.push("terminal event is not last");
  const messageStarts = events.filter(event => event.type === "start");
  if (messageStarts.length > 1) problems.push("message started more than once");
  if (messageStarts.length === 1 && events[0]?.type !== "start") problems.push("message start is not first");
  if (events.some(event => blockEvent(event) !== undefined) && messageStarts.length !== 1) {
    problems.push("content blocks require one message start");
  }

  const started = new Map<number, BlockKind>();
  const ended = new Set<number>();
  const completed = new Map<number, AssistantContent>();
  const text = new Map<number, string>();
  const order: number[] = [];
  for (const event of events) {
    if (event.type === "start" || event.type === "done" || event.type === "error") continue;
    const block = blockEvent(event);
    if (!block) continue;
    if (!Number.isSafeInteger(block.index) || block.index < 0) {
      problems.push(`${event.type} has no stable contentIndex`);
      continue;
    }
    const partialBlock = event.partial.content[block.index];
    if (contentKind(partialBlock) !== block.kind) {
      problems.push(`${event.type} contentIndex ${block.index} does not match the partial block`);
    }
    if (event.type === "toolcall_end") {
      const tool = event.partial.content[block.index];
      if (!sameJson(tool?.type === "toolCall" ? tool : undefined, event.toolCall)) {
        problems.push(`toolcall_end contentIndex ${block.index} does not match the partial tool call`);
      }
    }
    const known = started.get(block.index);
    if (block.phase === "start") {
      if (known) problems.push(`contentIndex ${block.index} started twice`);
      else {
        started.set(block.index, block.kind);
        order.push(block.index);
        if (block.kind !== "tool") text.set(block.index, "");
      }
      if (ended.has(block.index)) problems.push(`contentIndex ${block.index} started after it ended`);
    } else if (!known) {
      problems.push(`${event.type} before start at contentIndex ${block.index}`);
    } else if (known !== block.kind) {
      problems.push(`contentIndex ${block.index} changed from ${known} to ${block.kind}`);
    } else if (ended.has(block.index)) {
      problems.push(`${event.type} after end at contentIndex ${block.index}`);
    }
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      text.set(block.index, (text.get(block.index) ?? "") + event.delta);
    }
    if (partialBlock?.type === "text" || partialBlock?.type === "thinking") {
      const received = partialBlock.type === "text" ? partialBlock.text : partialBlock.thinking;
      if (received !== text.get(block.index)) problems.push(`${event.type} content does not match received deltas`);
    }
    if (block.phase === "end" && known === block.kind) {
      ended.add(block.index);
      if (partialBlock) completed.set(block.index, partialBlock);
    }
  }
  order.forEach((index, position) => {
    if (index !== position) problems.push(`contentIndex ${index} is not the next block in first-seen order`);
  });

  const terminal = terminals.length === 1 ? terminals[0] : undefined;
  if (terminal?.type === "done" && terminal.message.stopReason !== terminal.reason) {
    problems.push("done reason does not match the terminal message");
  }
  if (terminal?.type === "error" && terminal.error.stopReason !== "error" && terminal.error.stopReason !== "aborted") {
    problems.push("error terminal is not an error or aborted message");
  }
  const success = terminal?.type === "done" && (terminal.reason === "stop" || terminal.reason === "length" || terminal.reason === "toolUse");
  if (success) {
    if (messageStarts.length !== 1) problems.push("successful stream requires one message start");
    for (const index of started.keys()) {
      if (!ended.has(index)) problems.push(`successful stream left contentIndex ${index} open`);
    }
    if (started.size === 0) {
      const only = terminal.message.content;
      const empty = only.length === 0 || (only.length === 1 && only[0]?.type === "text" && only[0].text === "");
      if (!empty) problems.push("terminal message content does not match the started blocks");
    } else if (terminal.message.content.length !== started.size) {
      problems.push("terminal message content does not match the started blocks");
    } else {
      for (const [index, kind] of started) {
        if (contentKind(terminal.message.content[index]) !== kind) {
          problems.push(`terminal content ${index} is not ${kind}`);
        } else if (ended.has(index) && !sameContent(completed.get(index), terminal.message.content[index])) {
          problems.push(`terminal content ${index} does not match the completed block`);
        }
      }
    }
  }
  const failed = terminal?.type === "error"
    || (terminal?.type === "done" && (terminal.reason === "error" || terminal.reason === "aborted"));
  if (failed && events.some((event) => event.type === "toolcall_end")) {
    problems.push("error or aborted stream emitted toolcall_end");
  }
  return problems;
}

function sameContent(left: AssistantContent | undefined, right: AssistantContent | undefined): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return left === right;
  }
}

function blockEvent(event: AssistantEvent): { index: number; kind: BlockKind; phase: BlockPhase } | undefined {
  switch (event.type) {
    case "text_start": return { index: event.contentIndex, kind: "text", phase: "start" };
    case "text_delta": return { index: event.contentIndex, kind: "text", phase: "delta" };
    case "text_end": return { index: event.contentIndex, kind: "text", phase: "end" };
    case "thinking_start": return { index: event.contentIndex, kind: "thinking", phase: "start" };
    case "thinking_delta": return { index: event.contentIndex, kind: "thinking", phase: "delta" };
    case "thinking_end": return { index: event.contentIndex, kind: "thinking", phase: "end" };
    case "toolcall_start": return { index: event.contentIndex, kind: "tool", phase: "start" };
    case "toolcall_delta": return { index: event.contentIndex, kind: "tool", phase: "delta" };
    case "toolcall_end": return { index: event.contentIndex, kind: "tool", phase: "end" };
    default: return undefined;
  }
}

function contentKind(block: AssistantContent | undefined): BlockKind | undefined {
  if (block?.type === "text") return "text";
  if (block?.type === "thinking") return "thinking";
  if (block?.type === "toolCall") return "tool";
  return undefined;
}

function sameJson(block: { id: string; name: string; arguments: unknown } | undefined, toolCall: { id: string; name: string; arguments: unknown }): boolean {
  if (!block || block.id !== toolCall.id || block.name !== toolCall.name) return false;
  try {
    return JSON.stringify(block.arguments) === JSON.stringify(toolCall.arguments);
  } catch {
    return block.arguments === toolCall.arguments;
  }
}
