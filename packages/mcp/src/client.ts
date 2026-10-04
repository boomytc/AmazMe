import type { CallToolResult } from "./protocol/content.ts";
import {
  isJsonRpcId,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonValue,
  isModernProtocolError,
  isObject,
  JSON_RPC_ERROR_CODES,
  MCP_ERROR_CODES,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  McpAbortError,
  McpConnectionClosedError,
  McpError,
  McpInputRequiredError,
  McpTimeoutError,
  toError,
} from "./protocol/jsonrpc.ts";
import {
  type ClientCapabilities,
  type DiscoverResult,
  type Implementation,
  type InitializeResult,
  isLegacyProtocolVersion,
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSION,
  type ProgressNotification,
  type ProtocolEra,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type Root,
  type ServerCapabilities,
  type Tool,
} from "./protocol/types.ts";
import type { McpTransport } from "./transports/transport.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
const MAX_LIST_PAGES = 1_000;

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

type ClientState = "idle" | "connecting" | "connected" | "closed";
type NotificationListener = (params: unknown) => void;
type ErrorListener = (error: Error) => void;
type CloseListener = () => void;
type RequestHandler = (params: unknown, context: { signal: AbortSignal }) => unknown | Promise<unknown>;

export interface McpClientOptions extends Implementation {
  capabilities?: ClientCapabilities;
  /**
   * Force one revision. A legacy revision skips `server/discover` and opens with `initialize`.
   * Omitting it probes the modern revision, then falls back to `2025-11-25` when the probe
   * is not a modern response.
   */
  protocolVersion?: typeof MODERN_PROTOCOL_VERSION | (typeof LEGACY_PROTOCOL_VERSIONS)[number];
  /** Idle limit. A progress notification starts this window again. `0` disables it. */
  requestTimeoutMs?: number;
  /** Absolute limit for one request. Progress does not move it. `0` disables it. */
  maxTimeoutMs?: number;
  roots?: readonly Root[] | (() => readonly Root[] | Promise<readonly Root[]>);
}

export interface McpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  onProgress?: (progress: ProgressNotification) => void;
}

export interface McpConnection {
  era: ProtocolEra;
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo?: Implementation;
  instructions?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  idleMs: number;
  maxMs: number;
  deadline: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  signal: AbortSignal | undefined;
  onAbort: () => void;
  cancellable: boolean;
  onProgress: ((progress: ProgressNotification) => void) | undefined;
  progressToken: JsonRpcId | undefined;
}

function invalid(message: string): McpError {
  return new McpError(JSON_RPC_ERROR_CODES.invalidRequest, message);
}

function validateInitializeResult(value: unknown): InitializeResult {
  if (
    !isObject(value) ||
    typeof value.protocolVersion !== "string" ||
    !isObject(value.capabilities) ||
    !isObject(value.serverInfo) ||
    typeof value.serverInfo.name !== "string" ||
    typeof value.serverInfo.version !== "string" ||
    (value.instructions !== undefined && typeof value.instructions !== "string")
  ) {
    throw invalid("Invalid MCP initialize result");
  }
  return value as unknown as InitializeResult;
}

function validateDiscoverResult(value: unknown): DiscoverResult {
  if (
    !isObject(value) ||
    !Array.isArray(value.supportedVersions) ||
    value.supportedVersions.length === 0 ||
    value.supportedVersions.some((version) => typeof version !== "string") ||
    !isObject(value.capabilities) ||
    (value.instructions !== undefined && typeof value.instructions !== "string")
  ) {
    throw invalid("Invalid MCP server/discover result");
  }
  return value as unknown as DiscoverResult;
}

function serverInfoFromMeta(value: Record<string, unknown>): Implementation | undefined {
  const meta = isObject(value._meta) ? value._meta : undefined;
  const info = meta?.[SERVER_INFO_KEY];
  if (!isObject(info) || typeof info.name !== "string" || typeof info.version !== "string") return undefined;
  const title = info.title;
  return {
    name: info.name,
    version: info.version,
    ...(typeof title === "string" ? { title } : {}),
  };
}

