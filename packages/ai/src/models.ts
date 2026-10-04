import { AuthRefreshError, MemoryCredentialStore, providerAuth, resolveModelAuth, type ApiKeyAuth, type ProviderAuth } from "./auth.ts";
import { EventStream } from "./event-stream.ts";
import type {
  Api,
  ApiStreamOptions,
  AssistantEvent,
  AssistantMessage,
  AuthResult,
  Context,
  CredentialStore,
  Model,
  ProviderHeaders,
  StreamOptions,
} from "./types.ts";
import { normalizeContext } from "./transform.ts";
import { createTypedSpanStarter, NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@amazme/telemetry";
import { aiTelemetrySchema } from "./telemetry.ts";

export interface ProviderStreams<TApi extends Api = Api> {
  stream<T extends TApi>(model: Model<T>, context: Context, options?: ApiStreamOptions<T>): AssistantEventStream;
  streamSimple(model: Model<TApi>, context: Context, options?: StreamOptions): AssistantEventStream;
}

export interface Provider<TApi extends Api = Api> {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly headers?: ProviderHeaders;
  readonly auth: ProviderAuth;
  getModels(): readonly Model<TApi>[];
  stream<T extends TApi>(model: Model<T>, context: Context, options?: ApiStreamOptions<T>): AssistantEventStream;
  streamSimple(model: Model<TApi>, context: Context, options?: StreamOptions): AssistantEventStream;
}

export interface CreateProviderOptions<TApi extends Api = Api> {
  id: string;
  name?: string;
  baseUrl?: string;
  headers?: ProviderHeaders;
  auth: ApiKeyAuth | ProviderAuth;
  models: readonly Model<TApi>[];
  /** One protocol implementation for every model, or a table dispatched by `model.api`. */
  api: ProviderStreams<TApi> | Partial<Record<TApi, ProviderStreams>>;
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

/** Read and call surface. Credential storage and the environment stay inside the implementation. */
export interface Models {
  readonly telemetryContext: TelemetryContext;
  getProvider(id: string): Provider | undefined;
  getModel(providerId: string, modelId: string): Model | undefined;
  listModels(): Model[];
  getAuth(model: Model, apiKey?: string): Promise<AuthResult | undefined>;
  stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ApiStreamOptions<TApi>): AssistantEventStream;
  streamSimple(model: Model, context: Context, options?: StreamOptions): AssistantEventStream;
  completeSimple(model: Model, context: Context, options?: StreamOptions): Promise<AssistantMessage>;
}

/** Management surface for assembling a collection. */
export interface MutableModels extends Models {
  setProvider(provider: Provider): void;
}

/**
 * A provider owns its catalog, its auth, and its stream.
 * The collection routes every call to the provider named by the model.
 */
class ModelRegistry implements MutableModels {
  private readonly providers = new Map<string, Provider>();
  private readonly store: CredentialStore;
  private readonly env: Record<string, string | undefined>;
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
    return resolveModelAuth({
      providerId: provider.id,
      auth: provider.auth,
      store: this.store,
      env: this.env,
      refresh: false,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  }

  stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ApiStreamOptions<TApi>): AssistantEventStream {
    return this.open(model, context, options, "stream");
  }

  streamSimple(model: Model, context: Context, options: StreamOptions = {}): AssistantEventStream {
    return this.open(model, context, options, "simple");
  }

  async completeSimple(model: Model, context: Context, options: StreamOptions = {}): Promise<AssistantMessage> {
    return this.streamSimple(model, context, options).result();
  }

  private open(model: Model, context: Context, options: StreamOptions | undefined, kind: "stream" | "simple"): AssistantEventStream {
    const transcript = normalizeContext(context);
    const stream = createAssistantEventStream();
    const request = options ?? {};
    void createTypedSpanStarter(request.telemetryContext ?? this.telemetryContext, [aiTelemetrySchema])(
      "amazme.ai.request",
      { provider: model.provider, model: model.id, api: model.api },
      async (span) => {
        const opened = await this.dispatch(model, transcript, { ...request, telemetryContext: span }, kind);
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
        const message = errorMessage(model, error, request.signal?.aborted === true);
        stream.push({ type: "error", error: message });
      });
    return stream;
  }

  private async dispatch(model: Model, context: Context, options: StreamOptions, kind: "stream" | "simple"): Promise<AssistantEventStream> {
    const provider = this.providers.get(model.provider);
    if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
    const known = provider.getModels().some((item) => item.id === model.id);
    if (!known) throw new ModelsError("model", `Unknown model: ${model.provider}/${model.id}`);
    let auth;
    try {
      auth = await resolveModelAuth({
        providerId: provider.id,
        auth: provider.auth,
        store: this.store,
        env: this.env,
        refresh: true,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      });
    } catch (error) {
      if (error instanceof AuthRefreshError) throw new ModelsError("auth", error.message);
      throw error;
    }
    options.signal?.throwIfAborted();
    if (!auth) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
    const headers = { ...(auth.headers ?? {}), ...(options.headers ?? {}) };
    const env = { ...(auth.env ?? {}), ...(options.env ?? {}) };
    const authed = {
      ...options,
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(options.baseUrl || auth.baseUrl ? { baseUrl: options.baseUrl || auth.baseUrl } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
    return kind === "simple" ? provider.streamSimple(model, context, authed) : provider.stream(model, context, authed);
  }
}

export function createModels(options?: ModelsOptions): MutableModels {
  return new ModelRegistry(options);
}

function isStreams(value: unknown): value is ProviderStreams {
  return !!value && typeof value === "object"
    && typeof (value as ProviderStreams).stream === "function"
    && typeof (value as ProviderStreams).streamSimple === "function";
}

/**
 * Compose a catalog, auth, base URL, and headers with one protocol implementation
 * or a table keyed by `model.api`. Invalid assembly throws. A call whose API is
 * missing from the table becomes one error terminal.
 */
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
  if (input.id.trim() === "") throw new ModelsError("provider", "Provider id is required");
  const single = isStreams(input.api) ? input.api : undefined;
  const byApi = single ? undefined : input.api as Partial<Record<string, ProviderStreams>>;
  const implementations = single ? [single] : Object.values(byApi ?? {}).filter(isStreams);
  if (implementations.length === 0) {
    throw new ModelsError("provider", `Provider ${input.id}: api implementation is required`);
  }
  if (byApi) {
    for (const model of input.models) {
      if (!isStreams(byApi[model.api])) {
        throw new ModelsError("provider", `Provider ${input.id} has no API implementation for "${model.api}"`);
      }
    }
  }
  const auth = providerAuth(input.auth);
  const merge = (model: Model, provided: StreamOptions = {}): StreamOptions => {
    const headers = { ...(input.headers ?? {}), ...(provided.headers ?? {}) };
    const baseUrl = provided.baseUrl ?? model.baseUrl ?? input.baseUrl;
    return {
      ...provided,
      ...(baseUrl ? { baseUrl } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  };
  const missing = (model: Model): AssistantEventStream => {
    const stream = createAssistantEventStream();
    const message = errorMessage(model, new ModelsError("provider", `Provider ${input.id} has no API implementation for "${model.api}"`), false);
    queueMicrotask(() => stream.push({ type: "error", error: message }));
    return stream;
  };
  const implementationFor = (model: Model): ProviderStreams | undefined => single ?? (isStreams(byApi?.[model.api]) ? byApi?.[model.api] : undefined);
  return {
    id: input.id,
    name: input.name ?? input.id,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
    auth,
    getModels: () => input.models,
    stream(model, context, options) {
      const implementation = implementationFor(model);
      if (!implementation) return missing(model);
      return implementation.stream<Api>(model, context, merge(model, options));
    },
    streamSimple(model, context, options) {
      const implementation = implementationFor(model);
      if (!implementation) return missing(model);
      return implementation.streamSimple(model, context, merge(model, options));
    },
  };
}

export function hasApi<TApi extends Api>(model: Model, api: TApi): model is Model<TApi> {
  return model.api === api;
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
