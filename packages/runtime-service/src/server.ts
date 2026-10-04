import type {
  AgentHarness,
  AgentLane,
  DriveOutcome,
  LanePhase,
  LaneSnapshot,
  LaneStatus,
  OperationAdmission,
  OperationResult,
  Result,
} from "@amazme/durable";
import type { JsonObject, JsonValue } from "@amazme/protocol";
import {
  ServiceError,
  type AttachmentLease,
  type RuntimeCallContext,
  type RuntimeHandle,
  type RuntimeService,
  type ServerService,
  type SubscriptionSink,
} from "@amazme/server";
import {
  ContractError,
  LANE_PHASES,
  parseManagementCall,
  parseRuntimeCall,
  type DriveOutcomeDto,
  type LaneSnapshotDto,
  type LaneUpdateDto,
  type OperationAdmissionDto,
  type OperationResultDto,
  type RuntimeCall,
} from "./contracts.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type StatusDto = Omit<LaneSnapshotDto, "version" | "entries" | "pendingResponse">;
const phases: Same<LanePhase, (typeof LANE_PHASES)[number]> = true;
const results: Same<OperationResult, OperationResultDto> = true;
const admissions: Same<OperationAdmission, OperationAdmissionDto> = true;
const outcomes: Same<DriveOutcome, DriveOutcomeDto> = true;
const statuses: Same<LaneStatus, StatusDto> = true;
void [phases, results, admissions, outcomes, statuses];

/**
 * What one host open acquired. The server handle does not expose `harness` or `storage`.
 * `closeStorage` stops new storage callbacks and waits, without deleting or unlocking.
 * `remove` deletes this instance's data and only then drops ownership. `release` drops ownership
 * without deleting. All three are idempotent and may be retried after a rejection.
 */
export interface OwnedRuntimeResources {
  readonly harness: AgentHarness;
  closeStorage(): Promise<void>;
  release(): Promise<void>;
  remove(): Promise<void>;
}

export interface OwnedRuntimeOptions {
  /**
   * Open one runtime the host allows. `null` refuses the id. The signal aborts when every waiter
   * has left, or when the runtime is removed or the server is closing. It is not one RPC's signal.
   * This call reads storage and constructs the harness. It must not drive, call a model, or run a tool.
   * On failure, release anything already acquired before throwing. A returned value still belongs to
   * the caller until `openOwnedRuntimes` returns the handle; after that the server owns it.
   */
  open(runtimeId: string, signal: AbortSignal): Promise<OwnedRuntimeResources | null>;
  /** Lanes clients may name. Omitted allows any lane name the contract accepts. */
  lanes?: readonly string[];
  /** Fixed window that merges storage notifications into one snapshot read per subscription. Default 16 ms. */
  publishWindowMs?: number;
  /** Unexpected drive failures and publisher errors. Its own errors are ignored. */
  onError?: (error: Error) => void;
}

/**
 * Server `openRuntime` for runtimes this process owns. Concurrent opens are merged by the server, not here.
 * A second call opens a second instance. The returned handle's `close` drains or aborts host work and closes
 * storage, and keeps the write right. The server then calls `release` or `remove`.
 */
export function openOwnedRuntimes(options: OwnedRuntimeOptions): (runtimeId: string, signal: AbortSignal) => Promise<RuntimeHandle | null> {
  const windowMs = options.publishWindowMs ?? 16;
  if (!Number.isSafeInteger(windowMs) || windowMs < 0 || windowMs > 60_000) {
    throw new RangeError("publishWindowMs must be an integer between 0 and 60000");
  }
  return async (runtimeId, signal) => {
    let resources: OwnedRuntimeResources | null;
    try {
      resources = await options.open(runtimeId, signal);
    } catch (error) {
      if (isStorageBusy(error)) throw new ServiceError("storage_busy", error instanceof Error ? error.message : "storage is busy");
      throw error;
    }
    if (!resources) return null;
    // An aborted open signal means the server will discard this handle. Returning it lets that
    // discard close and release the resources. Releasing here as well would drop a lock twice.
    try {
      return new OwnedRuntime(resources, options, windowMs);
    } catch (error) {
      try {
        await resources.release();
      } catch (cause) {
        throw new AggregateError([error, cause], "opening the runtime failed and releasing ownership failed");
      }
      throw error;
    }
  };
}