function validateListPage(
  method: string,
  key: string,
  value: unknown,
  era: ProtocolEra,
  isItem: (item: Record<string, unknown>) => boolean,
): { items: Record<string, unknown>[]; nextCursor?: string } {
  const items = isObject(value) ? value[key] : undefined;
  if (!isObject(value) || !Array.isArray(items)) throw invalid(`Invalid MCP ${method} result`);
  for (const item of items) {
    if (!isObject(item) || !isItem(item)) throw invalid(`Invalid entry in MCP ${method} result`);
  }
  // 2026-07-28: an empty string is a cursor. Legacy servers also used "" and null to mean the end.
  const raw = value.nextCursor;
  if (raw === undefined || raw === null || (raw === "" && era === "legacy")) {
    return { items };
  }
  if (typeof raw !== "string") throw invalid(`Invalid MCP ${method} cursor`);
  return { items, nextCursor: raw };
}

const isTool = (tool: Record<string, unknown>) => typeof tool.name === "string" && isObject(tool.inputSchema);
const isResource = (resource: Record<string, unknown>) =>
  typeof resource.uri === "string" && (resource.name === undefined || typeof resource.name === "string");
const isResourceTemplate = (template: Record<string, unknown>) =>
  typeof template.uriTemplate === "string" && (template.name === undefined || typeof template.name === "string");

function toResource(item: Record<string, unknown>): Resource {
  return { ...item, name: typeof item.name === "string" ? item.name : item.uri } as Resource;
}

function toResourceTemplate(item: Record<string, unknown>): ResourceTemplate {
  return { ...item, name: typeof item.name === "string" ? item.name : item.uriTemplate } as ResourceTemplate;
}

function validateReadResourceResult(value: unknown): ReadResourceResult {
  if (!isObject(value) || !Array.isArray(value.contents)) throw invalid("Invalid MCP resources/read result");
  for (const contents of value.contents) {
    if (
      !isObject(contents) ||
      typeof contents.uri !== "string" ||
      (typeof contents.text !== "string" && typeof contents.blob !== "string")
    ) {
      throw invalid("Invalid contents in MCP resources/read result");
    }
  }
  return value as unknown as ReadResourceResult;
}

function validateCallToolResult(value: unknown): CallToolResult {
  if (!isObject(value) || (value.content !== undefined && !Array.isArray(value.content))) {
    throw invalid("Invalid MCP tools/call result");
  }
  if (value.structuredContent !== undefined && !isJsonValue(value.structuredContent)) {
    throw invalid("Invalid MCP tools/call structured content");
  }
  return (value.content === undefined ? { ...value, content: [] } : value) as unknown as CallToolResult;
}

function supportedVersions(error: McpError): string[] {
  if (!isObject(error.data) || !Array.isArray(error.data.supported)) return [];
  return error.data.supported.filter((version): version is string => typeof version === "string");
}

export class McpClient {
  readonly options: Readonly<McpClientOptions>;
  private state: ClientState = "idle";
  private era: ProtocolEra | undefined;
  private transport: McpTransport | undefined;
  private nextRequestId = 1;
  private serverInfoValue: Implementation | undefined;
  private serverCapabilitiesValue: ServerCapabilities | undefined;
  private instructionsValue: string | undefined;
  private protocolVersionValue: string | undefined;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private progressRequests = new Map<JsonRpcId, JsonRpcId>();
  private incoming = new Map<JsonRpcId, AbortController>();
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationListeners = new Map<string, Set<NotificationListener>>();
  private errorListeners = new Set<ErrorListener>();
  private closeListeners = new Set<CloseListener>();
  private disposers: Array<() => void> = [];

