import type { AssistantMessage, AssistantMessageEvent, Message } from "@amazme/ai";
import type { AgentEvent, MessageChange } from "@amazme/durable";
import { type JsonStreamEvent, toJsonEvent } from "../modes/json-event.ts";

/**
 * Project Durable agent events onto the JSON stream shape that `--mode json` already emits.
 *
 * Durable publishes commit-derived batches. The coding agent publishes one event per model or
 * tool transition. This translator keeps the established wire names; Durable-only records with
 * no established equivalent are omitted rather than given a made-up shape. The JSON stream is a
 * presentation protocol, not the durable transcript; the transcript remains SQLite and is never
 * rewritten by this projection.
 */
export class DurableJsonEvents {
	private message: AssistantMessage | undefined;
	private thinking: string | undefined;
	private readonly toolArgs = new Map<string, unknown>();
	private readonly runMessages: Message[] = [];

	translate(event: AgentEvent): JsonStreamEvent[] {
		switch (event.type) {
			case "snapshot":
				return [];
			case "run_start":
				this.runMessages.length = 0;
				return [{ type: "agent_start" }];
			case "run_end": {
				const messages = this.runMessages.slice();
				this.runMessages.length = 0;
				return [{ type: "agent_end", messages, willRetry: false }];
			}
			case "turn_start":
				return [{ type: "turn_start" }];
			case "message_start":
				if (event.message.role === "assistant") this.message = event.message;
				return [{ type: "message_start", message: event.message }];
			case "message_update":
				return this.messageUpdates(event.usage, event.changes);
			case "message_end": {
				const message = event.entry.model?.[0];
				if (message === undefined) return [];
				this.runMessages.push(message);
				return [{ type: "message_end", message }];
			}
			case "tool_execution_start":
				this.toolArgs.set(event.toolCallId, event.args);
				return [{ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }];
			case "tool_execution_update":
				return [{
					type: "tool_execution_update",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: this.toolArgs.get(event.toolCallId),
					partialResult: {
						...(event.output === undefined ? {} : { output: event.output }),
						...(event.details === undefined ? {} : { details: event.details }),
						...(event.diagnostics === undefined ? {} : { diagnostics: event.diagnostics }),
					},
				}];
			case "tool_execution_end": {
				const result = event.entry?.model?.[0] ?? event.result;
				const isError = result !== undefined && typeof result === "object" && "isError" in result
					? Boolean(result.isError)
					: false;
				return [{
					type: "tool_execution_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result,
					isError,
					...(event.result?.durationMs === undefined ? {} : { durationMs: event.result.durationMs }),
				}];
			}
			case "inbox_update":
				return [];
			case "entry_appended":
				return [];
			case "compaction_start":
				return [{ type: "compaction_start", reason: event.reason }];
			case "compaction_end":
				return [{
					type: "compaction_end",
					reason: event.reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					...(event.error === undefined ? {} : { errorMessage: event.error }),
				}];
			case "auto_retry_start":
				return [{
					type: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: 0,
					delayMs: Math.max(0, event.at - Date.now()),
					errorMessage: event.errorMessage,
				}];
			case "auto_retry_end":
				return [];
			case "deferred_poll":
			case "usage_changed":
			case "task_failed":
				return [];
			case "agent_changed": {
				const level = event.agent.thinkingLevel ?? "off";
				if (level === this.thinking) return [];
				this.thinking = level;
				return [{ type: "thinking_level_changed", level }];
			}
			case "submission":
				return [];
			case "turn_end":
			default:
				return [];
		}
	}

	/** One JSON line per change, matching the coding agent's per-delta events. */
	private messageUpdates(usage: AssistantMessage["usage"], changes: readonly MessageChange[]): JsonStreamEvent[] {
		const message = this.message;
		if (message === undefined) return [];
		const events: JsonStreamEvent[] = [];
		for (const change of changes) {
			const assistantMessageEvent = this.assistantEvent(message, change, usage);
			if (assistantMessageEvent !== undefined) {
				events.push(toJsonEvent({ type: "message_update", message: { ...message, usage }, assistantMessageEvent }));
			}
		}
		return events;
	}

	private assistantEvent(
		message: AssistantMessage,
		change: MessageChange,
		usage: AssistantMessage["usage"],
	): AssistantMessageEvent | undefined {
		const partial = { ...message, usage };
		switch (change.type) {
			case "text_start":
				return { type: "text_start", contentIndex: change.contentIndex, partial };
			case "thinking_start":
				return { type: "thinking_start", contentIndex: change.contentIndex, partial };
			case "toolcall_start": {
				const content = [...partial.content];
				content[change.contentIndex] = change.block;
				return { type: "toolcall_start", contentIndex: change.contentIndex, partial: { ...partial, content } };
			}
			case "text_delta":
				return { type: "text_delta", contentIndex: change.contentIndex, delta: change.delta, partial };
			case "thinking_delta":
				return { type: "thinking_delta", contentIndex: change.contentIndex, delta: change.delta, partial };
			case "toolcall_delta":
				return { type: "toolcall_delta", contentIndex: change.contentIndex, delta: change.delta, partial };
			case "block": {
				const content = [...partial.content];
				content[change.contentIndex] = change.block;
				const completed = { ...partial, content };
				switch (change.block.type) {
					case "text":
						return { type: "text_end", contentIndex: change.contentIndex, content: change.block.text, partial: completed };
					case "thinking":
						return { type: "thinking_end", contentIndex: change.contentIndex, content: change.block.thinking, partial: completed };
					case "toolCall":
						return { type: "toolcall_end", contentIndex: change.contentIndex, toolCall: change.block, partial: completed };
					default:
						return undefined;
				}
			}
			case "message":
				return undefined;
		}
	}
}