/**
 * One opened runtime. Drives, model calls, and tools belong to the harness: cancelling an RPC wait,
 * unsubscribing, detaching, or disconnecting never aborts them. Only `requestAbort` persists a business cancel.
 * `close("drain")` waits without that write. `close("abort")` aborts the harness signal and still waits.
 */
class OwnedRuntime implements RuntimeHandle, RuntimeService {
  private readonly harness: AgentHarness;
  private readonly resources: OwnedRuntimeResources;
  private readonly lanes: ReadonlySet<string> | undefined;
  private readonly windowMs: number;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly publishers = new Set<SnapshotPublisher>();
  private readonly reported = new WeakSet<Promise<unknown>>();
  private readonly gate = new ConnectionGate();
  private stopped = false;
  private aborting = false;
  private closing: Promise<void> | undefined;
  private observationEnded = false;
  private storageClosed = false;
  private released = false;
  private removed = false;
  private releaseOnce: Promise<void> | undefined;
  private removeOnce: Promise<void> | undefined;
  private ownership: Promise<void> = Promise.resolve();

  constructor(resources: OwnedRuntimeResources, options: OwnedRuntimeOptions, windowMs: number) {
    this.resources = resources;
    this.harness = resources.harness;
    this.lanes = options.lanes ? new Set(options.lanes) : undefined;
    this.windowMs = windowMs;
    this.onError = options.onError;
  }

  acquire(): AttachmentLease {
    const service: RuntimeService = this;
    return { service, release() {} };
  }

  /**
   * Stops admission, ends observation, then waits for harness work and closes storage.
   * A later abort upgrades a drain. A later drain does not clear an abort. Repeated calls share
   * one operation until it rejects; a rejection can be retried. This does not delete data or unlock.
   */
  close(mode: "drain" | "abort"): Promise<void> {
    if (mode === "abort") this.aborting = true;
    this.stopped = true;
    const quiet = this.aborting ? this.harness.close() : this.harness.drain();
    void quiet.catch(() => undefined);
    if (!this.closing) {
      let run!: Promise<void>;
      run = this.finishClose().then(() => undefined, (error: unknown) => {
        if (this.closing === run) this.closing = undefined;
        throw error;
      });
      this.closing = run;
    }
    return this.closing;
  }

  /** No running drive or admitted storage work. Attachments are counted by the server. */
  idle(): boolean {
    return !this.stopped && this.harness.idle();
  }

  watchIdle(listener: () => void): () => void {
    return this.harness.watchIdle(listener);
  }

  /** Drain, then drop the write right. Does not delete. A failed attempt can be retried. */
  release(): Promise<void> {
    if (this.removed) return this.removeOnce ?? Promise.resolve();
    const closing = this.close("drain");
    if (this.releaseOnce) return this.releaseOnce;
    let run!: Promise<void>;
    run = this.enqueue(async () => {
      await closing;
      if (this.removed || this.released) return;
      await this.resources.release();
      this.released = true;
    }).then(() => undefined, (error: unknown) => {
      if (this.releaseOnce === run && !this.released) this.releaseOnce = undefined;
      throw error;
    });
    this.releaseOnce = run;
    return run;
  }

  /**
   * Drain, delete this instance's data, then drop the write right.
   * After `release` has succeeded this rejects and does not delete. A failed attempt can be retried.
   */
  remove(): Promise<void> {
    if (this.released && !this.removed) return Promise.reject(new Error("storage ownership was released"));
    const closing = this.close("drain");
    if (this.removeOnce) return this.removeOnce;
    let run!: Promise<void>;
    run = this.enqueue(async () => {
      await closing;
      if (this.removed) return;
      if (this.released) throw new Error("storage ownership was released");
      await this.resources.remove();
      this.removed = true;
    }).then(() => undefined, (error: unknown) => {
      if (this.removeOnce === run && !this.removed) this.removeOnce = undefined;
      throw error;
    });
    this.removeOnce = run;
    return run;
  }