  constructor(options: McpClientOptions) {
    if (options.name.trim() === "" || options.version.trim() === "") {
      throw new Error("MCP client name and version are required");
    }
    this.options = Object.freeze({ ...options });
    this.requestHandlers.set("ping", () => ({}));
    const roots = options.roots;
    if (roots) {
      this.requestHandlers.set("roots/list", async () => ({
        roots: [...(typeof roots === "function" ? await roots() : roots)],
      }));
    }
  }

  get connectionState(): ClientState {
    return this.state;
  }

  get protocolEra(): ProtocolEra | undefined {
    return this.era;
  }

  get serverInfo(): Implementation | undefined {
    return this.serverInfoValue;
  }

  get serverCapabilities(): ServerCapabilities | undefined {
    return this.serverCapabilitiesValue;
  }

  get instructions(): string | undefined {
    return this.instructionsValue;
  }

  get protocolVersion(): string | undefined {
    return this.protocolVersionValue;
  }

  async connect(transport: McpTransport): Promise<McpConnection> {
    if (this.state !== "idle") throw new Error(`Cannot connect MCP client in ${this.state} state`);
    this.state = "connecting";
    this.transport = transport;
    this.disposers = [
      transport.onMessage((message) => this.handleMessage(message)),
      transport.onError((error) => this.emitError(error)),
      transport.onClose(() => this.handleTransportClose()),
    ];
    try {
      await transport.start();
      await this.negotiate();
      this.state = "connected";
      return this.connection();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  request<Result = unknown>(method: string, params?: Record<string, unknown>, options: McpRequestOptions = {}): Promise<Result> {
    return this.requestInternal(method, params, options, false) as Promise<Result>;
  }

  notify(method: string, params?: Record<string, unknown>): Promise<void> {
    return this.notifyInternal(method, params, false);
  }

  setRequestHandler(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
    };
  }

  onNotification(method: string, listener: NotificationListener): () => void {
    const listeners = this.notificationListeners.get(method) ?? new Set<NotificationListener>();
    this.notificationListeners.set(method, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.notificationListeners.delete(method);
    };
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async ping(options: McpRequestOptions = {}): Promise<void> {
    await this.request("ping", undefined, options);
  }

  async listTools(options: McpRequestOptions = {}): Promise<Tool[]> {
    return (await this.listAll("tools/list", "tools", isTool, options)) as unknown as Tool[];
  }

  async listResources(options: McpRequestOptions = {}): Promise<Resource[]> {
    return (await this.listAll("resources/list", "resources", isResource, options)).map((item) => toResource(item));
  }

  async listResourceTemplates(options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
    return (await this.listAll("resources/templates/list", "resourceTemplates", isResourceTemplate, options)).map((item) =>
      toResourceTemplate(item),
    );
  }

  async readResource(uri: string, options: McpRequestOptions = {}): Promise<ReadResourceResult> {
    return validateReadResourceResult(await this.request("resources/read", { uri }, options));
  }

  async callTool(name: string, args?: Record<string, unknown>, options: McpRequestOptions = {}): Promise<CallToolResult> {
    return validateCallToolResult(
      await this.request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }, options),
    );
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    this.disposeTransportListeners();
    this.markClosed(new McpConnectionClosedError());
    await transport?.close();
  }

  private connection(): McpConnection {
    const era = this.era;
    const protocolVersion = this.protocolVersionValue;
    const capabilities = this.serverCapabilitiesValue;
    if (!era || !protocolVersion || !capabilities) throw new Error("MCP client is not connected");
    return {
      era,
      protocolVersion,
      capabilities,
      ...(this.serverInfoValue ? { serverInfo: this.serverInfoValue } : {}),
      ...(this.instructionsValue !== undefined ? { instructions: this.instructionsValue } : {}),
    };
  }

