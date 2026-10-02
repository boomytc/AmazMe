import { toolDefinition, type AssistantMessage, type Context, type Model, type ThinkingLevel } from "@amazme/ai";
import { runAgentLoop, toProviderMessages } from "./loop.ts";
import { NOOP_TELEMETRY_CONTEXT, startSpan, type TelemetryContext } from "@amazme/telemetry";
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  FinishTurnDecision,
  FinishTurnInput,
  PrepareRequestUpdate,
  QueueMode,
  StreamFn,
  ToolExecutionMode,
} from "./types.ts";

type Listener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

export interface AgentOptions {
  telemetryContext?: TelemetryContext;
  systemPrompt?: string;
  model: Model;
  streamFn: StreamFn;
  tools?: AgentTool[];
  thinkingLevel?: ThinkingLevel;
  messages?: AgentMessage[];
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  toolExecution?: ToolExecutionMode;
  prepareRequest?: (
    input: { messages: AgentMessage[]; model: Model; thinkingLevel: ThinkingLevel },
    signal: AbortSignal,
  ) => Promise<PrepareRequestUpdate | undefined> | PrepareRequestUpdate | undefined;
  finishTurn?: (
    input: FinishTurnInput,
    signal: AbortSignal,
  ) => Promise<FinishTurnDecision | undefined> | FinishTurnDecision | undefined;
}

class Queue {
  private items: AgentMessage[] = [];
  private readonly mode: QueueMode;

  constructor(mode: QueueMode) {
    this.mode = mode;
  }

  enqueue(message: AgentMessage): void {
    this.items.push(message);
  }

  take(): AgentMessage[] {
    if (this.items.length === 0) return [];
    if (this.mode === "all") {
      const taken = this.items;
      this.items = [];
      return taken;
    }
    return [this.items.shift() as AgentMessage];
  }

  clear(): void {
    this.items = [];
  }
}

/**
 * Process-local agent. The transcript lives in memory. `streamFn` performs each
 * model call. `prepareRequest` may replace the transcript before that call.
 */
export class Agent {
  private readonly listeners = new Set<Listener>();
  private readonly steering: Queue;
  private readonly followUps: Queue;
  private running = false;
  private abortController: AbortController | undefined;
  private runPromise: Promise<void> = Promise.resolve();

  systemPrompt: string;
  model: Model;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
  toolExecution: ToolExecutionMode;
  prepareRequest: AgentOptions["prepareRequest"];
  finishTurn: AgentOptions["finishTurn"];
  private readonly streamFn: StreamFn;
  private readonly telemetryContext: TelemetryContext;

  constructor(options: AgentOptions) {
    this.systemPrompt = options.systemPrompt ?? "";
    this.model = options.model;
    this.streamFn = options.streamFn;
    this.telemetryContext = options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
    this.tools = options.tools ?? [];
    this.thinkingLevel = options.thinkingLevel ?? "off";
    this.messages = options.messages ?? [];
    this.toolExecution = options.toolExecution ?? "parallel";
    this.prepareRequest = options.prepareRequest;
    this.finishTurn = options.finishTurn;
    this.steering = new Queue(options.steeringMode ?? "one-at-a-time");
    this.followUps = new Queue(options.followUpMode ?? "one-at-a-time");
  }

  get state(): AgentState {
    return {
      systemPrompt: this.systemPrompt,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      tools: this.tools,
      messages: this.messages,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  steer(message: AgentMessage | string): void {
    this.steering.enqueue(typeof message === "string" ? userMessage(message) : message);
  }

  followUp(message: AgentMessage | string): void {
    this.followUps.enqueue(typeof message === "string" ? userMessage(message) : message);
  }

  abort(): void {
    this.abortController?.abort();
  }

  waitForIdle(): Promise<void> {
    return this.runPromise;
  }

  async prompt(input: string | AgentMessage | AgentMessage[]): Promise<AgentMessage[]> {
    if (this.running) throw new Error("Agent is already processing");
    const prompts = Array.isArray(input) ? input : [typeof input === "string" ? userMessage(input) : input];
    this.running = true;
    const controller = new AbortController();
    this.abortController = controller;
    const signal = controller.signal;
    let resolveRun: () => void = () => {};
    this.runPromise = new Promise((resolve) => {
      resolveRun = resolve;
    });
    try {
      return await startSpan(this.telemetryContext, {
        name: "amazme.agent.run",
        attributes: { provider: this.model.provider, model: this.model.id },
      }, async (span) => {
        const produced = await runAgentLoop(
          {
            messages: this.messages,
            model: this.model,
            tools: this.tools,
            thinkingLevel: this.thinkingLevel,
            systemPrompt: this.systemPrompt,
            toolExecution: this.toolExecution,
            prompts,
            signal,
            telemetryContext: span,
            hooks: {
              prepareRequest: (request, requestSignal) => this.prepareRequest?.(request, requestSignal),
              finishTurn: (turn, requestSignal) => this.finishTurn?.(turn, requestSignal),
              takeSteering: () => this.steering.take(),
              takeFollowUp: () => this.followUps.take(),
              stream: (model, messages, tools, thinkingLevel, requestSignal) => {
                const context: Context = {
                  systemPrompt: this.systemPrompt,
                  messages: toProviderMessages(messages),
                  tools: tools.map(toolDefinition),
                };
                return this.streamFn(model, context, { thinkingLevel, signal: requestSignal, telemetryContext: span });
              },
            },
          },
          async (event) => {
            this.absorb(event);
            for (const listener of this.listeners) await listener(event, signal);
          },
        );
        if (produced.some((message) => message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"))) {
          span.setStatus({ status: "error" });
        }
        return produced;
      });
    } finally {
      this.running = false;
      this.abortController = undefined;
      resolveRun();
    }
  }

  private absorb(event: AgentEvent): void {
    if (event.type === "message_end") {
      const already = this.messages[this.messages.length - 1] === event.message;
      if (!already) this.messages = [...this.messages, event.message];
    }
  }
}

export function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

export function assistantText(text: string, model: Model): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