  async call(raw: JsonValue, context: RuntimeCallContext): Promise<JsonValue | undefined> {
    if (this.stopped) throw new ServiceError("runtime_closed", "the runtime host is closed");
    let call: RuntimeCall;
    try {
      call = parseRuntimeCall(raw);
    } catch (error) {
      throw new ServiceError("invalid_call", error instanceof ContractError ? error.message : "invalid runtime call");
    }
    if (call.method === "unsubscribe") {
      const sink = context.subscription(call.subscriptionId);
      if (!sink) throw new ServiceError("unknown_subscription", `subscription ${call.subscriptionId} is not open`);
      sink.close();
      return null;
    }
    if (this.lanes && !this.lanes.has(call.lane)) throw new ServiceError("unknown_lane", `lane ${call.lane} is not served`);
    const lane = this.harness.lane(call.lane);
    switch (call.method) {
      case "accept":
        return wire(unwrap(await lane.accept(call.request)));
      case "drive":
        return wire(structuredClone(unwrap(await this.awaitDrive(lane, call.operationId, call.waitForRetry ?? false, context.signal))));
      case "snapshot":
        return wire(await lane.snapshot());
      case "result":
        return wire({ result: unwrap(await lane.result(call.operationId)) });
      case "steer":
        return wire(unwrap(await lane.steer(call.text)));
      case "followUp":
        return wire(unwrap(await lane.followUp(call.text)));
      case "requestAbort":
        return wire(unwrap(await lane.requestAbort(call.operationId)));
      case "subscribe":
        return this.subscribe(lane, call.subscriptionId, context);
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.ownership.then(task, task);
    this.ownership = run.then(() => undefined, () => undefined);
    return run;
  }

  private async finishClose(): Promise<void> {
    const errors: unknown[] = [];
    const quiet = this.aborting ? this.harness.close() : this.harness.drain();
    void quiet.catch(() => undefined);
    const waited = await Promise.allSettled([this.endObservation(), quiet]);
    for (const result of waited) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    // A rejected wait means producer work may still be running. Leave storage and the lock alone.
    if (waited[1]?.status === "fulfilled" && !this.storageClosed) {
      try {
        await this.resources.closeStorage();
        this.storageClosed = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "runtime close failed");
  }

  private endObservation(): Promise<void> {
    if (this.observationEnded) return Promise.resolve();
    this.observationEnded = true;
    const ended = { code: "runtime_closed", message: "the runtime host is closed" };
    return Promise.allSettled([...this.publishers].map((publisher) => publisher.close(ended))).then((settled) => {
      const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "ending observation failed");
    });
  }

  private awaitDrive(lane: AgentLane, operationId: string, waitForRetry: boolean, signal: AbortSignal): Promise<Result<DriveOutcome>> {
    const run = lane.drive(operationId, { waitForRetry });
    this.watch(run);
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(cancelled());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      run.then(
        (outcome) => {
          signal.removeEventListener("abort", onAbort);
          resolve(outcome);
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          reject(new ServiceError("drive_failed", "the drive failed; see the runtime host diagnostics"));
        },
      );
    });
  }

  /** Report an unexpected rejection once per drive, including when every RPC wait already left. */
  private watch(run: Promise<Result<DriveOutcome>>): void {
    if (this.reported.has(run)) return;
    this.reported.add(run);
    void run.then(() => undefined, (error: unknown) => this.report(error));
  }

  private async subscribe(lane: AgentLane, subscriptionId: string, context: RuntimeCallContext): Promise<JsonValue> {
    const sink = context.openSubscription(subscriptionId);
    const publisher = new SnapshotPublisher(lane, this.harness, sink, this.gate, this.windowMs, (error) => this.report(error));
    this.publishers.add(publisher);
    void publisher.done.then(() => this.publishers.delete(publisher));
    try {
      return await publisher.start();
    } catch (error) {
      await publisher.close().catch((cause: unknown) => this.report(cause));
      throw error;
    }
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Diagnostics cannot change runtime state.
    }
  }
}

function isStorageBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "storage_busy";
}

/** One snapshot read-and-send at a time per connection, so its subscriptions never queue more than one frame. */
class ConnectionGate {
  private readonly tails = new Map<string, Promise<void>>();

  run(connectionId: string, task: () => Promise<void>): Promise<void> {
    const turn = (this.tails.get(connectionId) ?? Promise.resolve()).then(task);
    const tail = turn.then(() => undefined, () => undefined);
    this.tails.set(connectionId, tail);
    void tail.then(() => {
      if (this.tails.get(connectionId) === tail) this.tails.delete(connectionId);
    });
    return turn;
  }
}

interface Ended {
  code: string;
  message: string;
}

/**
 * Turns storage invalidations into complete snapshots for one sink. The storage listener only marks the
 * subscription dirty. The first mark opens a fixed window; when it ends, one read consumes the mark and the
 * result is sent. Marks that arrive during the read or the send open the next window. At most the snapshot in
 * flight exists; nothing else is queued, so a slow peer only lowers the rate. When the service side ends the
 * subscription it sends an `ended` notice instead of falling silent.
 */
class SnapshotPublisher {
  readonly done: Promise<void>;
  private readonly lane: AgentLane;
  private readonly sink: SubscriptionSink;
  private readonly gate: ConnectionGate;
  private readonly windowMs: number;
  private readonly report: (error: unknown) => void;
  private readonly unsubscribe: () => void;
  private readonly stopped: Promise<"stopped">;
  private stop!: (value: "stopped") => void;
  private finish!: () => void;
  private started = false;
  private dirty = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private initialRead: Promise<LaneSnapshot> | undefined;
  private rejectInitial: ((error: unknown) => void) | undefined;
  private version = -1;

  constructor(lane: AgentLane, harness: AgentHarness, sink: SubscriptionSink, gate: ConnectionGate, windowMs: number, report: (error: unknown) => void) {
    this.lane = lane;
    this.sink = sink;
    this.gate = gate;
    this.windowMs = windowMs;
    this.report = report;
    this.done = new Promise((resolve) => { this.finish = resolve; });
    this.stopped = new Promise((resolve) => { this.stop = resolve; });
    this.unsubscribe = harness.storage.subscribe(() => this.invalidate());
    sink.signal.addEventListener("abort", () => void this.close(), { once: true });
  }