  private async negotiate(): Promise<void> {
    const preferred = this.options.protocolVersion;
    if (preferred !== undefined && isLegacyProtocolVersion(preferred)) {
      await this.openLegacy(preferred);
      return;
    }
    try {
      await this.openModern();
    } catch (error) {
      if (preferred === MODERN_PROTOCOL_VERSION || this.state === "closed" || !this.canFallback(error)) throw error;
      await this.openLegacy(LEGACY_PROTOCOL_VERSIONS[0]);
    }
  }

  private canFallback(error: unknown): boolean {
    if (error instanceof McpConnectionClosedError || error instanceof McpAbortError || error instanceof McpInputRequiredError) {
      return false;
    }
    if (isModernProtocolError(error)) return false;
    // The server answered `server/discover` with a result, so it is modern even if the result is unusable.
    if (error instanceof McpError && error.message === "Invalid MCP server/discover result") return false;
    return true;
  }

  private async openModern(): Promise<void> {
    this.era = "modern";
    this.protocolVersionValue = MODERN_PROTOCOL_VERSION;
    const discovered = await this.discoverModern();
    if (!discovered.supportedVersions.includes(MODERN_PROTOCOL_VERSION)) {
      throw new McpError(
        -32022,
        `MCP server does not support ${MODERN_PROTOCOL_VERSION}`,
        { supported: discovered.supportedVersions, requested: MODERN_PROTOCOL_VERSION },
      );
    }
    this.serverCapabilitiesValue = discovered.capabilities;
    this.instructionsValue = discovered.instructions;
    this.serverInfoValue = serverInfoFromMeta(discovered as unknown as Record<string, unknown>);
    this.transport?.setProtocolVersion?.(MODERN_PROTOCOL_VERSION);
    this.transport?.setEra?.("modern");
  }

  private async discoverModern(): Promise<DiscoverResult> {
    try {
      return validateDiscoverResult(await this.requestInternal("server/discover", undefined, {}, true));
    } catch (error) {
      if (
        error instanceof McpError &&
        error.code === MCP_ERROR_CODES.unsupportedProtocolVersion &&
        supportedVersions(error).includes(MODERN_PROTOCOL_VERSION)
      ) {
        return validateDiscoverResult(await this.requestInternal("server/discover", undefined, {}, true));
      }
      throw error;
    }
  }

  private async openLegacy(version: (typeof LEGACY_PROTOCOL_VERSIONS)[number]): Promise<void> {
    this.era = "legacy";
    this.protocolVersionValue = version;
    const capabilities: ClientCapabilities = { ...this.options.capabilities };
    if (this.options.roots && capabilities.roots === undefined) capabilities.roots = {};
    const result = validateInitializeResult(
      await this.requestInternal(
        "initialize",
        {
          protocolVersion: version,
          capabilities,
          clientInfo: this.clientInfo(),
        },
        {},
        true,
      ),
    );
    if (!isLegacyProtocolVersion(result.protocolVersion)) {
      throw new Error(`MCP server selected unsupported protocol version ${result.protocolVersion}`);
    }
    this.protocolVersionValue = result.protocolVersion;
    this.serverInfoValue = result.serverInfo;
    this.serverCapabilitiesValue = result.capabilities;
    this.instructionsValue = result.instructions;
    this.transport?.setProtocolVersion?.(result.protocolVersion);
    this.transport?.setEra?.("legacy");
    await this.notifyInternal("notifications/initialized", undefined, true);
  }

  private clientInfo(): Implementation {
    return {
      name: this.options.name,
      version: this.options.version,
      ...(this.options.title === undefined ? {} : { title: this.options.title }),
    };
  }

  private async listAll(
    method: string,
    key: string,
    isItem: (item: Record<string, unknown>) => boolean,
    options: McpRequestOptions,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    const era = this.era ?? "legacy";
    for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber++) {
      const page = validateListPage(method, key, await this.request(method, cursor === undefined ? undefined : { cursor }, options), era, isItem);
      items.push(...page.items);
      if (page.nextCursor === undefined) return items;
      if (cursors.has(page.nextCursor)) throw new Error(`MCP ${method} returned duplicate cursor: ${page.nextCursor}`);
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error(`MCP ${method} exceeded ${MAX_LIST_PAGES} pages`);
  }

