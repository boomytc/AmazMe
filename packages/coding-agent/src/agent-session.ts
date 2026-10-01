import type { Agent, AgentMessage } from "@amazme/agent";
import { SessionStore } from "./session.ts";

export interface AgentSessionOptions {
  /** Token estimate above which the prefix is replaced by a summary entry. */
  compactAt?: number;
  summarize?: (messages: AgentMessage[]) => Promise<string> | string;
  tailCount?: number;
}

/**
 * Product session. The in-memory agent loop emits events. This class is the
 * only writer of the JSONL tree, and every model request is rebuilt from the
 * active branch.
 */
export class AgentSession {
  private readonly unsubscribe: () => void;
  readonly store: SessionStore;
  readonly agent: Agent;
  private readonly options: AgentSessionOptions;

  constructor(store: SessionStore, agent: Agent, options: AgentSessionOptions = {}) {
    this.store = store;
    this.agent = agent;
    this.options = options;
    this.unsubscribe = agent.subscribe(async (event) => {
      if (event.type === "message_end") this.store.appendMessage(event.message);
    });
    const previous = agent.prepareRequest;
    agent.prepareRequest = async (input, signal) => {
      const compactAt = options.compactAt;
      if (compactAt !== undefined && this.store.estimate() > compactAt) {
        const summary = options.summarize ? await options.summarize(this.store.modelMessages()) : localSummary(this.store.modelMessages());
        this.store.compact(summary, options.tailCount ?? 1);
      }
      const prepared = await previous?.({ ...input, messages: this.store.modelMessages() }, signal);
      return { ...prepared, messages: this.store.modelMessages() };
    };
  }

  prompt(input: string | AgentMessage | AgentMessage[]): Promise<AgentMessage[]> {
    return this.agent.prompt(input);
  }

  close(): void {
    this.unsubscribe();
  }
}

function localSummary(messages: AgentMessage[]): string {
  const lines = messages.slice(-6).map((message) => {
    if (message.role === "custom") return `${message.name}: ${message.content}`;
    if (message.role === "system") return `system: ${message.content}`;
    if (typeof message.content === "string") return `${message.role}: ${message.content}`;
    const text = message.content
      .map((block) => (block.type === "text" ? block.text : block.type === "toolCall" ? `${block.name}` : ""))
      .join(" ");
    return `${message.role}: ${text}`;
  });
  return lines.join("\n").slice(0, 2000);
}
