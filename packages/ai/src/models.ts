import { resolveApiKey, type ApiKeyAuth, MemoryCredentialStore } from "./auth.ts";
import { EventStream } from "./event-stream.ts";
import type {
  AssistantEvent,
  AssistantMessage,
  AuthResult,
  Context,
  CredentialStore,
  Model,
  StreamOptions,
} from "./types.ts";
import { normalizeContext } from "./transform.ts";
import { NOOP_TELEMETRY_CONTEXT, startSpan, type TelemetryContext } from "@amazme/telemetry";

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly auth: ApiKeyAuth;
  getModels(): readonly Model[];
  streamSimple(model: Model, context: Context, options: StreamOptions & { apiKey: string }): AssistantEventStream;
}

export type AssistantEventStream = EventStream<AssistantEvent, AssistantMessage>;

export function createAssistantEventStream(): AssistantEventStream {
  return new EventStream(
    (event) => event.type === "done" || event.type === "error",
    (event) => (event.type === "done" ? event.message : event.type === "error" ? event.error : unreachable()),
  );
}

function unreachable(): never {
  throw new Error("Assistant stream ended without a terminal event");
}

export class ModelsError extends Error {
  readonly code: "provider" | "auth" | "model";

  constructor(code: "provider" | "auth" | "model", message: string) {
    super(message);
    this.name = "ModelsError";
    this.code = code;
  }
}

export interface ModelsOptions {
  telemetryContext?: TelemetryContext;
  store?: CredentialStore;
  env?: Record<string, string | undefined>;
}

/**
 * A provider owns its catalog, its auth, and its stream.
 * The collection routes every call to the provider named by the model.
 */
export class Models {
  private readonly providers = new Map<string, Provider>();
  readonly store: CredentialStore;
  readonly env: Record<string, string | undefined>;
  readonly telemetryContext: TelemetryContext;

  constructor(options: ModelsOptions = {}) {
    this.store = options.store ?? new MemoryCredentialStore();
    this.env = options.env ?? (typeof process === "undefined" ? {} : process.env);
    this.telemetryContext = options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
  }

  setProvider(provider: Provider): void {
    this.providers.set(provider.id, provider);
  }

  getProvider(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  getModel(providerId: string, modelId: string): Model | undefined {
    return this.providers.get(providerId)?.getModels().find((model) => model.id === modelId);
  }

  listModels(): Model[] {
    return [...this.providers.values()].flatMap((provider) => [...provider.getModels()]);
  }

  async getAuth(model: Model, apiKey?: string): Promise<AuthResult | undefined> {
    const provider = this.providers.get(model.provider);
    if (!provider) return undefined;
    return resolveApiKey({
      providerId: provider.id,
      auth: provider.auth,
      store: this.store,
      env: this.env,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  }

  streamSimple(model: Model, context: Context, options: StreamOptions = {}): AssistantEventStream {
    const transcript = normalizeContext(context);
    const stream = createAssistantEventStream();
    void startSpan(options.telemetryContext ?? this.telemetryContext, {
      name: "amazme.ai.request",
      attributes: { provider: model.provider, model: model.id, api: model.api },
    }, async (span) => {
      const opened = await this.dispatch(model, transcript, { ...options, telemetryContext: span });
      let terminal: Extract<AssistantEvent, { type: "done" | "error" }> | undefined;
      for await (const event of opened) {
        if (event.type === "done" || event.type === "error") { terminal = event; break; }
        stream.push(event);
      }
      const message = terminal ? (terminal.type === "done" ? terminal.message : terminal.error) : await opened.result();
      span.setAttributes({
        stopReason: message.stopReason,
        inputTokens: message.usage.input, outputTokens: message.usage.output, totalTokens: message.usage.totalTokens,
      });
      if (message.stopReason === "error" || message.stopReason === "aborted") span.setStatus({ status: "error" });
      return terminal ?? (message.stopReason === "error" || message.stopReason === "aborted"
        ? { type: "error" as const, error: message }
        : { type: "done" as const, reason: message.stopReason, message });
    })
      .then((event) => { stream.push(event); })
      .catch((error: unknown) => {
        const message = errorMessage(model, error, options.signal?.aborted === true);
        stream.push({ type: "error", error: message });
      });
    return stream;
  }

  async completeSimple(model: Model, context: Context, options: StreamOptions = {}): Promise<AssistantMessage> {
    return this.streamSimple(model, context, options).result();
  }

  private async dispatch(model: Model, context: Context, options: StreamOptions): Promise<AssistantEventStream> {
    const provider = this.providers.get(model.provider);
    if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
    const known = provider.getModels().some((item) => item.id === model.id);
    if (!known) throw new ModelsError("model", `Unknown model: ${model.provider}/${model.id}`);
    const auth = await resolveApiKey({
      providerId: provider.id,
      auth: provider.auth,
      store: this.store,
      env: this.env,
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    });
    if (!auth) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
    return provider.streamSimple(model, context, { ...options, apiKey: auth.apiKey });
  }
}

export function createModels(options?: ModelsOptions): Models {
  return new Models(options);
}

function errorMessage(model: Model, error: unknown, aborted: boolean): AssistantMessage {
  const message = error instanceof Error ? error.message : String(error);
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

export function baseAssistant(model: Model, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}
