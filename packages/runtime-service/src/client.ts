import type { Client, RequestOptions, Subscription, SubscriptionEnd } from "@amazme/client";
import type { JsonValue, RuntimeRoute } from "@amazme/protocol";
import {
  AbortReplySchema,
  AttachReplySchema,
  ContractError,
  ConversationsReplySchema,
  DriveOutcomeSchema,
  EmptyReplySchema,
  EnqueuedReplySchema,
  CatalogReplySchema,
  ForkReplySchema,
  ImportReplySchema,
  LaneNameSchema,
  LaneSettingsSchema,
  OperationAdmissionSchema,
  parse,
  HistoryPageSchema,
  parseLaneSnapshot,
  parseLaneUpdate,
  parseLaneWindow,
  ResultReplySchema,
  type CatalogReplyDto,
  type DriveOutcomeDto,
  type ForkReplyDto,
  type ImportReplyDto,
  type HistoryPageDto,
  type LaneSettingsDto,
  type LaneSnapshotDto,
  type LaneUpdateDto,
  type LaneWindowDto,
  type OperationAdmissionDto,
  type OperationRequest,
  type OperationResultDto,
  type RuntimeCall,
} from "./contracts.ts";

/** No runtime is attached to the client's current connection. */
export class NotAttachedError extends Error {
  constructor() {
    super("no runtime is attached to the current connection");
    this.name = "NotAttachedError";
  }
}

/**
 * Typed calls over a connected `Client`. Every reply is checked against the contract. Calls use the attachment
 * the server published for the current connection; after a reconnect, attach again.
 */
export class RuntimeClient {
  readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /** Asks the server to attach `runtimeId` and returns the route the server published for it. */
  async attach(runtimeId: string, options?: RequestOptions): Promise<RuntimeRoute> {
    parse(AttachReplySchema, await this.client.request(this.client.serverRoute(), { method: "attach", runtimeId }, options), "attach reply");
    const route = this.client.attachment;
    if (!route || route.runtimeId !== runtimeId) throw new ContractError("the server did not publish the attachment");
    return route;
  }

  async detach(options?: RequestOptions): Promise<void> {
    parse(EmptyReplySchema, await this.client.request(this.client.serverRoute(), { method: "detach" }, options), "detach reply");
  }

  /** Asks the host to drain, delete, and drop that runtime. A repeated call shares the host's result. */
  async remove(runtimeId: string, options?: RequestOptions): Promise<void> {
    parse(EmptyReplySchema, await this.client.request(this.client.serverRoute(), { method: "remove", runtimeId }, options), "remove reply");
  }

  /** Lane names stored in this runtime. Does not create a lane. */
  async conversations(options?: RequestOptions): Promise<string[]> {
    const route = this.client.attachment;
    if (!route) throw new NotAttachedError();
    return parse(ConversationsReplySchema, await this.client.request(route, { method: "conversations" }, options), "conversations").lanes;
  }

  lane(name: string): RemoteLane {
    parse(LaneNameSchema, name, "lane name");
    return new RemoteLane(this.client, name);
  }
}

/** How a lane subscription ended: locally, by the route or connection, or by the service (`ended`). */
export type LaneSubscriptionEnd = SubscriptionEnd | { reason: "ended"; code: string; message: string };

/** How much of the lane the latest window left out of its frame. */
export interface LaneCoverage {
  /** Ancestors older than `current().entries`, still readable with `history`. */
  omitted: number;
  /** Ancestors that cannot fit in one frame even alone. */
  skipped: number;
  /** The unsettled reply was left out of this frame. */
  pendingOmitted: boolean;
}

export interface LaneSubscription {
  /** The snapshot the subscription started from. Entries may be a suffix; see `coverage`. */
  readonly initial: LaneSnapshotDto;
  /** The newest snapshot installed: the initial one, then each newer update. */
  current(): LaneSnapshotDto;
  /** Coverage of `current()`. The initial window's coverage is available before the first update. */
  coverage(): LaneCoverage;
  close(): Promise<void>;
  /**
   * Resolves once and never rejects. An update that fails the contract ends it with code `invalid_update`;
   * the service ending it reports the service's code, such as `runtime_closed`.
   */
  readonly ended: Promise<LaneSubscriptionEnd>;
}

