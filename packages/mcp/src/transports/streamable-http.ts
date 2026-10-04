import { setTimeout as nodeSetTimeout } from "node:timers";
import type { AuthProvider, McpFetch, UnauthorizedContext } from "../auth-provider.ts";
import { authorizationChallengeKey, parseWwwAuthenticate } from "../auth-challenge.ts";
import {
  isJsonRpcRequest,
  isJsonRpcResponse,
  isObject,
  JSON_RPC_ERROR_CODES,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  MCP_ERROR_CODES,
  McpConnectionClosedError,
  parseJsonRpcMessage,
  toError,
} from "../protocol/jsonrpc.ts";
import type { ProtocolEra, Tool } from "../protocol/types.ts";
import { extractToolHeaderMappings, type ToolHeaderMapping } from "../protocol/tool-headers.ts";
import { McpAuthRequiredError, McpHttpError, McpSessionExpiredError } from "./http-errors.ts";
import { DEFAULT_MAX_MESSAGE_BYTES, type McpTransport, TransportEvents } from "./transport.ts";

const MAX_ERROR_BODY_BYTES = 8 * 1024;
const ERROR_MESSAGE_BODY_CHARS = 500;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_MAX_RETRIES = 5;
const RECOGNIZED_MODERN_CODES = new Set<number>([
  MCP_ERROR_CODES.headerMismatch,
  MCP_ERROR_CODES.missingRequiredClientCapability,
  MCP_ERROR_CODES.unsupportedProtocolVersion,
  JSON_RPC_ERROR_CODES.methodNotFound,
]);

export interface StreamableHttpReconnectOptions {
  /** Delay before the first reconnection attempt, unless the server sent `retry`. Default: 1000. */
  initialDelayMs?: number;
  /** Upper bound for the exponential backoff. Default: 30000. */
  maxDelayMs?: number;
  /** Consecutive failed attempts before giving up on a stream. Default: 5. */
  maxRetries?: number;
}

export interface StreamableHttpTransportOptions {
  url: string | URL;
  headers?: Record<string, string>;
  fetch?: McpFetch;
  /** Open the legacy server-to-client GET stream after `notifications/initialized`. Default: true. */
  openGetStream?: boolean;
  maxMessageBytes?: number;
  authProvider?: AuthProvider;
  /** Legacy SSE reconnection. Modern response streams are not resumed. */
  reconnect?: StreamableHttpReconnectOptions;
}

interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

interface StreamCursor {
  lastEventId: string | undefined;
  retryMs: number | undefined;
  received: boolean;
}

interface RefreshGroup {
  key: string;
  controller: AbortController;
  promise: Promise<void>;
  waiters: number;
  settled: boolean;
}

