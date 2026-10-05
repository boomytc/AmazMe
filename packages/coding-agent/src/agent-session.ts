import type { Agent, AgentMessage } from "@amazme/agent";
import type { Model } from "@amazme/ai";
import { decideRoute, resolveRoutedModel, type RouterModels } from "./router.ts";
import { SessionStore } from "./session.ts";
import { readRouterSettings, type RouterSettings } from "./settings.ts";

export interface AgentSessionOptions {
  /** Token estimate above which the prefix is replaced by a summary entry. */
  compactAt?: number;
  summarize?: (messages: AgentMessage[]) => Promise<string> | string;
  tailCount?: number;
  /**
   * Resolves strong, cheap, and the classifier. Ignored when `<cwd>/.amazme/settings.json` has no router.
   * Without it, a configured router keeps the current model and records why.
   */
  models?: RouterModels;
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
  private routing: Promise<Model> | undefined;
  private chosen: { provider: string; modelId: string } | undefined;
  /** Set when this file has no router. Later calls keep the caller's model and do not classify. */
  private routerOff = false;

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
      const model = await this.routedModel(prepared?.model ?? input.model, signal);
      return { ...prepared, model, messages: this.store.modelMessages() };
    };
  }

  /**
   * The first call classifies when the router is set. Later calls in this session reuse that model.
   * An unset router returns the current model and does not call the classifier.
   */
  private routedModel(model: Model, signal: AbortSignal): Promise<Model> {
    if (this.routerOff) return Promise.resolve(model);
    if (this.chosen) return Promise.resolve(this.savedModel(model));
    if (!this.routing) this.routing = this.routeOnce(model, signal);
    return this.routing;
  }

  private async routeOnce(model: Model, signal: AbortSignal): Promise<Model> {
    const existing = this.store.latestRoute();
    if (existing) {
      this.chosen = { provider: existing.provider, modelId: existing.modelId };
      return this.savedModel(model);
    }
    let router: RouterSettings | undefined;
    try {
      router = readRouterSettings(this.store.header.cwd);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.store.appendRoute({ provider: model.provider, modelId: model.id, reason });
      this.chosen = { provider: model.provider, modelId: model.id };
      return model;
    }
    if (!router) {
      this.routerOff = true;
      return model;
    }
    if (!this.options.models) {
      this.store.appendRoute({ provider: model.provider, modelId: model.id, reason: "router needs models" });
      this.chosen = { provider: model.provider, modelId: model.id };
      return model;
    }
    const decision = await decideRoute(this.options.models, router, model, this.store.modelMessages(), signal);
    this.store.appendRoute(decision);
    this.chosen = { provider: decision.provider, modelId: decision.modelId };
    return this.savedModel(model);
  }

  private savedModel(current: Model): Model {
    const chosen = this.chosen;
    const models = this.options.models;
    if (!chosen || !models) return current;
    return resolveRoutedModel(models, chosen, current);
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