export class RemoteLane {
  readonly name: string;
  private readonly client: Client;

  constructor(client: Client, name: string) {
    this.client = client;
    this.name = name;
  }

  async accept(request: OperationRequest, options?: RequestOptions): Promise<OperationAdmissionDto> {
    return parse(OperationAdmissionSchema, await this.call({ method: "accept", lane: this.name, request }, options), "admission");
  }

  /** Waits for the runtime's drive. Aborting stops this wait only; the operation keeps running. */
  async drive(operationId: string, options: RequestOptions & { waitForRetry?: boolean } = {}): Promise<DriveOutcomeDto> {
    const call: RuntimeCall = { method: "drive", lane: this.name, operationId, ...(options.waitForRetry !== undefined ? { waitForRetry: options.waitForRetry } : {}) };
    const outcome = parse(DriveOutcomeSchema, await this.call(call, options), "drive outcome");
    if (outcome.kind === "settled") this.ownResult(outcome.result, operationId);
    else this.ownOperation(outcome.operationId, operationId);
    return outcome;
  }

  async snapshot(options?: RequestOptions): Promise<LaneSnapshotDto> {
    return this.own(parseLaneSnapshot(await this.call({ method: "snapshot", lane: this.name }, options)));
  }

  /** Ancestors strictly before `before`. `before: null` is the newest page, at most `limit` entries. */
  async history(before: string | null, limit: number, options?: RequestOptions): Promise<HistoryPageDto> {
    return parse(HistoryPageSchema, await this.call({ method: "history", lane: this.name, before, limit }, options), "history page");
  }

  async result(operationId: string, options?: RequestOptions): Promise<OperationResultDto | null> {
    const result = parse(ResultReplySchema, await this.call({ method: "result", lane: this.name, operationId }, options), "result reply").result;
    return result ? this.ownResult(result, operationId) : null;
  }

  async steer(text: string, options?: RequestOptions): Promise<{ entryId: string }> {
    return parse(EnqueuedReplySchema, await this.call({ method: "steer", lane: this.name, text }, options), "steer reply");
  }

  async followUp(text: string, options?: RequestOptions): Promise<{ entryId: string }> {
    return parse(EnqueuedReplySchema, await this.call({ method: "followUp", lane: this.name, text }, options), "follow-up reply");
  }

  /** Registered models, this lane's thinking levels, and the workspace label. */
  async catalog(options?: RequestOptions): Promise<CatalogReplyDto> {
    return parse(CatalogReplySchema, await this.call({ method: "catalog", lane: this.name }, options), "lane catalog");
  }