  /** Reads the initial snapshot after the listener is registered, so no write between them is missed. */
  start(): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      this.rejectInitial = reject;
      void this.gate.run(this.sink.connectionId, async () => {
        if (this.closed) return;
        this.dirty = false;
        const reading = this.lane.snapshot();
        this.initialRead = reading;
        try {
          const snapshot = await reading;
          if (this.closed) return;
          this.version = snapshot.version;
          const initial = wire(snapshot);
          this.started = true;
          this.rejectInitial = undefined;
          resolve(initial);
        } catch (error) {
          reject(error);
          return;
        } finally {
          this.initialRead = undefined;
        }
        // Return the call's result before waiting for its response: that response releases this turn.
        const ready = await Promise.race([this.sink.ready, this.stopped]);
        if (ready === true) this.schedule();
      }).catch(reject);
    });
  }

  /**
   * Stops publishing at once. With `ended`, the notice is queued before the sink closes; nothing waits for the
   * peer to read it. Resolves once a read in flight finished. An unsubscribe failure still closes the sink and
   * rejects after that read, so a later publisher is not skipped.
   */
  close(ended?: Ended): Promise<void> {
    if (this.closed) return this.done;
    this.closed = true;
    this.rejectInitial?.(new ServiceError(ended?.code ?? "cancelled", ended?.message ?? "the snapshot subscription closed before initialization"));
    this.rejectInitial = undefined;
    this.stop("stopped");
    clearTimeout(this.timer);
    this.timer = undefined;
    let unsubscribeError: unknown;
    try {
      this.unsubscribe();
    } catch (error) {
      unsubscribeError = error;
    }
    if (ended && !this.sink.closed) {
      const notice: LaneUpdateDto = { kind: "ended", ...ended };
      void this.sink.send(notice).then(() => this.sink.close(), () => this.sink.close());
    } else {
      this.sink.close();
    }
    void Promise.allSettled([this.initialRead, this.running]).then(() => this.finish());
    if (!unsubscribeError) return this.done;
    const failure = unsubscribeError;
    return this.done.then(() => {
      throw failure;
    });
  }

  private invalidate(): void {
    if (this.closed) return;
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (!this.started || !this.dirty || this.closed || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.publish().finally(() => {
        this.running = undefined;
        this.schedule();
      });
    }, this.windowMs);
  }

  private publish(): Promise<void> {
    return this.gate.run(this.sink.connectionId, async () => {
      if (this.closed || !this.dirty) return;
      this.dirty = false;
      let snapshot: LaneSnapshot;
      try {
        snapshot = await this.lane.snapshot();
      } catch (error) {
        this.report(error);
        void this.close({ code: "snapshot_failed", message: "the lane snapshot could not be read" });
        return;
      }
      if (this.closed || snapshot.version <= this.version) return;
      let sent: boolean | "stopped";
      try {
        const update: LaneUpdateDto = { kind: "snapshot", snapshot: wire(snapshot) as LaneSnapshotDto };
        sent = await Promise.race([this.sink.send(update), this.stopped]);
      } catch (error) {
        this.report(error);
        void this.close({ code: "snapshot_unavailable", message: "the lane snapshot could not be sent" });
        return;
      }
      if (sent === false) void this.close();
      else if (sent === true) this.version = snapshot.version;
    });
  }
}

export interface ManagementServiceOptions {
  /** Runtimes clients may attach or remove. Omitted asks `openRuntime` about every id. */
  runtimes?: readonly string[];
  /** Deletes one runtime through the server that owns it. Omitted rejects `remove`. */
  removeRuntime?: (runtimeId: string) => Promise<void>;
}

/** Server-route calls: `attach`, `detach`, and, when the host wires it, `remove`. */
export function createManagementService(options: ManagementServiceOptions = {}): ServerService {
  const allowed = options.runtimes ? new Set(options.runtimes) : undefined;
  return {
    async call(raw, context) {
      let call;
      try {
        call = parseManagementCall(raw);
      } catch (error) {
        throw new ServiceError("invalid_call", error instanceof ContractError ? error.message : "invalid management call");
      }
      if (call.method === "detach") {
        await context.detach();
        return null;
      }
      if (call.method === "remove") {
        if (!options.removeRuntime) throw new ServiceError("invalid_call", "remove is not offered");
        if (allowed && !allowed.has(call.runtimeId)) throw new ServiceError("unknown_runtime", `runtime ${call.runtimeId} is not offered`);
        await options.removeRuntime(call.runtimeId);
        return null;
      }
      if (allowed && !allowed.has(call.runtimeId)) throw new ServiceError("unknown_runtime", `runtime ${call.runtimeId} is not offered`);
      await context.attach(call.runtimeId);
      return { attached: true };
    },
  };
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new ServiceError(result.error.code, result.error.message);
  return result.value;
}

function cancelled(): ServiceError {
  return new ServiceError("cancelled", "stopped waiting for the drive; the operation continues");
}

/**
 * Projects a detached Durable value onto strict JSON in place: absent optional fields stored as `undefined`
 * are dropped, as a JSON round trip would; anything else that is not JSON fails.
 */
function wire(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("value is not finite");
    return value;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) value[index] = wire(value[index]);
    return value as JsonValue[];
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("value is not a plain object");
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (record[key] === undefined) delete record[key];
      else record[key] = wire(record[key]);
    }
    return record as JsonObject;
  }
  throw new TypeError(`${typeof value} is not JSON`);
}
