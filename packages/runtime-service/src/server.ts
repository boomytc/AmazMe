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
import { ServiceError, type RuntimeCallContext, type RuntimeService, type ServerService, type SubscriptionSink } from "@amazme/server";
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

export interface RuntimeHostOptions {
  /** The caller keeps owning the harness and its storage; the host never closes or abandons them. */
  harness: AgentHarness;
  /** Lanes clients may name. Omitted allows any lane name the contract accepts. */
  lanes?: readonly string[];
  /** Fixed window that merges storage notifications into one snapshot read per subscription. Default 16 ms. */
  publishWindowMs?: number;
  /** Drive failures and publisher errors. Its own errors are ignored. */
  onError?: (error: Error) => void;
}

/**
 * Serves the runtime calls of one harness on a runtime route. Drives belong to the host: an RPC may wait for one,
 * but cancelling that wait, unsubscribing, detaching or disconnecting never aborts the operation. Only the explicit
 * `requestAbort` call does.
 */
export class RuntimeHost implements RuntimeService {
  private readonly harness: AgentHarness;
  private readonly lanes: ReadonlySet<string> | undefined;
  private readonly windowMs: number;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly drives = new Map<string, Promise<Result<DriveOutcome>>>();
  private readonly publishers = new Set<SnapshotPublisher>();
  private readonly gate = new ConnectionGate();
  private closing: Promise<void> | undefined;

  constructor(options: RuntimeHostOptions) {
    this.harness = options.harness;
    this.lanes = options.lanes ? new Set(options.lanes) : undefined;
    this.windowMs = options.publishWindowMs ?? 16;
    if (!Number.isSafeInteger(this.windowMs) || this.windowMs < 0 || this.windowMs > 60_000) {
      throw new RangeError("publishWindowMs must be an integer between 0 and 60000");
    }
    this.onError = options.onError;
  }

  async call(raw: JsonValue, context: RuntimeCallContext): Promise<JsonValue | undefined> {
    if (this.closing) throw new ServiceError("runtime_closed", "the runtime host is closed");
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

  /** Resolves after every drive this host started or joined has settled. Drives keep running until then. */
  async drivesSettled(): Promise<void> {
    while (this.drives.size > 0) await Promise.allSettled([...this.drives.values()]);
  }

  /**
   * Refuses further calls and ends every subscription with a `runtime_closed` notice. It waits for snapshot
   * reads in flight, not for a stalled peer to read. Drives continue; await `drivesSettled()` or stop the
   * harness yourself. Repeated calls share one promise.
   */
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const ended = { code: "runtime_closed", message: "the runtime host is closed" };
      await Promise.allSettled([...this.publishers].map((publisher) => publisher.close(ended)));
    });
    return this.closing;
  }

  private awaitDrive(lane: AgentLane, operationId: string, waitForRetry: boolean, signal: AbortSignal): Promise<Result<DriveOutcome>> {
    const key = `${lane.name}\0${operationId}`;
    let run = this.drives.get(key);
    if (!run) {
      const started = lane.drive(operationId, { waitForRetry });
      run = started;
      this.drives.set(key, started);
      void started.then(
        () => undefined,
        (error: unknown) => this.report(error),
      ).finally(() => {
        if (this.drives.get(key) === started) this.drives.delete(key);
      });
    }
    const joined = run;
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(cancelled());
      signal.addEventListener("abort", onAbort, { once: true });
      joined.then(
        (outcome) => { signal.removeEventListener("abort", onAbort); resolve(outcome); },
        () => { signal.removeEventListener("abort", onAbort); reject(new ServiceError("drive_failed", "the drive failed; see the runtime host diagnostics")); },
      );
    });
  }

  private async subscribe(lane: AgentLane, subscriptionId: string, context: RuntimeCallContext): Promise<JsonValue> {
    const sink = context.openSubscription(subscriptionId);
    const publisher = new SnapshotPublisher(lane, this.harness, sink, this.gate, this.windowMs, (error) => this.report(error));
    this.publishers.add(publisher);
    void publisher.done.then(() => this.publishers.delete(publisher));
    try {
      return await publisher.start();
    } catch (error) {
      await publisher.close();
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
   * peer to read it. Resolves once a read in flight finished.
   */
  close(ended?: Ended): Promise<void> {
    if (this.closed) return this.done;
    this.closed = true;
    this.rejectInitial?.(new ServiceError(ended?.code ?? "cancelled", ended?.message ?? "the snapshot subscription closed before initialization"));
    this.rejectInitial = undefined;
    this.stop("stopped");
    clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe();
    if (ended && !this.sink.closed) {
      const notice: LaneUpdateDto = { kind: "ended", ...ended };
      void this.sink.send(notice).then(() => this.sink.close(), () => this.sink.close());
    } else {
      this.sink.close();
    }
    void Promise.allSettled([this.initialRead, this.running]).then(() => this.finish());
    return this.done;
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
  /** Runtimes clients may attach. Omitted allows every registered runtime. */
  runtimes?: readonly string[];
}

/** The minimal server-route service: `attach` and `detach` through the router's controlled capability. */
export function createManagementService(options: ManagementServiceOptions = {}): ServerService {
  const allowed = options.runtimes ? new Set(options.runtimes) : undefined;
  return {
    call(raw, context) {
      let call;
      try {
        call = parseManagementCall(raw);
      } catch (error) {
        throw new ServiceError("invalid_call", error instanceof ContractError ? error.message : "invalid management call");
      }
      if (call.method === "detach") {
        context.detach();
        return null;
      }
      if (allowed && !allowed.has(call.runtimeId)) throw new ServiceError("unknown_runtime", `runtime ${call.runtimeId} is not offered`);
      context.attach(call.runtimeId);
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