  /** Read this lane's model settings, or replace them when the lane is idle. */
  async configure(patch: { provider?: string; modelId?: string; thinkingLevel?: LaneSettingsDto["thinkingLevel"] } = {}, options?: RequestOptions): Promise<LaneSettingsDto> {
    const call: RuntimeCall = {
      method: "configure",
      lane: this.name,
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
      ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel } : {}),
    };
    return parse(LaneSettingsSchema, await this.call(call, options), "lane settings");
  }

  /** Open another conversation at this lane's entry. An existing target is refused by the host. */
  async fork(name: string, entryId: string | null, options?: RequestOptions): Promise<ForkReplyDto> {
    return parse(ForkReplySchema, await this.call({ method: "fork", lane: this.name, name, entryId }, options), "fork reply");
  }

  /** Create another conversation from user and assistant text. The current lane stays put. */
  async importMessages(
    name: string,
    messages: readonly { role: "user" | "assistant"; text: string }[],
    options?: RequestOptions,
  ): Promise<ImportReplyDto> {
    return parse(ImportReplySchema, await this.call({ method: "import", lane: this.name, name, messages: [...messages] }, options), "import reply");
  }

  /** The explicit, persisted business cancellation of an operation. */
  async requestAbort(operationId: string, options?: RequestOptions): Promise<{ operationId: string; newlyRequested: boolean }> {
    const reply = parse(AbortReplySchema, await this.call({ method: "requestAbort", lane: this.name, operationId }, options), "abort reply");
    this.ownOperation(reply.operationId, operationId);
    return reply;
  }

  /**
   * Subscribes to complete snapshots. The initial snapshot is installed before any update is handled;
   * `onSnapshot` then receives each update whose version is newer than the installed one.
   */
  async subscribe(onSnapshot: (snapshot: LaneSnapshotDto) => void, options: RequestOptions = {}): Promise<LaneSubscription> {
    const route = this.route();
    let current: LaneSnapshotDto | undefined;
    let coverage: LaneCoverage = { omitted: 0, skipped: 0, pendingOmitted: false };
    let version = -1;
    let subscription: Subscription | undefined;
    let settle!: (end: LaneSubscriptionEnd) => void;
    const ended = new Promise<LaneSubscriptionEnd>((resolve) => { settle = resolve; });
    const end = (value: LaneSubscriptionEnd) => {
      settle(value);
      void subscription?.close();
    };
    const install = (window: LaneWindowDto): LaneSnapshotDto | undefined => {
      this.ownWindow(window);
      if (window.version <= version) return undefined;
      version = window.version;
      coverage = { omitted: window.omitted, skipped: window.skipped, pendingOmitted: window.pendingOmitted };
      current = projectWindow(window);
      return current;
    };
    const onUpdate = (raw: JsonValue) => {
      if (!current || !subscription) return;
      let update: LaneUpdateDto;
      try {
        update = parseLaneUpdate(raw);
      } catch (error) {
        end({ reason: "ended", code: "invalid_update", message: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (update.kind === "ended") {
        end({ reason: "ended", code: update.code, message: update.message });
        return;
      }
      try {
        const installed = install(update.advance);
        if (installed) onSnapshot(installed);
      } catch (error) {
        end({ reason: "ended", code: "invalid_update", message: error instanceof Error ? error.message : String(error) });
      }
    };
    subscription = await this.client.subscribe(
      route,
      (subscriptionId) => ({ method: "subscribe", lane: this.name, subscriptionId }),
      onUpdate,
      { ...(options.signal ? { signal: options.signal } : {}), unsubscribe: (subscriptionId) => ({ method: "unsubscribe", subscriptionId }) },
    );
    let initial: LaneSnapshotDto;
    try {
      const installed = install(parseLaneWindow(subscription.initial));
      if (!installed) throw new ContractError("the initial window has no version");
      initial = installed;
    } catch (error) {
      await subscription.close();
      throw error;
    }
    const opened = subscription;
    void opened.ended.then(settle);
    opened.start();
    return { initial, current: () => current!, coverage: () => ({ ...coverage }), close: () => opened.close(), ended };
  }

  private call(call: RuntimeCall, options?: RequestOptions): Promise<JsonValue | undefined> {
    return this.client.request(this.route(), call, options);
  }

  private route(): RuntimeRoute {
    const route = this.client.attachment;
    if (!route) throw new NotAttachedError();
    return route;
  }

  private own(snapshot: LaneSnapshotDto): LaneSnapshotDto {
    if (snapshot.lane !== this.name) throw new ContractError(`snapshot is for lane ${snapshot.lane}, not ${this.name}`);
    return snapshot;
  }

  private ownWindow(window: LaneWindowDto): void {
    if (window.lane !== this.name) throw new ContractError(`snapshot is for lane ${window.lane}, not ${this.name}`);
  }

  private ownResult(result: OperationResultDto, operationId: string): OperationResultDto {
    if (result.lane !== this.name) throw new ContractError(`result is for lane ${result.lane}, not ${this.name}`);
    this.ownOperation(result.operationId, operationId);
    return result;
  }

  private ownOperation(actual: string, expected: string): void {
    if (actual !== expected) throw new ContractError(`reply is for operation ${actual}, not ${expected}`);
  }
}

function projectWindow(window: LaneWindowDto): LaneSnapshotDto {
  return {
    version: window.version,
    lane: window.lane,
    tipId: window.tipId,
    phase: window.phase,
    operationId: window.operationId,
    lastOperationId: window.lastOperationId,
    status: window.status,
    entries: window.entries,
    pendingResponse: window.pendingResponse,
    tools: window.tools,
    activity: window.activity,
  };
}