  private async requestInternal(
    method: string,
    params: Record<string, unknown> | undefined,
    options: McpRequestOptions,
    allowConnecting: boolean,
  ): Promise<unknown> {
    const transport = this.requireTransport(allowConnecting);
    if (options.signal?.aborted) throw new McpAbortError();
    const id = this.nextRequestId++;
    const progressToken = options.onProgress ? id : undefined;
    const requestParams = this.withMeta(params, progressToken);
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(requestParams === undefined ? {} : { params: requestParams }),
    };
    const idleMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const maxMs = options.maxTimeoutMs ?? this.options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve,
        reject,
        idleMs,
        maxMs,
        deadline: maxMs > 0 ? Date.now() + maxMs : undefined,
        timer: undefined,
        signal: options.signal,
        onAbort: () => this.cancelPending(id, new McpAbortError(), method !== "initialize", String(options.signal?.reason ?? "Aborted")),
        cancellable: method !== "initialize",
        onProgress: options.onProgress,
        progressToken,
      };
      this.pending.set(id, entry);
      if (progressToken !== undefined) this.progressRequests.set(progressToken, id);
      options.signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.armTimeout(id, entry);
      transport.send(message).catch((error: unknown) => this.cancelPending(id, error, false));
    });
  }

  private withMeta(params: Record<string, unknown> | undefined, progressToken: JsonRpcId | undefined): Record<string, unknown> | undefined {
    const meta: Record<string, unknown> = { ...(isObject(params?._meta) ? params._meta : {}) };
    if (this.era === "modern") {
      meta[PROTOCOL_VERSION_KEY] = this.protocolVersionValue ?? MODERN_PROTOCOL_VERSION;
      meta[CLIENT_INFO_KEY] = this.clientInfo();
      meta[CLIENT_CAPABILITIES_KEY] = { ...this.options.capabilities };
    }
    if (progressToken !== undefined) meta.progressToken = progressToken;
    if (Object.keys(meta).length === 0) return params;
    return { ...params, _meta: meta };
  }

  private async notifyInternal(method: string, params: Record<string, unknown> | undefined, allowConnecting: boolean): Promise<void> {
    await this.requireTransport(allowConnecting).send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private requireTransport(allowConnecting: boolean): McpTransport {
    if (this.transport && (this.state === "connected" || (allowConnecting && this.state === "connecting"))) {
      return this.transport;
    }
    throw new McpConnectionClosedError(`MCP client is ${this.state}`);
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (isJsonRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    if (isJsonRpcRequest(message)) {
      void this.handleRequest(message);
      return;
    }
    if (isJsonRpcNotification(message)) {
      this.handleNotification(message.method, message.params);
      return;
    }
    this.emitError(new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Received invalid JSON-RPC message"));
  }

  private handleResponse(message: JsonRpcResponse): void {
    const entry = this.pending.get(message.id);
    if (!entry) {
      this.emitError(new Error(`Received response for unknown MCP request ${String(message.id)}`));
      return;
    }
    this.removePending(message.id, entry);
    if ("error" in message) {
      entry.reject(new McpError(message.error.code, message.error.message, message.error.data));
      return;
    }
    if (isObject(message.result) && message.result.resultType === "input_required") {
      entry.reject(new McpInputRequiredError(message.result));
      return;
    }
    entry.resolve(message.result);
  }

  private async handleRequest(message: JsonRpcRequest): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      await transport
        .send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `Method not found: ${message.method}` },
        })
        .catch((error: unknown) => this.emitError(error));
      return;
    }
    const controller = new AbortController();
    this.incoming.set(message.id, controller);
    try {
      const result = await handler(message.params, { signal: controller.signal });
      await transport.send({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
    } catch (error) {
      const responseError = error instanceof McpError
        ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
        : { code: JSON_RPC_ERROR_CODES.internalError, message: toError(error).message };
      await transport.send({ jsonrpc: "2.0", id: message.id, error: responseError }).catch((sendError: unknown) => this.emitError(sendError));
    } finally {
      this.incoming.delete(message.id);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "notifications/progress") this.handleProgress(params);
    else if (method === "notifications/cancelled") this.handleCancelled(params);
    for (const listener of this.notificationListeners.get(method) ?? []) {
      try {
        listener(params);
      } catch (error) {
        this.emitError(error);
      }
    }
  }

  private handleProgress(params: unknown): void {
    if (!isObject(params) || !isJsonRpcId(params.progressToken) || typeof params.progress !== "number") return;
    const requestId = this.progressRequests.get(params.progressToken);
    const entry = requestId === undefined ? undefined : this.pending.get(requestId);
    if (requestId === undefined || !entry) return;
    this.armTimeout(requestId, entry);
    try {
      entry.onProgress?.(params as unknown as ProgressNotification);
    } catch (error) {
      this.emitError(error);
    }
  }

  private handleCancelled(params: unknown): void {
    if (isObject(params) && isJsonRpcId(params.requestId)) this.incoming.get(params.requestId)?.abort(params.reason);
  }

  private armTimeout(id: JsonRpcId, entry: PendingRequest): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    const now = Date.now();
    let wait = Number.POSITIVE_INFINITY;
    if (entry.idleMs > 0) wait = entry.idleMs;
    if (entry.deadline !== undefined) wait = Math.min(wait, entry.deadline - now);
    if (!Number.isFinite(wait)) return;
    if (wait <= 0) {
      this.cancelPending(id, new McpTimeoutError(entry.maxMs > 0 ? entry.maxMs : entry.idleMs), entry.cancellable, "Request timed out");
      return;
    }
    const limit = entry.deadline !== undefined && entry.deadline - now <= entry.idleMs ? entry.maxMs : entry.idleMs;
    entry.timer = setTimeout(() => {
      this.cancelPending(id, new McpTimeoutError(limit > 0 ? limit : wait), entry.cancellable, "Request timed out");
    }, wait);
  }

  private cancelPending(id: JsonRpcId, error: unknown, notifyServer: boolean, reason?: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.removePending(id, entry);
    entry.reject(error);
    if (!notifyServer || !this.transport) return;
    this.transport.abortRequest?.(id);
    if (this.era === "modern" && this.transport.probe === "http") return;
    void this.transport
      .send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id, ...(reason ? { reason } : {}) },
      })
      .catch((sendError: unknown) => this.emitError(sendError));
  }

  private removePending(id: JsonRpcId, entry: PendingRequest): void {
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.progressToken !== undefined) this.progressRequests.delete(entry.progressToken);
    entry.signal?.removeEventListener("abort", entry.onAbort);
  }

  private rejectPending(error: unknown): void {
    for (const [id, entry] of this.pending) {
      this.removePending(id, entry);
      entry.reject(error);
    }
  }

  private handleTransportClose(): void {
    this.markClosed(new McpConnectionClosedError());
  }

  private markClosed(error: Error): void {
    const wasClosed = this.state === "closed";
    this.state = "closed";
    this.rejectPending(error);
    for (const controller of this.incoming.values()) controller.abort(error);
    this.incoming.clear();
    if (wasClosed) return;
    for (const listener of [...this.closeListeners]) {
      try {
        listener();
      } catch (listenerError) {
        this.emitError(listenerError);
      }
    }
  }

  private emitError(error: unknown): void {
    const normalized = toError(error);
    for (const listener of this.errorListeners) listener(normalized);
  }

  private disposeTransportListeners(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }
}