function contentType(response: Response): string | undefined {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

/** 401, or 403 with an `insufficient_scope` challenge. */
function needsAuthorization(response: Response): boolean {
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  return parseWwwAuthenticate(response.headers.get("www-authenticate")).error === "insufficient_scope";
}

function authorizationKey(response: Response): string {
  const challenge = parseWwwAuthenticate(response.headers.get("www-authenticate"));
  return authorizationChallengeKey(response.status, challenge);
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function discard(response: Response): Promise<void> {
  return response.body?.cancel().catch(() => undefined) ?? Promise.resolve();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted", "AbortError");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function readBody(response: Response, limit: number, signal: AbortSignal, truncate = false): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      const remaining = limit - bytes;
      if (value.byteLength > remaining) {
        if (!truncate) throw new Error(`MCP HTTP message exceeds ${limit} bytes`);
        chunks.push(value.subarray(0, remaining));
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
      if (truncate && bytes === limit) break;
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function describeHttpFailure(status: number, body: string): string {
  const text = body.trim();
  const snippet = text.length > ERROR_MESSAGE_BODY_CHARS ? `${text.slice(0, ERROR_MESSAGE_BODY_CHARS - 3)}...` : text;
  return `MCP HTTP request failed with status ${status}${snippet ? `: ${snippet}` : ""}`;
}

/**
 * Header values are visible ASCII, space, and tab. Anything else, leading or trailing
 * whitespace, or a value that already looks like the Base64 sentinel is encoded.
 */
function encodeHeaderValue(value: string): string {
  const sentinel = value.startsWith("=?base64?") && value.endsWith("?=");
  const plain = /^[\t\x20-\x7e]+$/.test(value) && value === value.trim() && !sentinel;
  if (plain) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function requestName(message: JsonRpcRequest): string | undefined {
  if (!isObject(message.params)) return undefined;
  if ((message.method === "tools/call" || message.method === "prompts/get") && typeof message.params.name === "string") {
    return message.params.name;
  }
  if (message.method === "resources/read" && typeof message.params.uri === "string") return message.params.uri;
  return undefined;
}

function parseJsonBody(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecognizedModernError(value: unknown): value is JsonRpcMessage {
  return isJsonRpcResponse(value) && "error" in value && RECOGNIZED_MODERN_CODES.has(value.error.code);
}

async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  maxEventBytes: number,
  onEvent: (event: SseEvent) => void,
  onId: (id: string) => void,
  onRetry: (delayMs: number) => void,
  signal: AbortSignal,
  shouldStop: () => boolean,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let eventName: string | undefined;
  let eventId: string | undefined;
  let dataLines: string[] = [];
  let dataBytes = 0;
  let skipLf = false;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = undefined;
      eventId = undefined;
      return;
    }
    const data = dataLines.join("\n");
    onEvent({ ...(eventName ? { event: eventName } : {}), data, ...(eventId ? { id: eventId } : {}) });
    eventName = undefined;
    eventId = undefined;
    dataLines = [];
    dataBytes = 0;
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      dataBytes += Buffer.byteLength(value) + (dataLines.length > 0 ? 1 : 0);
      if (dataBytes > maxEventBytes) throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
      dataLines.push(value);
    } else if (field === "event") eventName = value;
    else if (field === "id" && !value.includes("\0")) {
      eventId = value;
      onId(value);
    } else if (field === "retry" && /^\d+$/.test(value) && Number.isFinite(Number(value))) onRetry(Number(value));
  };

  const processBufferedLines = () => {
    while (buffered.length > 0) {
      if (skipLf) {
        if (buffered.startsWith("\n")) buffered = buffered.slice(1);
        skipLf = false;
      }
      const newline = buffered.search(/[\r\n]/);
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      skipLf = buffered[newline] === "\r";
      buffered = buffered.slice(newline + 1);
      processLine(line);
      if (shouldStop()) return;
    }
  };

  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      processBufferedLines();
      if (shouldStop()) return;
      if (Buffer.byteLength(buffered) > maxEventBytes) throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
    }
    buffered += decoder.decode();
    processBufferedLines();
    // SSE dispatch requires a blank line; EOF discards an incomplete event.
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class StreamableHttpTransport extends TransportEvents implements McpTransport {
  readonly probe = "http" as const;
  readonly url: URL;
  readonly options: Readonly<StreamableHttpTransportOptions>;
  private fetchImpl: McpFetch;
  private closeController = new AbortController();
  private requests = new Map<JsonRpcId, AbortController>();
  private started = false;
  private closed = false;
  private era: ProtocolEra | undefined;
  private sessionIdValue: string | undefined;
  private protocolVersion: string | undefined;
  private getStreamStarted = false;
  private refreshInFlight: RefreshGroup | undefined;
  private toolHeaders = new Map<string, ToolHeaderMapping[]>();
  private closePromise: Promise<void> | undefined;

  constructor(options: StreamableHttpTransportOptions) {
    super();
    this.options = Object.freeze({ ...options, headers: options.headers ? { ...options.headers } : undefined });
    this.url = new URL(options.url);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    // Cloudflare Workers reject fetch when `this` is a receiver other than the global object.
    this.fetchImpl = (input, init) => fetchImpl.call(undefined, input, init);
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("MCP Streamable HTTP transport already started");
    if (this.closed) throw new McpConnectionClosedError();
    this.started = true;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  setEra(era: ProtocolEra): void {
    this.era = era;
    // The legacy handshake must not advertise the modern version while it is still negotiating.
    if (era === "legacy") this.protocolVersion = undefined;
  }

  setToolSchemas(tools: readonly Tool[]): void {
    const mappings = new Map<string, ToolHeaderMapping[]>();
    if (this.era === "modern") {
      for (const tool of tools) mappings.set(tool.name, extractToolHeaderMappings(tool.inputSchema));
    }
    this.toolHeaders = mappings;
  }

  abortRequest(id: JsonRpcId): void {
    this.requests.get(id)?.abort();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.started || this.closed) throw new McpConnectionClosedError();
    const request = isJsonRpcRequest(message) ? message : undefined;
    const controller = request ? new AbortController() : undefined;
    if (request && controller) this.requests.set(request.id, controller);
    const signal = controller ? AbortSignal.any([this.closeController.signal, controller.signal]) : this.closeController.signal;
    let streaming = false;
    try {
      const response = await this.authorizedFetch(
        "POST",
        {
          headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
          body: JSON.stringify(message),
          signal,
        },
        message,
      );
      streaming = await this.handlePost(response, message, signal);
    } finally {
      if (request && !streaming) this.requests.delete(request.id);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closeController.abort();
    this.closePromise = this.deleteSession().finally(() => this.emitClose());
    return this.closePromise;
  }

  /** Returns true when the response body is still streaming after this method returns. */
  private async handlePost(response: Response, message: JsonRpcMessage, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) {
      await discard(response);
      signal.throwIfAborted();
    }
    if (!response.ok) {
      await this.failHttp(response, signal, isJsonRpcRequest(message) ? message.id : undefined);
      return false;
    }
    this.captureSession(response);
    const request = isJsonRpcRequest(message) ? message : undefined;
    if (!request) {
      await discard(response);
      if ("method" in message && message.method === "notifications/initialized") this.startGetStream();
      return false;
    }
    if (response.status === 202 || response.status === 204) {
      await discard(response);
      throw new McpHttpError(response.status, `MCP server accepted request ${request.method} without a response`);
    }
    const type = contentType(response);
    if (type === "application/json") {
      const body: unknown = JSON.parse(await readBody(response, this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES, signal));
      if (this.era === "modern" && Array.isArray(body)) throw new Error("MCP HTTP response must be a single JSON-RPC response");
      const messages = (Array.isArray(body) ? body : [body]).map(parseJsonRpcMessage);
      for (const parsed of messages) this.validateResponseMessage(parsed, request.id, true);
      for (const parsed of messages) this.emitMessage(parsed);
      return false;
    }
    if (type === "text/event-stream" && response.body) {
      const body = response.body;
      void this.consumeResponseStream(body, request).finally(() => this.requests.delete(request.id));
      return true;
    }
    await discard(response);
    throw new McpHttpError(response.status, `Unsupported MCP response content type: ${type ?? "missing"}`);
  }

  /**
   * A recognized modern JSON-RPC error stays on the modern path.
   * HTTP 400 with any other body is the legacy `initialize` signal.
   * HTTP 404 or 405 without that error is deprecated HTTP+SSE, which this client does not speak.
   */
  private async failHttp(response: Response, signal = this.closeController.signal, requestId?: JsonRpcId): Promise<void> {
    const body = await readBody(response, MAX_ERROR_BODY_BYTES, signal, true);
    if (needsAuthorization(response)) throw new McpAuthRequiredError(response, body);
    if (response.status === 404 && this.sessionIdValue) throw new McpSessionExpiredError(body);
    const raw = parseJsonBody(body);
    // HTTP failures may omit id when rejection occurs before the RPC body was accepted.
    const parsed = requestId !== undefined && isObject(raw) && raw.jsonrpc === "2.0" && isObject(raw.error) && raw.id === undefined
      ? { ...raw, id: requestId }
      : raw;
    if (isRecognizedModernError(parsed)) {
      if (requestId !== undefined) this.validateResponseMessage(parsed, requestId, true);
      this.emitMessage(parsed);
      return;
    }
    if (response.status === 400) throw new McpHttpError(400, describeHttpFailure(400, body), body);
    if (response.status === 404 || response.status === 405) {
      throw new McpHttpError(
        response.status,
        `MCP HTTP ${response.status} without a modern JSON-RPC error. The deprecated HTTP+SSE transport is not implemented.`,
        body,
      );
    }
    if (isJsonRpcResponse(parsed) && "error" in parsed) {
      if (requestId !== undefined) this.validateResponseMessage(parsed, requestId, true);
      this.emitMessage(parsed);
      return;
    }
    throw new McpHttpError(response.status, describeHttpFailure(response.status, body), body);
  }

  private async authorizedFetch(
    method: "GET" | "POST" | "DELETE",
    init: { headers?: Record<string, string>; body?: string; signal?: AbortSignal },
    message?: JsonRpcMessage,
  ): Promise<Response> {
    const onUnauthorized = this.options.authProvider?.onUnauthorized;
    const signal = init.signal ?? this.closeController.signal;
    for (let attempt = 0; ; attempt++) {
      const prepared = await this.headers(init.headers, message, signal);
      signal.throwIfAborted();
      const fetchPromise = this.fetchImpl(this.url, {
        method,
        headers: prepared.headers,
        body: init.body,
        signal,
      });
      void fetchPromise.then((response) => { if (signal.aborted) void discard(response); }, () => undefined);
      const response = await abortable(fetchPromise, signal);
      if (attempt > 0 || !onUnauthorized || !needsAuthorization(response)) return response;
      const context: UnauthorizedContext = {
        response,
        serverUrl: this.url,
        fetch: this.fetchImpl,
        signal,
        ...(prepared.token ? { token: prepared.token } : {}),
      };
      try {
        const currentToken = await abortable(this.options.authProvider!.token(this.url), signal);
        if (response.status !== 401 || !currentToken || currentToken === prepared.token) await this.refreshOnce(context, signal);
      } finally {
        await discard(response);
      }
    }
  }

  private async refreshOnce(context: UnauthorizedContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const key = authorizationKey(context.response);
    while (this.refreshInFlight && this.refreshInFlight.key !== key) {
      const previous = this.refreshInFlight;
      try {
        await abortable(previous.promise, AbortSignal.any([signal, previous.controller.signal]));
      } catch {
        // A different challenge needs its own attempt, even if the previous one requires a redirect.
        signal.throwIfAborted();
      }
    }
    if (!this.refreshInFlight) {
      const provider = this.options.authProvider;
      const refresh = provider?.onUnauthorized;
      if (!provider || !refresh) return Promise.resolve();
      const group: RefreshGroup = {
        key,
        controller: new AbortController(),
        promise: Promise.resolve(),
        waiters: 0,
        settled: false,
      };
      this.refreshInFlight = group;
      group.promise = Promise.resolve().then(() => refresh.call(provider, { ...context, signal: group.controller.signal })).finally(() => {
        group.settled = true;
        if (this.refreshInFlight === group) this.refreshInFlight = undefined;
      });
    }
    const group = this.refreshInFlight;
    group.waiters += 1;
    try {
      await abortable(group.promise, signal);
    } finally {
      group.waiters -= 1;
      if (group.waiters === 0 && !group.settled) {
        if (this.refreshInFlight === group) this.refreshInFlight = undefined;
        group.controller.abort();
      }
    }
  }

  private async headers(
    extra: Record<string, string> = {},
    message?: JsonRpcMessage,
    signal = this.closeController.signal,
  ): Promise<{ headers: Headers; token?: string }> {
    signal.throwIfAborted();
    const headers = new Headers(this.options.headers);
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    if (this.era === "legacy" && this.sessionIdValue) headers.set("Mcp-Session-Id", this.sessionIdValue);
    if (this.protocolVersion) headers.set("MCP-Protocol-Version", this.protocolVersion);
    if (message) this.applyModernHeaders(headers, message);
    const token = this.options.authProvider ? await abortable(this.options.authProvider.token(this.url), signal) : undefined;
    signal.throwIfAborted();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return { headers, ...(token ? { token } : {}) };
  }

  private applyModernHeaders(headers: Headers, message: JsonRpcMessage): void {
    if (this.era !== "modern" || !("method" in message)) return;
    headers.set("Mcp-Method", message.method);
    if (!isJsonRpcRequest(message)) return;
    const name = requestName(message);
    if (name !== undefined) headers.set("Mcp-Name", encodeHeaderValue(name));
    if (message.method !== "tools/call" || name === undefined || !isObject(message.params)) return;
    for (const mapping of this.toolHeaders.get(name) ?? []) {
      let value: unknown = message.params.arguments;
      for (const key of mapping.path) {
        value = isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
      }
      if (value === undefined || value === null) continue;
      const valid = mapping.type === "integer" ? typeof value === "number" && Number.isSafeInteger(value) : typeof value === mapping.type;
      if (!valid) throw new Error(`Invalid MCP tool header argument at ${mapping.path.join(".")}: expected ${mapping.type}`);
      headers.set(`Mcp-Param-${mapping.name}`, encodeHeaderValue(String(value)));
    }
  }

  private captureSession(response: Response): void {
    if (this.era !== "legacy") return;
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionIdValue = sessionId;
  }

  private async consumeResponseStream(body: ReadableStream<Uint8Array>, request: JsonRpcRequest): Promise<void> {
    const requestId = request.id;
    const progressToken = isObject(request.params) && isObject(request.params._meta) ? request.params._meta.progressToken : undefined;
    const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined, received: false };
    let answered = false;
    const controller = this.requests.get(requestId);
    const signal = controller ? AbortSignal.any([controller.signal, this.closeController.signal]) : this.closeController.signal;
    const onMessage = (message: JsonRpcMessage) => {
      if (isJsonRpcResponse(message) && message.id === requestId) answered = true;
    };
    let stream: ReadableStream<Uint8Array> | undefined = body;
    let failure: unknown;
    for (let attempt = 0; ; ) {
      if (signal.aborted) {
        if (stream) await stream.cancel().catch(() => undefined);
        return;
      }
      if (stream) {
        try {
          await this.readSse(stream, cursor, signal, onMessage, requestId, () => answered, progressToken);
          failure = undefined;
        } catch (error) {
          failure = error;
        }
      }
      if (answered || this.closed || this.requests.get(requestId)?.signal.aborted) return;
      const canResume = this.era === "legacy" && cursor.lastEventId !== undefined;
      if (!canResume || (failure !== undefined && !this.isRetryable(failure)) || attempt >= this.maxRetries()) break;
      if (cursor.received) attempt = 0;
      cursor.received = false;
      if (!(await this.sleep(this.reconnectDelay(attempt++, cursor.retryMs), signal))) return;
      try {
        stream = await this.openSseStream(cursor.lastEventId, signal);
      } catch (error) {
        failure = error;
        if (!this.isRetryable(error)) break;
        stream = undefined;
      }
    }
    if (this.closed || this.requests.get(requestId)?.signal.aborted) return;
    const reason = failure === undefined ? "stream ended without a response" : toError(failure).message;
    this.emitMessage({
      jsonrpc: "2.0",
      id: requestId,
      error: { code: JSON_RPC_ERROR_CODES.internalError, message: `MCP response stream failed: ${reason}` },
    });
  }

  private startGetStream(): void {
    if (this.era !== "legacy" || this.options.openGetStream === false || this.getStreamStarted || this.closed) return;
    this.getStreamStarted = true;
    void this.runGetStream();
  }

  private async runGetStream(): Promise<void> {
    const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined, received: false };
    for (let attempt = 0; !this.closed; ) {
      try {
        const stream = await this.openSseStream(cursor.lastEventId);
        if (!stream) return;
        const openedAt = Date.now();
        await this.readSse(stream, cursor, this.closeController.signal);
        if (cursor.received || Date.now() - openedAt > this.maxDelay()) attempt = 0;
      } catch (error) {
        if (this.closed) return;
        if (!this.isRetryable(error)) {
          this.emitError(error);
          return;
        }
      }
      cursor.received = false;
      if (attempt >= this.maxRetries()) {
        this.emitError(new Error("MCP server-to-client stream dropped and could not be reopened"));
        return;
      }
      if (!(await this.sleep(this.reconnectDelay(attempt++, cursor.retryMs)))) return;
    }
  }

  /** Opens a GET SSE stream. `undefined` means the server answered 405. */
  private async openSseStream(lastEventId: string | undefined, signal = this.closeController.signal): Promise<ReadableStream<Uint8Array> | undefined> {
    const response = await this.authorizedFetch("GET", {
      headers: {
        accept: "text/event-stream",
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
      },
      signal,
    });
    if (response.status === 405) {
      await discard(response);
      return undefined;
    }
    if (!response.ok) {
      await this.failHttp(response, signal);
      return undefined;
    }
    this.captureSession(response);
    const type = contentType(response);
    if (type !== "text/event-stream" || !response.body) {
      await discard(response);
      throw new McpHttpError(response.status, `Unsupported MCP GET response content type: ${type ?? "missing"}`);
    }
    return response.body;
  }

  private validateResponseMessage(message: JsonRpcMessage, requestId: JsonRpcId, final = false, progressToken?: unknown): void {
    if (isJsonRpcResponse(message)) {
      if (message.id !== requestId) throw new Error(`MCP HTTP response id does not match request id ${requestId}`);
    } else if (final || (this.era === "modern" && isJsonRpcRequest(message))) {
      throw new Error("MCP HTTP response is not a response to the originating request");
    } else if (this.era === "modern" && "method" in message && message.method === "notifications/progress") {
      if (progressToken === undefined || !isObject(message.params) || message.params.progressToken !== progressToken) {
        throw new Error("MCP HTTP progress token does not match the originating request");
      }
    }
  }

  private async readSse(
    stream: ReadableStream<Uint8Array>,
    cursor: StreamCursor,
    signal: AbortSignal,
    onMessage?: (message: JsonRpcMessage) => void,
    requestId?: JsonRpcId,
    shouldStop: () => boolean = () => false,
    progressToken?: unknown,
  ): Promise<void> {
    await consumeSse(
      stream,
      this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
      (event) => {
        cursor.received = true;
        if (!event.data.trim() || (event.event !== undefined && event.event !== "message")) return;
        let message: JsonRpcMessage;
        try {
          message = parseJsonRpcMessage(JSON.parse(event.data));
        } catch (error) {
          this.emitError(error);
          return;
        }
        if (requestId !== undefined) this.validateResponseMessage(message, requestId, false, progressToken);
        onMessage?.(message);
        this.emitMessage(message);
      },
      (id) => {
        cursor.lastEventId = id || undefined;
      },
      (delayMs) => {
        cursor.retryMs = delayMs;
      },
      signal,
      shouldStop,
    );
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof McpHttpError) return isTransientStatus(error.status);
    if (error instanceof TypeError) return true;
    const code = (error as { code?: unknown } | undefined)?.code;
    return typeof code === "string" && (code.startsWith("E") || code.startsWith("UND_ERR"));
  }

  private reconnectDelay(attempt: number, serverDelayMs: number | undefined): number {
    if (serverDelayMs !== undefined) return Math.min(serverDelayMs, this.maxDelay());
    const initial = this.options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
    return Math.min(initial * 2 ** attempt, this.maxDelay());
  }

  private maxDelay(): number {
    return this.options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  }

  private maxRetries(): number {
    return this.options.reconnect?.maxRetries ?? DEFAULT_RECONNECT_MAX_RETRIES;
  }

  private sleep(ms: number, signal = this.closeController.signal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof nodeSetTimeout> | undefined;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        resolve(false);
      };
      timer = nodeSetTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      }, ms);
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async deleteSession(): Promise<void> {
    if (this.era !== "legacy" || !this.started || !this.sessionIdValue) return;
    const controller = new AbortController();
    const timeout = nodeSetTimeout(() => controller.abort(), 1_000);
    timeout.unref();
    try {
      const { headers } = await this.headers({}, undefined, controller.signal);
      await abortable(this.fetchImpl(this.url, { method: "DELETE", headers, signal: controller.signal }), controller.signal).then(discard).catch(() => undefined);
    } catch {
      // The server can expire the session on its own.
    } finally {
      clearTimeout(timeout);
    }
  }
}
