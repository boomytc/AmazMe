import { applyAfter, toProviderMessages, walkAfter, walkBefore, walkTransform, walkYield, type AgentHook, type AgentMessage } from "@amazme/agent";
import {
  uuidv7,
  toolDefinition,
  validateArguments,
  type AssistantContent,
  type AssistantFrame,
  type AssistantMessage,
  type Context,
  type StopReason,
  type Usage,
  frameFromEvent,
  reduceFrames,
  cacheHitRate,
  resolveOutputBudget,
  supportedThinkingLevels,
  usageCost,
  type StreamOptions,
  type ThinkingLevel,
  type UsageCost,
  type UserContent,
} from "@amazme/ai";
import { createTypedSpanStarter, type SchemaTelemetrySpan, type TelemetryContext } from "@amazme/telemetry";
import { acceptedSummary, continuationContext, fitSummaryRequest, planCompaction, summaryRejection } from "./compaction/plan.ts";
import { effectiveInputThreshold, keepRecentBudget } from "./compaction/policy.ts";
import type { TranscriptEntry } from "./compaction/select.ts";
import {
  armRequestDeadline,
  classifyDeadline,
  resolveRequestPolicy,
  retryNotBeforeDelayMs,
  storedRequestPolicy,
  type RequestDeadline,
  type RetryWait,
} from "./request-policy.ts";
import { DEFAULT_TOOL_RESULT_LIMIT, projectForRequest, stampSession } from "./session-log.ts";
import { durableTelemetrySchema } from "./telemetry.ts";
import type { HarnessMessage, HarnessModels, HarnessTool, QueueMode, ReplayPolicy, ToolExecutionMode, ToolResult } from "./types.ts";
import {
  type Address,
  type Apply,
  type Entry,
  list,
  type Storage,
  type StorageView,
  type UsageRow,
  value,
  type Write,
} from "./storage.ts";

type DriveSpan = SchemaTelemetrySpan<typeof durableTelemetrySchema, "amazme.harness.drive">;

export interface HarnessFailure {
  code:
    | "lane_busy"
    | "invalid_message"
    | "unknown_target"
    | "operation_mismatch"
    | "closed"
    | "nothing_to_compact"
    | "no_active_operation";
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: HarnessFailure };

export interface LaneConfig {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  toolExecution: ToolExecutionMode;
  /** Input-token trigger for automatic compaction. Not the generation output cap. */
  compaction: { enabled: boolean; maxTokens: number };
  /** Output-token cap forwarded to streamSimple. Omitted uses the model cap. */
  maxTokens?: number;
  maxAttempts: number;
  /** Idle deadline for one model request. Each received frame restarts it. Not a tool limit or a wall-clock cap. */
  requestTimeoutMs: number;
  /** Stored retry wait. The settled `notBefore` is `now + retryNotBeforeDelayMs(retry, attempt, retryAfterMs?)`. */
  retry: RetryWait;
  /** Maximum tool-result characters placed in the next model request. The log keeps the original. */
  toolResultLimit: number;
  systemPrompt: string;
}

export interface LaneCatalog {
  directory: string;
  models: Array<{ provider: string; modelId: string }>;
  thinkingLevels: ThinkingLevel[];
}

/** The model choice a client can read or replace. The system prompt stays on the lane. */
export interface LaneSettings {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** Levels the current model accepts. Unsupported levels are rejected, not clamped. */
  thinkingLevels: ThinkingLevel[];
}

export interface HarnessOptions {
  telemetryContext?: TelemetryContext;
  models: HarnessModels;
  model: { provider: string; modelId: string };
  tools?: HarnessTool[];
  /** Ordered hooks. The drive calls the existing agent walks. */
  hooks?: readonly AgentHook[];
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  toolExecution?: ToolExecutionMode;
  /** Input-token trigger. Omitted stays disabled at 80_000. This is not `maxTokens`. */
  compaction?: { enabled: boolean; maxTokens: number };
  /** Output-token cap for model turns. The summary request uses its own cap. */
  maxTokens?: number;
  maxAttempts?: number;
  /** Idle deadline for one model request. Each received frame restarts it. Omitted uses 60 seconds. Not a tool limit or a wall-clock cap. */
  requestTimeoutMs?: number;
  /** Retry wait stored on the lane. Omitted uses a 1 second base capped at 60 seconds. */
  retry?: RetryWait;
  /** Tool-result clip for the next model request. Omitted uses 8_000 characters. */
  toolResultLimit?: number;
  /** Workspace shown on the client status line. Not a sandbox root by itself. */
  workspace?: string;
  /**
   * Host gate for one tool call. Omitted or `false` runs the call.
   * `true` parks that call on the current tools batch until `approve`.
   * The predicate is not stored. A reopened process supplies it again for later calls;
   * a call already parked does not ask the predicate a second time.
   * `allowForSession` skips this predicate for one tool name until the process exits.
   * That set is not stored either.
   */
  requiresApproval?: (call: ApprovalRequest) => boolean | Promise<boolean>;
  /**
   * Test seam for the model idle deadline. Production uses {@link armRequestDeadline}.
   * The returned signal must abort when `parent` aborts.
   * `touch` restarts the idle timer. A seam that fires the deadline itself may leave `touch` empty.
   */
  armDeadline?: (timeoutMs: number, parent: AbortSignal) => RequestDeadline;
}

export interface OperationResult {
  operationId: string;
  lane: string;
  kind: "run" | "compaction" | "navigation";
  status: "completed" | "failed" | "aborted";
  fromTipId: string | null;
  tipId: string | null;
  startedAt: number;
  endedAt: number;
  error?: string;
}

export type DriveOutcome =
  | { kind: "settled"; result: OperationResult }
  | { kind: "waiting"; operationId: string; reason: "retry" | "approval"; notBefore: number };

export interface OperationAdmission {
  operationId: string;
  kind: "run" | "compaction" | "navigation";
  startedAt: number;
}

export type LanePhase = OperationState["phase"];

/** Status half of `snapshot()` and the value `inspect()` returns. */
export interface LaneStatus {
  lane: string;
  tipId: string | null;
  phase: LanePhase | null;
  operationId: string | null;
  lastOperationId: string | null;
  status: "open" | "aborting" | null;
}

/**
 * Retry expiry, whether a summary is in progress, and when the open turn started.
 * `notBefore` is the stored retry deadline in milliseconds, or null when this lane is not in `retry_wait`.
 * `retryReason` is the error text that opened that wait. An approval wait is not a retry, so both stay null;
 * parked calls are `pendingApprovals()`.
 * `turnStartedAt` is the persisted start of the whole open turn, or null when no turn is running.
 */
export interface LaneRunStatus {
  notBefore: number | null;
  retryReason: string | null;
  compacting: boolean;
  turnStartedAt: number | null;
}

/**
 * The persisted prefix of the main assistant response that is reserved but not settled.
 * `stopReason` and `errorMessage` come from an observed stop frame and are `null` without one;
 * a stop frame is not a settlement. Tool calls appear only after their arguments ended.
 */
export interface PendingResponse {
  operationId: string;
  responseEntryId: string;
  content: AssistantContent[];
  stopReason: StopReason | null;
  errorMessage: string | null;
}

/**
 * A tool call of the current operation. Settled calls stay in `entries`; this list is only the open batch.
 * `outputTail` is present only while `running` and a checkpoint is stored.
 */
export interface ToolActivity {
  toolCallId: string;
  name: string;
  /** `running` is `effect_pending`. `outcome_ready` and `completed` are `settled`. */
  status: "planned" | "running" | "settled";
  /** Last 4000 code units of the stored checkpoint. A cut on a low surrogate drops that unit. */
  outputTail?: string;
}

/** Input, output, cache, and reasoning counts. A count missing from storage is null, not zero. */
interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
}

/**
 * `usageCost` fields. On a sum, a component is null when any counted row's component is null.
 * The whole value is null when a row has no stored model, or that model has no price list.
 * A row that stored `cost.total: null` did not report usage. Every charge on that row is null.
 */
export type LaneUsageCost = { [K in keyof UsageCost]: number | null };

/**
 * Token counts for this lane. `lastTurn` and `total` read stored usage rows. `contextTokens` reads the branch.
 * An omitted cache or reasoning count is null. A reported 0 stays 0.
 */
export interface LaneUsage {
  /**
   * Newest settled assistant after the newest summary, excluding `error`, `aborted`, and `deferred`.
   * The copied tail is the contiguous run of older timestamps directly after that summary, and it does not count.
   * Null when nothing after that run counts, or that assistant has no usage row written on the next seq.
   * Counts, `hitRate`, and `cost` come from that row. `hitRate` is `cacheHitRate` of the row.
   * `cost` is `usageCost` for the model stored on the row, or null when the row has no model,
   * or that model is missing or has no price list.
   * A row that stored `cost.total: null` did not report usage. Its cost is an object with every charge null,
   * and it is not priced from zero tokens. Those nulls include fields a quoted `UsageCost` types as numbers.
   */
  lastTurn: (UsageCounts & { hitRate: number | null; cost: UsageCost | null }) | null;
  /**
   * `input` and `output` sum usage rows whose persisted operation belongs to this lane, including summary requests.
   * A row has no lane. An open operation is attributed by the stored `OperationMeta.lane`; after `finish`, by
   * `OperationResult.lane`. There is no ancestor-chain fallback: one operation can write several rows, and a fork
   * can cut in the middle of that operation, so summing assistant messages would not match the rows.
   * `cacheRead` and `reasoning` sum only when every counted row stores a number. A missing field or a stored null
   * means the provider did not report it, and that total is null. A new row stores an unreported `reasoning` as null
   * and an unreported `cacheWrite` as 0. Cumulative `cacheWrite` is null only when an old row omitted the field.
   * A reported 0 stays 0.
   * `hitRate` is `cacheHitRate` of those totals, and null only when `cacheRead` is null. A null `cacheWrite`
   * is left out of that rate.
   * `cost` prices each row with the model stored on that row. A row without one, or whose model is missing
   * or has no price list, makes the cumulative cost null.
   * A row that stored `cost.total: null` did not report usage. That row's charges are all null, so the
   * cumulative cost stays an all-null object and is not priced from zero tokens.
   */
  total: UsageCounts & { hitRate: number | null; cost: LaneUsageCost | null };
  /**
   * Prompt size plus output of the newest assistant after the newest summary.
   * The copied tail is the contiguous run of older timestamps directly after that summary, and it does not count.
   * Null when nothing after that run counts, the same as an empty lane.
   */
  contextTokens: number | null;
  /**
   * The input trigger `assess` compares against. Null when compaction is off, `maxTokens` is not a positive
   * safe integer, or the model window is unknown.
   * `assess` compares an estimate of the next request, so comparing `contextTokens` to this threshold is only approximate.
   */
  compactionThreshold: number | null;
}

/** `LaneUsage` plus the storage version of the read that produced it. */
export type LaneUsageView = { version: number } & LaneUsage;

/** Checkpoint tails of the running tool calls in one read. */
export interface ToolOutputView {
  version: number;
  tails: Array<{ toolCallId: string; outputTail: string }>;
}

/** The call `requiresApproval` sees. `arguments` is the tool-call object the model sent. */
export interface ApprovalRequest {
  toolCallId: string;
  name: string;
  arguments: unknown;
}

/** One parked tool call. The object is plain data and round-trips through clone and JSON. */
export interface PendingApproval {
  toolCallId: string;
  name: string;
  arguments: unknown;
  requestedAt?: number;
}

/**
 * Parked tool calls from one storage read.
 * `version` is that read's `view.version()`, the same number `snapshot()` reports for the same view.
 */
export interface PendingApprovals {
  version: number;
  items: PendingApproval[];
}

/** One consistent read of a lane. Every field is a detached copy taken at `version`. */
export interface LaneSnapshot extends LaneStatus {
  version: number;
  entries: Entry[];
  pendingResponse: PendingResponse | null;
  tools: ToolActivity[];
}

export type OperationRequest =
  | { kind: "prompt"; text: string; content?: UserContent[]; operationId?: string }
  | { kind: "compaction"; operationId?: string }
  | { kind: "navigation"; targetId: string | null; summarize?: boolean; operationId?: string };

interface Scope {
  control: { status: "running" } | { status: "cancel_requested"; requestedAt: number };
  attempt: number;
  overflowUsed: boolean;
  thresholdUsed: boolean;
}

/** Parked on the tools batch. Absent on older logs, which keep running every call. */
interface ToolApproval {
  arguments: unknown;
  requestedAt: number;
  decision?: "allow" | "deny";
  reason?: string;
}

interface ToolCallState {
  sourceIndex: number;
  resultEntryId: string;
  toolCallId: string;
  name: string;
  status: "planned" | "effect_pending" | "outcome_ready" | "completed";
  replay?: ReplayPolicy;
  terminate?: boolean;
  approval?: ToolApproval;
}

type SummaryReason = "threshold" | "overflow";
type SummaryBoundary = "resume" | "finish" | "navigation";

type OperationState =
  | { phase: "starting"; scope: Scope }
  | { phase: "checkpoint"; scope: Scope; continuation: "need_assistant" | "may_finish" }
  | { phase: "assistant_ready"; scope: Scope }
  | { phase: "assistant_effect_pending"; scope: Scope; responseEntryId: string; usageId: string }
  | { phase: "retry_wait"; scope: Scope; notBefore: number }
  | { phase: "tools"; scope: Scope; responseEntryId: string; calls: ToolCallState[] }
  | {
      phase: "summary_deciding";
      scope: Scope;
      reason: SummaryReason;
      boundary: SummaryBoundary;
      targetId?: string | null;
    }
  | {
      phase: "summary_effect_pending";
      scope: Scope;
      reason: SummaryReason;
      boundary: SummaryBoundary;
      targetId?: string | null;
      responseEntryId: string;
      usageId: string;
      sourceTipId: string | null;
      summarizedIds: string[];
      keptIds: string[];
      copyIds: string[];
      summaryMaxTokens: number;
      estimatedInput: number;
    }
  | { phase: "navigation_ready"; scope: Scope; targetId: string | null };

interface OperationMeta {
  operationId: string;
  lane: string;
  sourceTipId: string | null;
  startedAt: number;
  intent: { kind: "run"; promptEntryIds: string[] } | { kind: "compaction" } | { kind: "navigation"; targetId: string | null };
}

interface LaneRecord {
  currentOperationId: string | null;
  lastOperationId: string | null;
  inbox: InboxItem[];
}

interface InboxItem {
  entryId: string;
  kind: "steer" | "followUp" | "write";
}

type Plan =
  | { type: "continue" }
  | { type: "settled"; result: OperationResult }
  | { type: "wait"; notBefore: number }
  | { type: "error"; error: HarnessFailure }
  | { type: "assistant"; operationId: string; responseEntryId: string; usageId: string }
  | { type: "summary"; operationId: string; responseEntryId: string; usageId: string }
  | { type: "tools"; operationId: string }
  | { type: "approval"; notBefore: number }
  | { type: "yield" };

const running = (): Scope => ({ control: { status: "running" }, attempt: 0, overflowUsed: false, thresholdUsed: false });

/** Admitted storage calls. The public `storage` field stays the caller's instance. */
const trackedStorage = new WeakMap<AgentHarness, Storage>();

/**
 * Tool names `allowForSession` exempts for this process.
 * A new harness asks again. Parked calls do not consult this set; they still need `approve`.
 */
const sessionAllowedTools = new WeakMap<AgentHarness, Set<string>>();

function sessionAllowed(harness: AgentHarness): Set<string> {
  const existing = sessionAllowedTools.get(harness);
  if (existing) return existing;
  const created = new Set<string>();
  sessionAllowedTools.set(harness, created);
  return created;
}

function admitted(harness: AgentHarness): Storage {
  const storage = trackedStorage.get(harness);
  if (!storage) throw new Error("harness storage is missing");
  return storage;
}

/**
 * Durable lane runtime. `accept` records an operation and does not call a model.
 * `drive` advances the total operation state. A new process resumes from that state:
 * provider streams are not reattached, unsafe tools are not repeated, safe tools are.
 */
export class AgentHarness {
  private closed = false;
  private abandoned = false;
  private abort = new AbortController();
  private quiet: Promise<void> | undefined;
  private readonly drives = new Map<string, Promise<Result<DriveOutcome>>>();
  /** Storage work admitted outside a drive: accept, queue, abort, and reads. */
  private readonly side = new Set<Promise<unknown>>();
  private readonly idleListeners = new Set<() => void>();
  private readonly laneAborts = new Map<string, AbortController>();
  /** Effects this process has armed. A restarted harness has an empty set, so the same leaf means recovery. */
  readonly live = new Set<string>();
  readonly storage: Storage;
  readonly options: HarnessOptions;

  constructor(storage: Storage, options: HarnessOptions) {
    this.options = options;
    this.storage = storage;
    trackedStorage.set(this, {
      run: (fn) => this.observe(storage.run(fn)),
      commit: (writes) => this.observe(storage.commit(writes)),
      read: (fn) => this.observe(storage.read(fn)),
      subscribe: (listener) => storage.subscribe(listener),
      whenIdle: () => storage.whenIdle(),
    });
  }

  lane(name = "main"): AgentLane {
    return new AgentLane(this, name);
  }

  /** Conversation names stored in this session log. */
  conversations(): Promise<string[]> {
    const prefix = "value\0pi.lane.state\0";
    return this.storage.read((view) => view.values()
      .filter((item) => item.key.startsWith(prefix))
      .map((item) => item.key.slice(prefix.length))
      .sort());
  }

  /** Drop this process without settling in-flight effects. Storage stays where the last commit left it. */
  abandon(): void {
    this.abandoned = true;
  }

  /**
   * Stops admission and aborts the harness signal. Does not persist `requestAbort` and does not close storage.
   * Resolves when admitted drives, side operations, and the storage queue behind them have finished.
   * A tool that ignores the signal keeps this promise pending. Concurrent calls share one promise;
   * a rejected storage barrier may be retried without reopening admission.
   */
  close(): Promise<void> {
    return this.shutdown("abort");
  }

  /**
   * Stops admission without aborting in-flight work and without persisting `requestAbort`.
   * A later `close()` still aborts the signal and waits on this same promise.
   */
  drain(): Promise<void> {
    return this.shutdown("drain");
  }

  /**
   * True when no drive and no admitted storage work is in flight.
   * A settled retry wait is idle: the operation remains persisted, and nothing here drives it again.
   */
  idle(): boolean {
    return this.drives.size === 0 && this.side.size === 0;
  }

  /**
   * Fires when a drive or admitted storage work starts or finishes.
   * It does not report the state at registration. The return value unsubscribes.
   * A listener error is ignored so it cannot break drive tracking.
   */
  watchIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => { this.idleListeners.delete(listener); };
  }

  private notifyIdle(): void {
    for (const listener of [...this.idleListeners]) {
      try {
        listener();
      } catch {
        // The listener cannot interrupt settlement or the caller that admitted the work.
      }
    }
  }

  /** Remember work that must finish before `close` or `drain` resolves. */
  private observe<T>(work: Promise<T>): Promise<T> {
    this.side.add(work);
    this.notifyIdle();
    // The derived promise must not surface a second rejection of `work`.
    void work.finally(() => {
      this.side.delete(work);
      this.notifyIdle();
    }).catch(() => undefined);
    return work;
  }

  private shutdown(mode: "drain" | "abort"): Promise<void> {
    this.closed = true;
    if (mode === "abort") this.abort.abort();
    if (!this.quiet) {
      let quiet!: Promise<void>;
      quiet = this.waitUntilQuiet().catch((error: unknown) => {
        if (this.quiet === quiet) this.quiet = undefined;
        throw error;
      });
      this.quiet = quiet;
    }
    return this.quiet;
  }

  private async waitUntilQuiet(): Promise<void> {
    for (;;) {
      const pending = [...this.drives.values(), ...this.side];
      if (pending.length === 0) {
        await this.storage.whenIdle();
        if (this.drives.size === 0 && this.side.size === 0) return;
        continue;
      }
      await Promise.allSettled(pending);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isAbandoned(): boolean {
    return this.abandoned;
  }

  signal(): AbortSignal {
    return this.abort.signal;
  }

  laneSignal(name: string): AbortSignal {
    return AbortSignal.any([this.abort.signal, this.laneController(name).signal]);
  }

  replaceLaneAbort(name: string): void {
    const previous = this.laneController(name);
    this.laneAborts.set(name, new AbortController());
    previous.abort();
  }

  /** One in-flight drive per lane and operation. A second caller on that lane waits instead of sending again. */
  claimDrive(lane: string, operationId: string, start: () => Promise<Result<DriveOutcome>>): Promise<Result<DriveOutcome>> {
    const key = `${lane}\0${operationId}`;
    const existing = this.drives.get(key);
    if (existing) return existing;
    if (this.closed) return Promise.resolve(failure("closed", "harness is closed"));
    let settle: (value: Result<DriveOutcome>) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const run = new Promise<Result<DriveOutcome>>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.drives.set(key, run);
    this.notifyIdle();
    let started: Promise<Result<DriveOutcome>>;
    try {
      started = start();
    } catch (error) {
      if (this.drives.get(key) === run) this.drives.delete(key);
      this.notifyIdle();
      fail(error);
      return run;
    }
    void started.then(
      (value) => {
        if (this.drives.get(key) === run) this.drives.delete(key);
        this.notifyIdle();
        settle(value);
      },
      (error: unknown) => {
        if (this.drives.get(key) === run) this.drives.delete(key);
        this.notifyIdle();
        fail(error);
      },
    );
    return run;
  }

  private laneController(name: string): AbortController {
    const existing = this.laneAborts.get(name);
    if (existing) return existing;
    const created = new AbortController();
    this.laneAborts.set(name, created);
    return created;
  }
}

export class AgentLane {
  private readonly harness: AgentHarness;
  readonly name: string;

  constructor(harness: AgentHarness, name: string) {
    this.harness = harness;
    this.name = name;
  }

  accept(request: OperationRequest): Promise<Result<OperationAdmission>> {
    if (this.harness.isClosed) return Promise.resolve(failure("closed", "harness is closed"));
    return admitted(this.harness).run((view, apply) => this.acceptLocked(view, apply, request));
  }

  drive(operationId: string, options: { waitForRetry?: boolean } = {}): Promise<Result<DriveOutcome>> {
    return this.harness.claimDrive(this.name, operationId, () => createTypedSpanStarter(
      this.harness.options.telemetryContext ?? this.harness.options.models.telemetryContext,
      [durableTelemetrySchema],
    )(
      "amazme.harness.drive",
      { lane: this.name, operationId },
      async (span) => {
        const outcome = await this.driveBody(operationId, options, span);
        if (!outcome.ok || (outcome.value.kind === "settled" && outcome.value.result.status !== "completed")) {
          span.setStatus({ status: "error" });
        }
        return outcome;
      },
    ));
  }

  private async driveBody(operationId: string, options: { waitForRetry?: boolean }, span: DriveSpan): Promise<Result<DriveOutcome>> {
    if (this.harness.isClosed) return failure("closed", "harness is closed");
    const signal = this.harness.laneSignal(this.name);
    for (let step = 0; step < 64; step++) {
      if (this.harness.isAbandoned || this.harness.signal().aborted) return this.settledOrWait(operationId);
      const planned = await admitted(this.harness).run((view, apply) => this.plan(view, apply, operationId, span));
      if (this.harness.isAbandoned) return this.settledOrWait(operationId);
      if (planned.type === "error") return { ok: false, error: planned.error };
      if (planned.type === "settled") return { ok: true, value: { kind: "settled", result: planned.result } };
      if (planned.type === "wait") {
        span.addEvent("amazme.harness.retry_wait");
        if (options.waitForRetry) {
          await waitUntil(planned.notBefore, signal);
          continue;
        }
        return { ok: true, value: { kind: "waiting", operationId, reason: "retry", notBefore: planned.notBefore } };
      }
      if (planned.type === "approval") {
        // notBefore is the earliest parked requestedAt, so a repeated drive returns the same value and writes nothing.
        return { ok: true, value: { kind: "waiting", operationId, reason: "approval", notBefore: planned.notBefore } };
      }
      if (planned.type === "continue") continue;
      // Abort can land inside plan(), after this step has armed a model or tool effect.
      // Do not start that effect. Drain leaves the signal alone, so the same step still runs.
      if (this.harness.signal().aborted) {
        if (planned.type === "assistant" || planned.type === "summary") this.harness.live.delete(planned.responseEntryId);
        return this.settledOrWait(operationId);
      }
      if (planned.type === "yield") {
        const text = await walkYield(this.hookList(), signal);
        if (this.harness.isAbandoned) return this.settledOrWait(operationId);
        const applied = await admitted(this.harness).run((view, apply) => this.applyYield(view, apply, operationId, text, signal));
        if (applied.type === "error") return { ok: false, error: applied.error };
        if (applied.type === "settled") return { ok: true, value: { kind: "settled", result: applied.result } };
        continue;
      }
      if (planned.type === "assistant") {
        try {
          const streamed = await this.streamAssistant(planned, signal, span);
          if (this.harness.isAbandoned || !streamed) return this.settledOrWait(operationId);
          await admitted(this.harness).run((view, apply) => this.settleAssistant(view, apply, planned, streamed.message, streamed.timedOut));
        } finally {
          this.harness.live.delete(planned.responseEntryId);
        }
        continue;
      }
      if (planned.type === "summary") {
        try {
          const message = await this.streamSummary(signal, span);
          if (this.harness.isAbandoned || !message) return this.settledOrWait(operationId);
          await admitted(this.harness).run((view, apply) => this.settleSummary(view, apply, planned, message));
        } finally {
          this.harness.live.delete(planned.responseEntryId);
        }
        continue;
      }
      await this.runTools(operationId, signal, span);
      if (this.harness.isAbandoned) return this.settledOrWait(operationId);
    }
    throw new Error("drive exceeded 64 durable steps");
  }

  async prompt(text: string): Promise<OperationResult> {
    const admitted = await this.accept({ kind: "prompt", text });
    if (!admitted.ok) throw new Error(admitted.error.message);
    const outcome = await this.drive(admitted.value.operationId, { waitForRetry: true });
    if (!outcome.ok) throw new Error(outcome.error.message);
    if (outcome.value.kind !== "settled") throw new Error("prompt ended while waiting");
    return outcome.value.result;
  }

  async steer(message: HarnessMessage | string): Promise<Result<{ entryId: string }>> {
    return this.enqueue(typeof message === "string" ? user(message) : message, "steer");
  }

  async followUp(message: HarnessMessage | string): Promise<Result<{ entryId: string }>> {
    return this.enqueue(typeof message === "string" ? user(message) : message, "followUp");
  }

  /**
   * Read or replace this lane's provider, model, and thinking level.
   * A read is allowed while an operation is open. A write is not.
   * The system prompt is left as stored. A write also becomes the default for lanes created later.
   * A lane that already has its own config keeps that config.
   */
  configure(patch: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel } = {}): Promise<Result<LaneSettings>> {
    if (this.harness.isClosed) return Promise.resolve(failure("closed", "harness is closed"));
    return admitted(this.harness).run((view, apply) => {
      this.ensureConfig(view, apply);
      const config = this.config(view);
      const hasProvider = patch.provider !== undefined;
      const hasModel = patch.modelId !== undefined;
      if (hasProvider !== hasModel) return failure("invalid_message", "provider and model are set together");
      const writing = hasProvider || patch.thinkingLevel !== undefined;
      if (writing && this.record(view).currentOperationId) return failure("lane_busy", "lane already has an operation");
      const provider = patch.provider ?? config.provider;
      const modelId = patch.modelId ?? config.modelId;
      const model = this.harness.options.models.getModel(provider, modelId);
      if (!model) return failure("invalid_message", `unknown model ${provider}/${modelId}`);
      const thinkingLevels = supportedThinkingLevels(model);
      const thinkingLevel = patch.thinkingLevel ?? config.thinkingLevel;
      if (!thinkingLevels.includes(thinkingLevel)) {
        return failure("invalid_message", `thinking level ${thinkingLevel} is not supported; available: ${thinkingLevels.join(", ")}`);
      }
      if (writing) {
        apply([{ type: "set", address: configAddress(this.name), value: { ...config, provider, modelId, thinkingLevel } }]);
        this.harness.options.model = { provider, modelId };
        this.harness.options.thinkingLevel = thinkingLevel;
      }
      return { ok: true as const, value: { provider, modelId, thinkingLevel, thinkingLevels } };
    });
  }

  /** Models the host registered, this lane's thinking levels, and the workspace label. */
  catalog(): Promise<Result<LaneCatalog>> {
    if (this.harness.isClosed) return Promise.resolve(failure("closed", "harness is closed"));
    return admitted(this.harness).run((view, apply) => {
      this.ensureConfig(view, apply);
      const config = this.config(view);
      const model = this.harness.options.models.getModel(config.provider, config.modelId);
      const listed = this.harness.options.models.listModels?.() ?? [];
      return {
        ok: true as const,
        value: {
          directory: this.harness.options.workspace ?? "",
          models: listed.map((item) => ({ provider: item.provider, modelId: item.id })),
          thinkingLevels: model ? supportedThinkingLevels(model) : ["off"],
        },
      };
    });
  }

  /**
   * Open another conversation at `entryId` in this log. The source tip and its admitted wait stay put.
   * Later entries on either conversation do not move the other tip.
   * An existing target conversation is refused. The child copies this lane's stored config.
   */
  fork(name: string, entryId: string | null): Promise<Result<{ lane: string }>> {
    if (this.harness.isClosed) return Promise.resolve(failure("closed", "harness is closed"));
    if (name.length === 0 || name.includes("\0") || name === this.name) {
      return Promise.resolve(failure("invalid_message", "fork needs another conversation"));
    }
    return admitted(this.harness).run((view, apply) => {
      this.ensureConfig(view, apply);
      if (view.get(laneAddress(name))) return failure("invalid_message", "conversation already exists");
      const tip = view.get<string | null>(tipAddress(this.name)) ?? null;
      if (entryId !== null && !ancestors(view, tip).some((entry) => entry.id === entryId)) {
        return failure("unknown_target", "fork point is not in this conversation");
      }
      apply([{ type: "set", address: configAddress(name), value: this.config(view) }]);
      this.ensureLane(view, apply, name);
      apply([{ type: "set", address: tipAddress(name), value: entryId }]);
      return { ok: true as const, value: { lane: name } };
    });
  }

  /**
   * Create another conversation from plain user and assistant text.
   * The source conversation stays where it is. Original lines remain in the log.
   */
  importConversation(
    name: string,
    messages: readonly { role: "user" | "assistant"; text: string }[],
  ): Promise<Result<{ lane: string; tipId: string | null }>> {
    if (this.harness.isClosed) return Promise.resolve(failure("closed", "harness is closed"));
    if (name.length === 0 || name.includes("\0") || name === this.name) {
      return Promise.resolve(failure("invalid_message", "import needs another conversation"));
    }
    if (messages.length === 0) return Promise.resolve(failure("invalid_message", "import needs messages"));
    return admitted(this.harness).run((view, apply) => {
      this.ensureConfig(view, apply);
      if (view.get(laneAddress(name))) return failure("invalid_message", "conversation already exists");
      const config = this.config(view);
      apply([{ type: "set", address: configAddress(name), value: config }]);
      this.ensureLane(view, apply, name);
      let parent: string | null = null;
      const writes: Write[] = [];
      for (const message of messages) {
        if ((message.role !== "user" && message.role !== "assistant") || typeof message.text !== "string") {
          return failure("invalid_message", "import messages are user or assistant text");
        }
        const id = uuidv7();
        writes.push({
          type: "entry",
          id,
          parentId: parent,
          timestamp: Date.now(),
          payload: {
            type: "message",
            message: message.role === "user" ? user(message.text) : importedAssistant(config, message.text),
          },
        });
        parent = id;
      }
      writes.push({ type: "set", address: tipAddress(name), value: parent });
      apply(writes);
      return { ok: true as const, value: { lane: name, tipId: parent } };
    });
  }

  async requestAbort(operationId: string): Promise<Result<{ operationId: string; newlyRequested: boolean }>> {
    if (this.harness.isClosed) return failure("closed", "harness is closed");
    const result = await admitted(this.harness).run((view, apply) => {
      const record = this.record(view);
      if (record.currentOperationId !== operationId) {
        return failure("operation_mismatch", "operation is not current");
      }
      const state = view.get<OperationState>(stateAddress(operationId));
      if (!state) return failure("no_active_operation", "operation state is missing");
      if (state.scope.control.status === "cancel_requested") {
        return { ok: true as const, value: { operationId, newlyRequested: false } };
      }
      const next: OperationState = {
        ...state,
        scope: { ...state.scope, control: { status: "cancel_requested", requestedAt: Date.now() } },
      };
      const steer = record.inbox.filter((item) => item.kind === "steer" || item.kind === "followUp");
      const kept = record.inbox.filter((item) => item.kind === "write");
      const writes: Write[] = [
        { type: "set", address: stateAddress(operationId), value: next },
        { type: "set", address: laneAddress(this.name), value: { ...record, inbox: kept } },
      ];
      for (const item of steer) writes.push({ type: "delete", address: pendingAddress(item.entryId) });
      apply(writes);
      return { ok: true as const, value: { operationId, newlyRequested: true } };
    });
    if (result.ok && result.value.newlyRequested) this.harness.replaceLaneAbort(this.name);
    return result;
  }

  inspect(): Promise<LaneStatus> {
    return admitted(this.harness).read((view) => this.status(view).status);
  }

  entries(): Promise<Entry[]> {
    return admitted(this.harness).read((view) => {
      const tip = view.get<string | null>(tipAddress(this.name)) ?? null;
      return ancestors(view, tip);
    });
  }

  /** Read-only: does not initialize the lane, drive, or recover, and never synthesizes a settled message. */
  snapshot(): Promise<LaneSnapshot> {
    return admitted(this.harness).read((view) => {
      const { status, state } = this.status(view);
      let pendingResponse: PendingResponse | null = null;
      if (status.operationId && state?.phase === "assistant_effect_pending") {
        const frames = view.items(frameAddress(status.operationId, state.responseEntryId)).map((item) => item.item as AssistantFrame);
        const reduced = reduceFrames(frames);
        pendingResponse = {
          operationId: status.operationId,
          responseEntryId: state.responseEntryId,
          content: reduced.content,
          stopReason: reduced.stopReason ?? null,
          errorMessage: reduced.errorMessage ?? null,
        };
      }
      return structuredClone({
        version: view.version(),
        ...status,
        entries: ancestors(view, status.tipId),
        pendingResponse,
        tools: toolActivity(view, state),
      });
    });
  }

  /** Read-only usage projection. One storage read. Does not initialize the lane, drive, or recover. */
  usage(): Promise<LaneUsageView> {
    return admitted(this.harness).read((view) => {
      const { status } = this.status(view);
      const chain = ancestors(view, status.tipId);
      return structuredClone({
        version: view.version(),
        ...projectUsage(view, this.name, chain, this.harness.options),
      });
    });
  }

  /**
   * Read-only retry deadline, compaction flag, and turn start. One storage read.
   * Does not initialize the lane, drive, or recover. Plain data: clone and JSON keep the same value.
   */
  laneStatus(): Promise<LaneRunStatus> {
    return admitted(this.harness).read((view) => {
      const { state } = this.status(view);
      const retry = state?.phase === "retry_wait" ? state : undefined;
      return structuredClone({
        notBefore: retry ? retry.notBefore : null,
        retryReason: retry ? retryErrorText(view, this.name) : null,
        compacting: state?.phase === "summary_deciding" || state?.phase === "summary_effect_pending",
        turnStartedAt: turnStartedAt(view, this.name),
      });
    });
  }

  /**
   * Read-only checkpoint tails for running tool calls. One storage read. Does not drive.
   * The same tail is `outputTail` on the running tool in `snapshot()`.
   * After a process crash, a call left in `effect_pending` keeps showing its old tail until the next drive
   * moves that call to interrupted.
   */
  toolOutput(): Promise<ToolOutputView> {
    return admitted(this.harness).read((view) => {
      const { state } = this.status(view);
      return structuredClone({ version: view.version(), tails: toolOutputTails(view, state) });
    });
  }

  /**
   * Tool calls parked by `requiresApproval` and not yet decided.
   * Does not drive, recover, or call the model. The result is a detached plain object.
   */
  pendingApprovals(): Promise<PendingApprovals> {
    return admitted(this.harness).read((view) => {
      const operationId = this.record(view).currentOperationId;
      const state = operationId ? view.get<OperationState>(stateAddress(operationId)) : undefined;
      const items: PendingApproval[] = state?.phase === "tools"
        ? state.calls.flatMap((call) => {
          if (call.status !== "planned" || !call.approval || call.approval.decision) return [];
          return [{
            toolCallId: call.toolCallId,
            name: call.name,
            arguments: call.approval.arguments,
            requestedAt: call.approval.requestedAt,
          }];
        })
        : [];
      return structuredClone({ version: view.version(), items });
    });
  }

  /**
   * Record `decision` before any tool run or denial result.
   * `allow` then follows the normal tool path. `deny` writes an error result and the turn continues
   * once every call in the batch is settled. The same id again does not run a second time.
   * An id that was never parked and has no tool result throws.
   */
  async approve(toolCallId: string, decision: "allow" | "deny", reason?: string): Promise<void> {
    if (decision !== "allow" && decision !== "deny") throw new Error("approval decision must be allow or deny");
    if (this.harness.isClosed) throw new Error("harness is closed");
    const gate = await admitted(this.harness).run((view, apply) => this.stageApproval(view, apply, toolCallId, decision, reason));
    if (gate.action === "unknown") throw new Error(`unknown tool call: ${toolCallId}`);
    if (gate.action === "settled") return;
    const outcome = await this.drive(gate.operationId);
    if (!outcome.ok) throw new Error(outcome.error.message);
  }

  /**
   * Later calls of `name` skip `requiresApproval` until this process exits.
   * A call already parked is unchanged and still needs `approve`.
   */
  allowForSession(name: string): void {
    if (name.length === 0) throw new Error("tool name is empty");
    sessionAllowed(this.harness).add(name);
  }

  /**
   * Ancestors strictly before `before`, newest page last, at most `limit` entries.
   * `before: null` is the newest page. `older` is how many ancestors remain before the page.
   * It does not drive or recover.
   */
  history(before: string | null, limit: number): Promise<Result<{ entries: Entry[]; older: number }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Promise.resolve(failure("invalid_message", "history limit must be an integer from 1 to 100"));
    }
    return admitted(this.harness).read((view) => {
      const chain = ancestors(view, view.get<string | null>(tipAddress(this.name)) ?? null);
      let end = chain.length;
      if (before !== null) {
        const index = chain.findIndex((entry) => entry.id === before);
        if (index < 0) return failure("unknown_target", "the entry is not on this lane");
        end = index;
      }
      const start = Math.max(0, end - limit);
      return { ok: true, value: { entries: structuredClone(chain.slice(start, end)), older: start } };
    });
  }

  /** The settled result of an operation of this lane, or `null` before settlement. Never drives. */
  result(operationId: string): Promise<Result<OperationResult | null>> {
    return admitted(this.harness).read((view): Result<OperationResult | null> => {
      const result = view.get<OperationResult>(resultAddress(operationId));
      if (result) {
        if (result.lane !== this.name) return failure("operation_mismatch", "result does not belong to this lane");
        return { ok: true, value: structuredClone(result) };
      }
      const meta = view.get<OperationMeta>(metaAddress(operationId));
      if (meta && meta.lane !== this.name) return failure("operation_mismatch", "operation belongs to another lane");
      return { ok: true, value: null };
    });
  }

  private status(view: StorageView): { status: LaneStatus; state: OperationState | undefined } {
    const record = view.get<LaneRecord>(laneAddress(this.name));
    const operationId = record?.currentOperationId ?? null;
    const state = operationId ? view.get<OperationState>(stateAddress(operationId)) : undefined;
    return {
      state,
      status: {
        lane: this.name,
        tipId: view.get<string | null>(tipAddress(this.name)) ?? null,
        phase: state?.phase ?? null,
        operationId,
        lastOperationId: record?.lastOperationId ?? null,
        status: state ? (state.scope.control.status === "cancel_requested" ? "aborting" : "open") : null,
      },
    };
  }

  private async enqueue(message: HarnessMessage, kind: InboxItem["kind"]): Promise<Result<{ entryId: string }>> {
    if (this.harness.isClosed) return failure("closed", "harness is closed");
    if (message.role !== "user" && message.role !== "custom") return failure("invalid_message", "queue accepts user messages");
    const entryId = uuidv7();
    await admitted(this.harness).run((view, apply) => {
      this.ensureConfig(view, apply);
      const record = this.record(view);
      apply([
        { type: "set", address: pendingAddress(entryId), value: { type: "message", message } satisfies import("./storage.ts").EntryPayload },
        {
          type: "set",
          address: laneAddress(this.name),
          value: { ...record, inbox: [...record.inbox, { entryId, kind }] },
        },
      ]);
    });
    return { ok: true, value: { entryId } };
  }

  private acceptLocked(view: StorageView, apply: Apply, request: OperationRequest): Result<OperationAdmission> {
    this.ensureConfig(view, apply);
    const record = this.record(view);
    if (record.currentOperationId) return failure("lane_busy", "lane already has an operation");
    const operationId = request.operationId ?? uuidv7();
    const startedAt = Date.now();
    const sourceTipId = view.get<string | null>(tipAddress(this.name)) ?? null;
    if (request.kind === "prompt") {
      const imageContent = request.content?.some((block) => block.type === "image") === true ? request.content : undefined;
      if (!request.text.trim() && !imageContent) return failure("invalid_message", "prompt is empty");
      const placed = this.placeInbox(view, apply, record, true, true);
      const promptId = uuidv7();
      const parent = placed.tipId;
      apply([
        {
          type: "entry",
          id: promptId,
          parentId: parent,
          timestamp: startedAt,
          payload: { type: "message", message: imageContent ? { role: "user", content: imageContent, timestamp: startedAt } : user(request.text) },
        },
        { type: "set", address: tipAddress(this.name), value: promptId },
        {
          type: "set",
          address: metaAddress(operationId),
          value: {
            operationId,
            lane: this.name,
            sourceTipId,
            startedAt,
            intent: { kind: "run", promptEntryIds: [promptId] },
          } satisfies OperationMeta,
        },
        { type: "set", address: stateAddress(operationId), value: { phase: "starting", scope: running() } satisfies OperationState },
        {
          type: "set",
          address: laneAddress(this.name),
          value: { ...placed.record, currentOperationId: operationId },
        },
      ]);
      return { ok: true, value: { operationId, kind: "run", startedAt } };
    }
    if (request.kind === "compaction") {
      if (ancestors(view, sourceTipId).length === 0) return failure("nothing_to_compact", "nothing to compact");
      this.writeOperation(apply, record, {
        operationId,
        lane: this.name,
        sourceTipId,
        startedAt,
        intent: { kind: "compaction" },
      }, {
        phase: "summary_deciding",
        scope: running(),
        reason: "threshold",
        boundary: "finish",
      });
      return { ok: true, value: { operationId, kind: "compaction", startedAt } };
    }
    if (request.targetId !== null && !view.entry(request.targetId)) return failure("unknown_target", "navigation target does not exist");
    const state: OperationState = request.summarize
      ? { phase: "summary_deciding", scope: running(), reason: "threshold", boundary: "navigation", targetId: request.targetId }
      : { phase: "navigation_ready", scope: running(), targetId: request.targetId };
    this.writeOperation(apply, record, {
      operationId,
      lane: this.name,
      sourceTipId,
      startedAt,
      intent: { kind: "navigation", targetId: request.targetId },
    }, state);
    return { ok: true, value: { operationId, kind: "navigation", startedAt } };
  }

  private plan(view: StorageView, apply: Apply, operationId: string, span: DriveSpan): Plan {
    if (this.harness.isAbandoned) return { type: "continue" };
    const record = this.record(view);
    if (record.currentOperationId !== operationId) {
      const existing = view.get<OperationResult>(resultAddress(operationId));
      if (existing?.lane === this.name) return { type: "settled", result: existing };
      return { type: "error", error: { code: "operation_mismatch", message: "operation is not current" } };
    }
    const state = view.get<OperationState>(stateAddress(operationId));
    const meta = view.get<OperationMeta>(metaAddress(operationId));
    if (!state || !meta || meta.lane !== this.name) {
      return { type: "error", error: { code: "operation_mismatch", message: "operation is missing or belongs to another lane" } };
    }
    const cancel = state.scope.control.status === "cancel_requested";
    if (cancel && state.phase !== "assistant_effect_pending" && state.phase !== "summary_effect_pending" && state.phase !== "tools") {
      return { type: "settled", result: this.finish(view, apply, meta, "aborted", "cancelled") };
    }
    if (state.phase === "starting") {
      apply([{ type: "set", address: stateAddress(operationId), value: { phase: "checkpoint", scope: state.scope, continuation: "need_assistant" } }]);
      return { type: "continue" };
    }
    if (state.phase === "retry_wait") {
      if (Date.now() < state.notBefore) return { type: "wait", notBefore: state.notBefore };
      return this.beginModelRequest(view, apply, meta, state.scope);
    }
    if (state.phase === "checkpoint") {
      const includeFollow = state.continuation === "may_finish";
      const placed = this.placeInbox(view, apply, record, true, includeFollow);
      if (!placed.moved && state.continuation !== "need_assistant") {
        if (this.modelStoppedWithoutTools(view)) return { type: "yield" };
        return { type: "settled", result: this.finish(view, apply, meta, "completed") };
      }
      apply([{ type: "set", address: laneAddress(this.name), value: { ...placed.record, currentOperationId: operationId } }]);
      return this.beginModelRequest(view, apply, meta, state.scope);
    }
    if (state.phase === "assistant_ready") {
      const responseEntryId = uuidv7();
      const usageId = uuidv7();
      apply([{
        type: "set",
        address: stateAddress(operationId),
        value: { phase: "assistant_effect_pending", scope: state.scope, responseEntryId, usageId },
      }]);
      this.harness.live.add(responseEntryId);
      return { type: "assistant", operationId, responseEntryId, usageId };
    }
    if (state.phase === "assistant_effect_pending") {
      if (this.harness.live.has(state.responseEntryId)) {
        return { type: "assistant", operationId, responseEntryId: state.responseEntryId, usageId: state.usageId };
      }
      this.recoverResponse(view, apply, meta, state);
      span.addEvent("amazme.harness.recovered", { effect: "assistant" });
      return { type: "continue" };
    }
    if (state.phase === "summary_deciding") {
      const prepared = this.prepareCompaction(view, state);
      if (!prepared.ok) {
        if (prepared.code === "nothing_to_compact" && state.boundary === "resume" && state.reason === "threshold") {
          const budget = this.requestBudget(view);
          if (budget?.status === "ok") {
            apply([{ type: "set", address: stateAddress(operationId), value: { phase: "assistant_ready", scope: state.scope } }]);
            return { type: "continue" };
          }
        }
        const message = state.reason === "overflow" && prepared.code === "nothing_to_compact"
          ? "context overflow; nothing to compact"
          : prepared.message;
        return { type: "settled", result: this.finish(view, apply, meta, "failed", message) };
      }
      const responseEntryId = uuidv7();
      const usageId = uuidv7();
      const copyIds = prepared.plan.keptIds.map(() => uuidv7());
      apply([{
        type: "set",
        address: stateAddress(operationId),
        value: {
          ...state,
          phase: "summary_effect_pending",
          responseEntryId,
          usageId,
          sourceTipId: view.get<string | null>(tipAddress(this.name)) ?? null,
          summarizedIds: prepared.plan.summarizedIds,
          keptIds: prepared.plan.keptIds,
          copyIds,
          summaryMaxTokens: prepared.plan.maxTokens,
          estimatedInput: prepared.plan.estimatedInput,
        },
      }]);
      this.harness.live.add(responseEntryId);
      return { type: "summary", operationId, responseEntryId, usageId };
    }
    if (state.phase === "summary_effect_pending") {
      if (this.harness.live.has(state.responseEntryId)) {
        return { type: "summary", operationId, responseEntryId: state.responseEntryId, usageId: state.usageId };
      }
      this.recoverResponse(view, apply, meta, state);
      span.addEvent("amazme.harness.recovered", { effect: "summary" });
      return { type: "continue" };
    }
    if (state.phase === "tools") {
      if (state.scope.control.status !== "cancel_requested" && blockedOnApproval(state)) {
        let parked = state;
        if (state.calls.some((call) => call.status === "outcome_ready")) {
          this.materializeTools(view, apply, operationId);
          const refreshed = view.get<OperationState>(stateAddress(operationId));
          if (!refreshed || refreshed.phase !== "tools") return { type: "continue" };
          if (!blockedOnApproval(refreshed)) return { type: "tools", operationId };
          parked = refreshed;
        }
        return { type: "approval", notBefore: earliestApprovalRequestedAt(parked) };
      }
      return { type: "tools", operationId };
    }
    const target = state.targetId;
    if (target !== null && !view.entry(target)) {
      return { type: "settled", result: this.finish(view, apply, meta, "failed", "missing navigation target") };
    }
    return {
      type: "settled",
      result: this.finish(view, apply, meta, "completed", undefined, {
        writes: [{ type: "set", address: tipAddress(this.name), value: target }],
        tipId: target,
      }),
    };
  }

  private async streamAssistant(planned: Extract<Plan, { type: "assistant" }>, signal: AbortSignal, telemetryContext: TelemetryContext): Promise<{ message: AssistantMessage; timedOut: boolean } | undefined> {
    const context = await admitted(this.harness).read((view) => this.providerContext(view));
    const config = await admitted(this.harness).read((view) => this.config(view));
    if (this.harness.isAbandoned) return undefined;
    const model = this.harness.options.models.getModel(config.provider, config.modelId);
    if (!model) return { message: missingModel(config), timedOut: false };
    const replaced = await walkTransform(this.hookList(), context.messages as AgentMessage[], signal);
    if (this.harness.isAbandoned || signal.aborted) return undefined;
    const request = replaced ? { ...context, messages: toProviderMessages(replaced) } : context;
    const deadline = this.deadline(config.requestTimeoutMs, signal);
    let frames = Promise.resolve();
    let frameFailure: { error: unknown } | undefined;
    let contentFrames = 0;
    let result: Promise<AssistantMessage> | undefined;
    try {
      const requestOptions: StreamOptions = {
        signal: deadline.signal,
        thinkingLevel: config.thinkingLevel,
        telemetryContext,
        onActivity: () => deadline.touch(),
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      };
      const stream = this.harness.options.models.streamSimple(model, request, requestOptions);
      result = stream.result();
      for await (const event of stream) {
        deadline.touch();
        const frame = frameFromEvent(event);
        if (!frame) continue;
        if (frame.type !== "stop") contentFrames += 1;
        const queued = this.appendFrame(planned, frame).catch((error: unknown) => {
          frameFailure ??= { error };
        });
        frames = frames.then(() => queued);
      }
    } catch (error) {
      await frames;
      if (frameFailure) throw frameFailure.error;
      if (deadline.timedOut() && contentFrames === 0) {
        return { message: timeoutMessage(model, "retryable_timeout", []), timedOut: true };
      }
      throw error;
    } finally {
      deadline.dispose();
      await frames;
    }
    if (frameFailure) throw frameFailure.error;
    if (!result) throw new Error("model stream did not start");
    return { message: await result, timedOut: deadline.timedOut() };
  }

  private async streamSummary(signal: AbortSignal, telemetryContext: TelemetryContext): Promise<AssistantMessage | undefined> {
    const prepared = await admitted(this.harness).read((view) => {
      const operationId = this.record(view).currentOperationId;
      const state = operationId ? view.get<OperationState>(stateAddress(operationId)) : undefined;
      const config = this.config(view);
      if (!state || state.phase !== "summary_effect_pending") return { config, request: undefined };
      return { config, request: this.summaryRequest(view, state) };
    });
    if (this.harness.isAbandoned) return undefined;
    const model = this.harness.options.models.getModel(prepared.config.provider, prepared.config.modelId);
    const request = prepared.request;
    if (!model || !request || !request.ok) {
      const failed = missingModel(prepared.config);
      if (model) failed.errorMessage = request && !request.ok ? request.message : "summary plan is missing";
      return failed;
    }
    const replaced = await walkTransform(this.hookList(), request.context.messages as AgentMessage[], signal);
    if (this.harness.isAbandoned || signal.aborted) return undefined;
    const summaryContext = replaced
      ? { ...request.context, messages: toProviderMessages(replaced) }
      : request.context;
    const deadline = this.deadline(prepared.config.requestTimeoutMs, signal);
    const requestOptions: StreamOptions = {
      signal: deadline.signal,
      thinkingLevel: "off",
      maxTokens: request.maxTokens,
      telemetryContext,
      onActivity: () => deadline.touch(),
    };
    const stream = this.harness.options.models.streamSimple(model, summaryContext, requestOptions);
    let message: AssistantMessage | undefined;
    try {
      for await (const event of stream) {
        deadline.touch();
        if (event.type === "done") message = event.message;
        if (event.type === "error") message = event.error;
      }
      message ??= await stream.result();
    } finally {
      deadline.dispose();
    }
    if (message && deadline.timedOut()) {
      return { ...message, stopReason: "aborted", retryable: false, errorMessage: message.errorMessage ?? "model request timed out" };
    }
    return message;
  }

  private appendFrame(planned: { operationId: string; responseEntryId: string }, frame: import("@amazme/ai").AssistantFrame): Promise<void> {
    return admitted(this.harness).run((view, apply) => {
      if (this.harness.isAbandoned) return;
      const state = view.get<OperationState>(stateAddress(planned.operationId));
      if (state?.phase !== "assistant_effect_pending" || state.responseEntryId !== planned.responseEntryId) return;
      apply([{ type: "append", address: frameAddress(planned.operationId, planned.responseEntryId), item: frame }]);
    });
  }

  private settleAssistant(
    view: StorageView,
    apply: Apply,
    planned: Extract<Plan, { type: "assistant" }>,
    incoming: AssistantMessage,
    timedOut: boolean,
  ): void {
    if (this.harness.isAbandoned) return;
    const state = view.get<OperationState>(stateAddress(planned.operationId));
    const meta = view.get<OperationMeta>(metaAddress(planned.operationId));
    if (!state || !meta || state.phase !== "assistant_effect_pending" || state.responseEntryId !== planned.responseEntryId) return;
    const config = this.config(view);
    const frames = view.items(frameAddress(planned.operationId, planned.responseEntryId)).map((item) => item.item as AssistantFrame);
    const action = classifyDeadline({
      timedOut,
      cancelRequested: state.scope.control.status === "cancel_requested",
      contentFrames: frames.filter((frame) => frame.type !== "stop").length,
    });
    const message = applyDeadline(incoming, action, frames);
    const calls = message.content.filter((block) => block.type === "toolCall");
    const cancel = state.scope.control.status === "cancel_requested" || message.stopReason === "aborted";
    const settledMessage: AssistantMessage = cancel
      ? { ...message, stopReason: "aborted", errorMessage: message.errorMessage ?? "cancelled" }
      : message.overflow
        ? { ...message, stopReason: "error", errorMessage: message.errorMessage ?? "context overflow" }
        : message;
    const writes = this.assistantWrites(view, planned, settledMessage);
    const advance = (transition: Write[]) => {
      apply([...writes, ...transition]);
      this.harness.live.delete(planned.responseEntryId);
    };
    const end = (status: OperationResult["status"], error: string) => {
      this.finish(view, apply, meta, status, error, { writes, tipId: planned.responseEntryId });
      this.harness.live.delete(planned.responseEntryId);
    };
    if (cancel) {
      end("aborted", message.errorMessage ?? "cancelled");
      return;
    }
    if (message.overflow) {
      if (!config.compaction.enabled) {
        const detail = message.errorMessage ?? "context overflow";
        end("failed", `${detail}; compaction is disabled`);
        return;
      }
      if (state.scope.overflowUsed) {
        end("failed", "context overflow repeated");
        return;
      }
      advance([{
        type: "set",
        address: stateAddress(planned.operationId),
        value: {
          phase: "summary_deciding",
          scope: { ...state.scope, overflowUsed: true },
          reason: "overflow",
          boundary: "resume",
        },
      }]);
      return;
    }
    if (message.stopReason === "error" && message.retryable && state.scope.attempt + 1 < config.maxAttempts) {
      advance([{
        type: "set",
        address: stateAddress(planned.operationId),
        value: {
          phase: "retry_wait",
          scope: { ...state.scope, attempt: state.scope.attempt + 1 },
          notBefore: Date.now() + retryNotBeforeDelayMs(config.retry, state.scope.attempt + 1, message.retryAfterMs),
        },
      }]);
      return;
    }
    if (message.stopReason === "error") {
      end("failed", message.errorMessage ?? "model error");
      return;
    }
    if (calls.length > 0 && message.stopReason === "length") {
      const toolStates: ToolCallState[] = calls.map((call) => ({
        sourceIndex: message.content.indexOf(call),
        resultEntryId: uuidv7(),
        toolCallId: call.id,
        name: call.name,
        status: "outcome_ready",
        terminate: false,
      }));
      const transition: Write[] = [{
        type: "set",
        address: stateAddress(planned.operationId),
        value: { phase: "tools", scope: state.scope, responseEntryId: planned.responseEntryId, calls: toolStates },
      }];
      for (const call of toolStates) {
        transition.push({
          type: "set",
          address: pendingAddress(call.resultEntryId),
          value: {
            type: "message",
            message: toolMessage(call, "Tool call discarded because the assistant response was truncated", true, false),
          },
        });
      }
      advance(transition);
      this.materializeTools(view, apply, planned.operationId);
      return;
    }
    if (calls.length > 0) {
      advance([{
        type: "set",
        address: stateAddress(planned.operationId),
        value: {
          phase: "tools",
          scope: state.scope,
          responseEntryId: planned.responseEntryId,
          calls: calls.map((call) => ({
            sourceIndex: message.content.indexOf(call),
            resultEntryId: uuidv7(),
            toolCallId: call.id,
            name: call.name,
            status: "planned" as const,
          })),
        },
      }]);
      return;
    }
    advance([{
      type: "set",
      address: stateAddress(planned.operationId),
      value: { phase: "checkpoint", scope: state.scope, continuation: "may_finish" },
    }]);
  }

  private recoverResponse(view: StorageView, apply: Apply, meta: OperationMeta, state: Extract<OperationState, { phase: "assistant_effect_pending" | "summary_effect_pending" }>): void {
    if (view.entry(state.responseEntryId) || view.usageRows().some(row => row.id === state.usageId)) {
      throw new Error(`inconsistent pending response ${state.responseEntryId}`);
    }
    if (state.phase === "summary_effect_pending") {
      for (const id of state.copyIds) {
        if (view.entry(id)) throw new Error(`inconsistent pending response ${id}`);
      }
    }
    const frames = view.items(frameAddress(meta.operationId, state.responseEntryId)).map((item) => item.item as import("@amazme/ai").AssistantFrame);
    const reduced = reduceFrames(frames);
    const content = reduced.content.filter((block) => block.type !== "toolCall");
    const config = this.config(view);
    const message: AssistantMessage = {
      role: "assistant",
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
      api: "recovered",
      provider: config.provider,
      model: config.modelId,
      usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
      stopReason: "aborted",
      errorMessage: "interrupted before settlement",
      timestamp: Date.now(),
    };
    const writes = this.assistantWrites(view, { operationId: meta.operationId, ...state }, message);
    this.finish(view, apply, meta, "aborted", "interrupted before settlement", { writes, tipId: state.responseEntryId });
    this.harness.live.delete(state.responseEntryId);
  }

  private settleSummary(
    view: StorageView,
    apply: Apply,
    planned: Extract<Plan, { type: "summary" }>,
    message: AssistantMessage,
  ): void {
    if (this.harness.isAbandoned) return;
    const state = view.get<OperationState>(stateAddress(planned.operationId));
    const meta = view.get<OperationMeta>(metaAddress(planned.operationId));
    if (!state || !meta || state.phase !== "summary_effect_pending" || state.responseEntryId !== planned.responseEntryId) return;
    const cancel = state.scope.control.status === "cancel_requested" || message.stopReason === "aborted";
    const summary = cancel ? undefined : acceptedSummary(message);
    const usage = message.api === "missing" ? [] : [usageWrite(state.usageId, planned.operationId, message)];
    const reject = (status: OperationResult["status"], error: string) => {
      this.finish(view, apply, meta, status, error, usage.length > 0 ? { writes: usage, tipId: view.get<string | null>(tipAddress(this.name)) ?? null } : undefined);
      this.harness.live.delete(planned.responseEntryId);
    };
    if (cancel || !summary) {
      const aborted = cancel || message.stopReason === "aborted";
      reject(aborted ? "aborted" : "failed", aborted ? (message.errorMessage ?? "cancelled") : summaryRejection(message));
      return;
    }
    const entryId = planned.responseEntryId;
    const timestamp = Date.now();
    const parent = state.boundary === "navigation"
      ? (state.targetId ?? null)
      : (state.summarizedIds[state.summarizedIds.length - 1] ?? null);
    let tipId = entryId;
    const writes: Write[] = [
      { type: "entry", id: entryId, parentId: parent, timestamp, payload: { type: "compaction", summary } },
      ...usage,
    ];
    if (state.boundary !== "navigation") {
      for (let index = 0; index < state.keptIds.length; index++) {
        const sourceId = state.keptIds[index];
        const copyId = state.copyIds[index];
        const source = sourceId ? view.entry(sourceId) : undefined;
        if (!source || !copyId) {
          reject("failed", "compaction tail is missing");
          return;
        }
        writes.push({
          type: "entry",
          id: copyId,
          parentId: tipId,
          timestamp: source.timestamp,
          payload: structuredClone(source.payload),
        });
        tipId = copyId;
      }
    }
    writes.push({ type: "set", address: tipAddress(this.name), value: tipId });
    const config = this.config(view);
    const model = this.harness.options.models.getModel(config.provider, config.modelId);
    const kept = state.keptIds.map((id) => view.entry(id)).filter((entry) => entry?.payload.type === "message").map((entry) => {
      const payload = entry?.payload;
      return payload?.type === "message" && payload.message.role !== "custom" ? payload.message : undefined;
    }).filter((message): message is Exclude<HarnessMessage, { role: "custom" }> => message !== undefined);
    const continued = model
      ? resolveOutputBudget(model, continuationContext(config.systemPrompt, summary, kept, this.toolDefinitions()), config.maxTokens)
      : undefined;
    if (!continued || continued.status !== "ok") {
      reject("failed", continued?.message ?? "context budget cannot fit after compaction");
      return;
    }
    if (state.boundary === "resume") {
      writes.push({ type: "set", address: stateAddress(planned.operationId), value: { phase: "assistant_ready", scope: state.scope } });
      apply(writes);
      this.harness.live.delete(planned.responseEntryId);
      return;
    }
    this.finish(view, apply, meta, "completed", undefined, { writes, tipId });
    this.harness.live.delete(planned.responseEntryId);
  }

  private async runTools(operationId: string, signal: AbortSignal, telemetryContext: DriveSpan): Promise<void> {
    for (let step = 0; step < 32; step++) {
      if (this.harness.isAbandoned) return;
      const action = await admitted(this.harness).run((view, apply) => this.armTools(view, apply, operationId, telemetryContext));
      if (action.type === "done" || this.harness.isAbandoned) return;
      let armed: { type: "done" } | { type: "run"; mode: ToolExecutionMode; calls: ArmedCall[] };
      if (action.type === "run") {
        armed = action;
      } else {
        let decided: ToolDecision[];
        try {
          decided = await this.decideToolCalls(action.batch, signal);
        } catch (error) {
          if (!(error instanceof ApprovalPredicateFailure)) throw error;
          await admitted(this.harness).run((view, apply) => this.failForPredicate(view, apply, operationId, error.message));
          return;
        }
        armed = await this.commitDecidedTools(operationId, action.mode, decided, signal);
      }
      if (armed.type === "done" || this.harness.isAbandoned) return;
      for (const call of armed.calls) this.harness.live.add(call.resultEntryId);
      await this.executeArmed(operationId, armed.mode, armed.calls, signal, telemetryContext);
    }
  }

  /** `beforeToolCall` waits outside the storage chain so cancel can abort this lane. */
  private async decideToolCalls(batch: readonly ToolDecision[], signal: AbortSignal): Promise<ToolDecision[]> {
    const decided: ToolDecision[] = [];
    for (const item of batch) {
      if (this.harness.isAbandoned) return decided;
      if (item.outcome !== undefined || !item.tool) {
        decided.push(item);
        continue;
      }
      if (signal.aborted) {
        decided.push({ ...item, outcome: "cancelled" });
        continue;
      }
      if (item.call.approval?.decision !== "allow") {
        const needs = await this.approvalRequired(item.call, item.args);
        if (this.harness.isAbandoned) return decided;
        if (signal.aborted) {
          decided.push({ ...item, outcome: "cancelled" });
          continue;
        }
        if (needs) {
          decided.push({ ...item, waitApproval: true });
          continue;
        }
      }
      const decision = await walkBefore(this.hookList(), {
        toolCallId: item.call.toolCallId,
        toolName: item.call.name,
        args: item.args,
      }, signal);
      if (decision?.action === "block") {
        decided.push({ ...item, outcome: decision.reason });
        continue;
      }
      if (signal.aborted) {
        decided.push({ ...item, outcome: "cancelled" });
        continue;
      }
      decided.push(item);
    }
    return decided;
  }

  private commitDecidedTools(
    operationId: string,
    mode: ToolExecutionMode,
    decided: readonly ToolDecision[],
    signal: AbortSignal,
  ): Promise<{ type: "done" } | { type: "run"; mode: ToolExecutionMode; calls: ArmedCall[] }> {
    return admitted(this.harness).run((view, apply) => this.commitToolDecisions(view, apply, operationId, mode, decided, signal));
  }

  private armTools(view: StorageView, apply: Apply, operationId: string, telemetryContext: DriveSpan): ToolPrep {
    if (this.harness.isAbandoned) return { type: "done" };
    const state = view.get<OperationState>(stateAddress(operationId));
    if (!state || state.phase !== "tools") return { type: "done" };
    this.materializeTools(view, apply, operationId);
    if (this.harness.isAbandoned) return { type: "done" };
    const refreshed = view.get<OperationState>(stateAddress(operationId));
    if (!refreshed || refreshed.phase !== "tools") return { type: "done" };
    const config = this.config(view);
    const assistant = view.entry(refreshed.responseEntryId);
    const toRun: ArmedCall[] = [];
    let calls = refreshed.calls.map((call) => ({ ...call }));
    const cancel = refreshed.scope.control.status === "cancel_requested";
    const sequential = config.toolExecution === "sequential" || calls.some((call) => this.tool(call.name)?.executionMode === "sequential");
    const recoverable = calls.filter((call) => call.status === "effect_pending" && !this.harness.live.has(call.resultEntryId));
    const recoveryWrites: Write[] = [];
    for (const call of recoverable) {
      if (call.replay === "safe" && !cancel) {
        toRun.push(this.armed(view, operationId, call, assistant));
        telemetryContext.addEvent("amazme.harness.recovered", { effect: "tool", replay: "safe" });
        if (sequential) break;
        continue;
      }
      calls = calls.map((item) => (item.resultEntryId === call.resultEntryId ? { ...item, status: "outcome_ready" as const, terminate: false } : item));
      const checkpoint = view.get<string>(toolOutputAddress(call.resultEntryId));
      const reason = cancel ? "cancelled" : INTERRUPTED_TOOL_EFFECT;
      const text = checkpoint ? `${reason}\n${checkpoint}` : reason;
      recoveryWrites.push({
        type: "set",
        address: pendingAddress(call.resultEntryId),
        value: { type: "message", message: toolMessage(call, text, true, false) },
      });
    }
    if (recoverable.some((call) => call.replay !== "safe" || cancel)) {
      apply([...recoveryWrites, { type: "set", address: stateAddress(operationId), value: { ...refreshed, calls } }]);
      if (this.harness.isAbandoned) return { type: "done" };
      this.materializeTools(view, apply, operationId);
      telemetryContext.addEvent("amazme.harness.recovered", { effect: "tool", ...(cancel ? {} : { replay: "never" as const }) });
      if (toRun.length > 0) return { type: "run", mode: sequential ? "sequential" : "parallel", calls: toRun };
      return { type: "done" };
    }
    if (toRun.length > 0) return { type: "run", mode: sequential ? "sequential" : "parallel", calls: toRun };
    const planned = calls.filter((call) => call.status === "planned");
    const batch = sequential ? planned.slice(0, 1) : planned;
    if (batch.length === 0) return { type: "done" };
    if (!cancel && batch.every((call) => call.approval && !call.approval.decision)) return { type: "done" };
    const decided: ToolDecision[] = [];
    let needsHook = false;
    for (const call of batch) {
      if (call.approval && !call.approval.decision && !cancel) continue;
      const args = call.approval?.arguments ?? readArgs(assistant, call.sourceIndex);
      const tool = this.tool(call.name);
      const invalid = tool ? validateArguments(tool.parameters, args) : `Unknown tool: ${call.name}`;
      if (call.approval?.decision === "deny" && !cancel) {
        decided.push({ call, args, outcome: approvalDenial(call.approval.reason) });
        continue;
      }
      if (cancel || !tool || invalid) {
        decided.push({ call, args, outcome: cancel ? "cancelled" : invalid || "unavailable" });
        continue;
      }
      needsHook = true;
      decided.push({ call, args, tool });
    }
    if (decided.length === 0) return { type: "done" };
    if (needsHook) {
      return { type: "decide", mode: sequential ? "sequential" : "parallel", batch: decided };
    }
    const writes: Write[] = [];
    for (const item of decided) {
      const outcome = item.outcome ?? "unavailable";
      calls = calls.map((entry) => entry.resultEntryId === item.call.resultEntryId ? { ...entry, status: "outcome_ready" as const, terminate: false } : entry);
      writes.push({
        type: "set",
        address: pendingAddress(item.call.resultEntryId),
        value: { type: "message", message: toolMessage(item.call, outcome, true, false) },
      });
    }
    apply([...writes, { type: "set", address: stateAddress(operationId), value: { ...refreshed, calls } }]);
    if (this.harness.isAbandoned) return { type: "done" };
    this.materializeTools(view, apply, operationId);
    return { type: "done" };
  }

  private async executeArmed(
    operationId: string,
    mode: ToolExecutionMode,
    calls: readonly ArmedCall[],
    signal: AbortSignal,
    telemetryContext: DriveSpan,
  ): Promise<void> {
    const execute = async (call: ArmedCall) => {
      try {
        if (this.harness.isAbandoned) return;
        const outcome = await createTypedSpanStarter(telemetryContext, [durableTelemetrySchema])(
          "amazme.tool.execute",
          { tool: call.name, toolCallId: call.toolCallId },
          async (span) => {
            const outcome = await this.executeTool(call, signal, span);
            if (outcome.result.isError || signal.aborted) span.setStatus({ status: "error" });
            return outcome;
          });
        if (this.harness.isAbandoned) return;
        let result = outcome.result;
        if (outcome.executed) {
          const update = await walkAfter(this.hookList(), {
            toolCallId: call.toolCallId,
            toolName: call.name,
            args: call.args,
            result,
          }, signal);
          result = applyAfter(result, update);
        }
        if (this.harness.isAbandoned) return;
        await admitted(this.harness).run((view, apply) => this.stageTool(view, apply, operationId, call, result));
      } finally {
        this.harness.live.delete(call.resultEntryId);
      }
    };
    if (mode === "sequential") {
      const call = calls[0];
      if (call) await execute(call);
      return;
    }
    await settleAll(calls.map((call) => execute(call)));
  }

  private commitToolDecisions(
    view: StorageView,
    apply: Apply,
    operationId: string,
    mode: ToolExecutionMode,
    decided: readonly ToolDecision[],
    signal: AbortSignal,
  ): { type: "done" } | { type: "run"; mode: ToolExecutionMode; calls: ArmedCall[] } {
    if (this.harness.isAbandoned) return { type: "done" };
    const state = view.get<OperationState>(stateAddress(operationId));
    if (!state || state.phase !== "tools") return { type: "done" };
    const cancel = state.scope.control.status === "cancel_requested" || signal.aborted;
    let calls = state.calls.map((call) => ({ ...call }));
    const toRun: ArmedCall[] = [];
    const writes: Write[] = [];
    for (const item of decided) {
      const current = calls.find((entry) => entry.resultEntryId === item.call.resultEntryId);
      if (!current || current.status !== "planned") continue;
      if (item.waitApproval) {
        if (current.approval) continue;
        calls = calls.map((entry) => entry.resultEntryId === item.call.resultEntryId ? {
          ...entry,
          approval: { arguments: cloneArgs(item.args), requestedAt: Date.now() },
        } : entry);
        continue;
      }
      const outcome = item.outcome !== undefined ? item.outcome : (cancel ? "cancelled" : undefined);
      if (outcome !== undefined) {
        calls = calls.map((entry) => entry.resultEntryId === item.call.resultEntryId ? { ...entry, status: "outcome_ready" as const, terminate: false } : entry);
        writes.push({
          type: "set",
          address: pendingAddress(item.call.resultEntryId),
          value: { type: "message", message: toolMessage(item.call, outcome, true, false) },
        });
        continue;
      }
      const tool = item.tool;
      if (!tool) continue;
      calls = calls.map((entry) =>
        entry.resultEntryId === item.call.resultEntryId
          ? { ...entry, status: "effect_pending" as const, replay: tool.replay ?? "never" }
          : entry,
      );
      writes.push({ type: "set", address: toolArgsAddress(operationId, item.call.resultEntryId), value: item.args });
      toRun.push({ ...item.call, operationId, args: item.args, replay: tool.replay ?? "never" });
    }
    apply([...writes, { type: "set", address: stateAddress(operationId), value: { ...state, calls } }]);
    if (this.harness.isAbandoned) return { type: "done" };
    this.materializeTools(view, apply, operationId);
    if (toRun.length === 0) return { type: "done" };
    return { type: "run", mode, calls: toRun };
  }

  private async executeTool(call: ArmedCall, signal: AbortSignal, telemetryContext: TelemetryContext): Promise<{ result: ToolResult; executed: boolean }> {
    if (signal.aborted) return { result: { content: [{ type: "text", text: "cancelled" }], isError: true }, executed: false };
    const tool = this.tool(call.name);
    if (!tool) return { result: { content: [{ type: "text", text: `Unknown tool: ${call.name}` }], isError: true }, executed: false };
    const writes: Promise<void>[] = [];
    let accepting = true;
    let lastCheckpointAt = 0;
    let pendingPartial: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const persistCheckpoint = (partial: string): void => {
      const pending = Promise.resolve()
        .then(() => admitted(this.harness).run((view, apply) => {
          if (this.harness.isAbandoned) return;
          const state = view.get<OperationState>(stateAddress(call.operationId));
          if (state?.phase !== "tools") return;
          const current = state.calls.find((item) => item.resultEntryId === call.resultEntryId);
          if (current?.status !== "effect_pending") return;
          apply([{ type: "set", address: toolOutputAddress(call.resultEntryId), value: checkpointTail(partial) }]);
        }))
        .then(() => undefined);
      writes.push(pending);
      void pending.catch(() => undefined);
    };
    const flushPending = (): void => {
      timer = undefined;
      if (!accepting || pendingPartial === undefined) return;
      const partial = pendingPartial;
      pendingPartial = undefined;
      lastCheckpointAt = Date.now();
      persistCheckpoint(partial);
    };
    // A tool may checkpoint every chunk. One storage write per window keeps the tail, and the latest partial in that window is the one that lands.
    const accept = (partial: string, options?: { checkpoint?: boolean }): void => {
      if (!accepting || !options?.checkpoint) return;
      const now = Date.now();
      if (lastCheckpointAt !== 0 && now - lastCheckpointAt < CHECKPOINT_INTERVAL_MS) {
        pendingPartial = partial;
        if (timer === undefined) {
          timer = setTimeout(flushPending, CHECKPOINT_INTERVAL_MS - (now - lastCheckpointAt));
        }
        return;
      }
      pendingPartial = undefined;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      lastCheckpointAt = now;
      persistCheckpoint(partial);
    };
    let result: ToolResult;
    let executed = false;
    try {
      result = await tool.execute(call.args, { signal, telemetryContext, onUpdate: accept });
      executed = true;
    } catch (error) {
      result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    } finally {
      accepting = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      pendingPartial = undefined;
    }
    await settleAll(writes);
    return { result, executed };
  }

  private stageTool(view: StorageView, apply: Apply, operationId: string, call: ArmedCall, result: ToolResult): void {
    if (this.harness.isAbandoned) return;
    const state = view.get<OperationState>(stateAddress(operationId));
    if (!state || state.phase !== "tools") return;
    const current = state.calls.find((item) => item.resultEntryId === call.resultEntryId);
    if (!current || current.status !== "effect_pending") return;
    const calls = state.calls.map((item) =>
      item.resultEntryId === call.resultEntryId
        ? { ...item, status: "outcome_ready" as const, terminate: result.terminate === true }
        : item,
    );
    apply([
      {
        type: "set",
        address: pendingAddress(call.resultEntryId),
        value: {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: call.toolCallId,
            toolName: call.name,
            content: result.content,
            isError: result.isError === true,
            timestamp: Date.now(),
          },
        },
      },
      { type: "delete", address: toolOutputAddress(call.resultEntryId) },
      { type: "delete", address: toolArgsAddress(operationId, call.resultEntryId) },
      { type: "set", address: stateAddress(operationId), value: { ...state, calls } },
    ]);
    this.materializeTools(view, apply, operationId);
  }

  private materializeTools(view: StorageView, apply: Apply, operationId: string): void {
    const state = view.get<OperationState>(stateAddress(operationId));
    if (!state || state.phase !== "tools") return;
    const calls = state.calls.map((call) => ({ ...call }));
    let parent = [...calls].reverse().find((call) => call.status === "completed")?.resultEntryId ?? state.responseEntryId;
    const writes: Write[] = [];
    for (const call of calls) {
      if (call.status === "completed") continue;
      if (call.status !== "outcome_ready") break;
      const payload = view.get<import("./storage.ts").EntryPayload>(pendingAddress(call.resultEntryId));
      if (!payload) break;
      writes.push({ type: "entry", id: call.resultEntryId, parentId: parent, timestamp: Date.now(), payload });
      writes.push({ type: "delete", address: pendingAddress(call.resultEntryId) });
      writes.push({ type: "delete", address: toolOutputAddress(call.resultEntryId) });
      writes.push({ type: "delete", address: toolArgsAddress(operationId, call.resultEntryId) });
      call.status = "completed";
      parent = call.resultEntryId;
    }
    if (writes.length === 0) return;
    const allDone = calls.every((call) => call.status === "completed");
    const terminate = allDone && calls.every((call) => call.terminate === true);
    writes.push({ type: "set", address: tipAddress(this.name), value: parent });
    writes.push({
      type: "set",
      address: stateAddress(operationId),
      value: allDone
        ? { phase: "checkpoint", scope: state.scope, continuation: terminate ? "may_finish" : "need_assistant" }
        : { ...state, calls },
    });
    apply(writes);
  }

  private assistantWrites(
    view: StorageView,
    planned: { operationId: string; responseEntryId: string; usageId: string },
    message: AssistantMessage,
  ): Write[] {
    const clearFrames: Write = { type: "deleteList", address: frameAddress(planned.operationId, planned.responseEntryId) };
    const tip = view.get<string | null>(tipAddress(this.name)) ?? null;
    return [
      {
        type: "entry",
        id: planned.responseEntryId,
        parentId: tip,
        timestamp: message.timestamp,
        payload: { type: "message", message },
      },
      usageWrite(planned.usageId, planned.operationId, message),
      { type: "set", address: tipAddress(this.name), value: planned.responseEntryId },
      clearFrames,
    ];
  }

  private finish(
    view: StorageView,
    apply: Apply,
    meta: OperationMeta,
    status: OperationResult["status"],
    error?: string,
    settlement?: { writes: Write[]; tipId: string | null },
  ): OperationResult {
    const tipId = settlement ? settlement.tipId : (view.get<string | null>(tipAddress(this.name)) ?? null);
    const result: OperationResult = {
      operationId: meta.operationId,
      lane: meta.lane,
      kind: meta.intent.kind,
      status,
      fromTipId: meta.sourceTipId,
      tipId,
      startedAt: meta.startedAt,
      endedAt: Date.now(),
      ...(error ? { error } : {}),
    };
    const record = this.record(view);
    apply([
      ...(settlement?.writes ?? []),
      { type: "delete", address: metaAddress(meta.operationId) },
      { type: "delete", address: stateAddress(meta.operationId) },
      { type: "set", address: resultAddress(meta.operationId), value: result },
      {
        type: "set",
        address: laneAddress(this.name),
        value: { ...record, currentOperationId: null, lastOperationId: meta.operationId },
      },
    ]);
    return result;
  }

  /**
   * Writes the yielded user message, or finishes when there is nothing to append.
   * `walkYield` has already returned; a throw from that hook never reaches this method.
   */
  private applyYield(view: StorageView, apply: Apply, operationId: string, text: string | undefined, signal: AbortSignal): Plan {
    if (this.harness.isAbandoned) return { type: "continue" };
    const record = this.record(view);
    const state = view.get<OperationState>(stateAddress(operationId));
    const meta = view.get<OperationMeta>(metaAddress(operationId));
    if (!state || !meta || record.currentOperationId !== operationId || state.phase !== "checkpoint") {
      return { type: "continue" };
    }
    if (signal.aborted || state.scope.control.status === "cancel_requested") {
      return { type: "settled", result: this.finish(view, apply, meta, "aborted", "cancelled") };
    }
    const placed = this.placeInbox(view, apply, record, true, state.continuation === "may_finish");
    if (placed.moved) {
      apply([{ type: "set", address: laneAddress(this.name), value: { ...placed.record, currentOperationId: operationId } }]);
      return this.beginModelRequest(view, apply, meta, state.scope);
    }
    if (state.continuation !== "may_finish" || !this.modelStoppedWithoutTools(view)) {
      if (state.continuation === "need_assistant") return this.beginModelRequest(view, apply, meta, state.scope);
      return { type: "settled", result: this.finish(view, apply, meta, "completed") };
    }
    const yielded = typeof text === "string" && text.trim() !== "" ? text : undefined;
    if (yielded === undefined) return { type: "settled", result: this.finish(view, apply, meta, "completed") };
    const entryId = uuidv7();
    const message = user(yielded);
    return this.beginModelRequest(view, apply, meta, state.scope, {
      tipId: entryId,
      message,
      writes: [
        {
          type: "entry",
          id: entryId,
          parentId: placed.tipId,
          timestamp: message.timestamp,
          payload: { type: "message", message },
        },
        { type: "set", address: tipAddress(this.name), value: entryId },
      ],
    });
  }

  /** True when the settled tip is an assistant message that did not call tools. Terminate leaves a tool result. */
  private modelStoppedWithoutTools(view: StorageView): boolean {
    const tipId = view.get<string | null>(tipAddress(this.name)) ?? null;
    if (!tipId) return false;
    const entry = view.entry(tipId);
    if (!entry || entry.payload.type !== "message") return false;
    const message = entry.payload.message;
    if (message.role !== "assistant") return false;
    return !message.content.some((block) => block.type === "toolCall");
  }

  private placeInbox(
    view: StorageView,
    apply: Apply,
    record: LaneRecord,
    allowSteer: boolean,
    includeFollow: boolean,
  ): { record: LaneRecord; tipId: string | null; moved: boolean } {
    const config = this.config(view);
    let steerTaken = 0;
    let followTaken = 0;
    const selected: InboxItem[] = [];
    const rest: InboxItem[] = [];
    for (const item of record.inbox) {
      if (item.kind === "write") {
        selected.push(item);
      } else if (item.kind === "steer" && allowSteer && (config.steeringMode === "all" || steerTaken === 0)) {
        selected.push(item);
        steerTaken += 1;
      } else if (item.kind === "followUp" && includeFollow && steerTaken === 0 && (config.followUpMode === "all" || followTaken === 0)) {
        selected.push(item);
        followTaken += 1;
      } else {
        rest.push(item);
      }
    }
    let tipId = view.get<string | null>(tipAddress(this.name)) ?? null;
    if (selected.length === 0) return { record: { ...record, inbox: rest }, tipId, moved: false };
    const writes: Write[] = [];
    for (const item of selected) {
      const payload = view.get<import("./storage.ts").EntryPayload>(pendingAddress(item.entryId));
      if (!payload) continue;
      writes.push({ type: "entry", id: item.entryId, parentId: tipId, timestamp: Date.now(), payload });
      writes.push({ type: "delete", address: pendingAddress(item.entryId) });
      tipId = item.entryId;
    }
    writes.push({ type: "set", address: tipAddress(this.name), value: tipId });
    const next = { ...record, inbox: rest };
    writes.push({ type: "set", address: laneAddress(this.name), value: next });
    apply(writes);
    return { record: next, tipId, moved: true };
  }

  private providerContext(view: StorageView, pending?: HarnessMessage): Context {
    const config = this.config(view);
    const messages = this.visibleEntries(view).map((entry) => entry.kind === "compaction"
      ? { role: "user" as const, content: entry.summary, timestamp: entry.timestamp }
      : projectForRequest(entry.message, config.toolResultLimit));
    if (pending && pending.role !== "custom") messages.push(pending);
    return {
      systemPrompt: config.systemPrompt,
      messages,
      tools: this.toolDefinitions(),
    };
  }

  private visibleEntries(view: StorageView): TranscriptEntry[] {
    const tip = view.get<string | null>(tipAddress(this.name)) ?? null;
    return visibleFrom(ancestors(view, tip));
  }

  private toolDefinitions() {
    return (this.harness.options.tools ?? []).map(toolDefinition);
  }

  private requestBudget(view: StorageView) {
    const config = this.config(view);
    const model = this.harness.options.models.getModel(config.provider, config.modelId);
    if (!model) return undefined;
    return resolveOutputBudget(model, this.providerContext(view), config.maxTokens);
  }

  /**
   * Place the next model call, or a compaction.
   * `carried` is the yielded user entry. It is judged with the following phase and committed in that same apply.
   */
  private beginModelRequest(
    view: StorageView,
    apply: Apply,
    meta: OperationMeta,
    scope: Scope,
    carried?: { writes: Write[]; tipId: string; message: HarnessMessage },
  ): Plan {
    const decision = this.assess(view, scope, carried?.message);
    const prefix = carried?.writes ?? [];
    if (decision.type === "fail") {
      return {
        type: "settled",
        result: this.finish(
          view,
          apply,
          meta,
          "failed",
          decision.message,
          carried ? { writes: prefix, tipId: carried.tipId } : undefined,
        ),
      };
    }
    const nextScope: Scope = decision.type === "compact"
      ? {
          ...scope,
          thresholdUsed: decision.reason === "threshold" ? true : scope.thresholdUsed,
          overflowUsed: decision.reason === "overflow" ? true : scope.overflowUsed,
        }
      : scope;
    const phase: Write = decision.type === "compact"
      ? {
          type: "set",
          address: stateAddress(meta.operationId),
          value: { phase: "summary_deciding", scope: nextScope, reason: decision.reason, boundary: "resume" },
        }
      : { type: "set", address: stateAddress(meta.operationId), value: { phase: "assistant_ready", scope } };
    apply([...prefix, phase]);
    return { type: "continue" };
  }

  private assess(
    view: StorageView,
    scope: Scope,
    pending?: HarnessMessage,
  ): { type: "send" } | { type: "compact"; reason: SummaryReason } | { type: "fail"; message: string } {
    const config = this.config(view);
    const resolved = resolveLaneModel(view, this.name, this.harness.options);
    const model = resolved.model;
    if (!model) return { type: "fail", message: `Unknown model ${resolved.provider}/${resolved.modelId}` };
    if (resolved.compaction.enabled && (!Number.isSafeInteger(resolved.compaction.maxTokens) || resolved.compaction.maxTokens <= 0)) {
      return { type: "fail", message: "compaction.maxTokens must be a positive integer" };
    }
    const budget = resolveOutputBudget(model, this.providerContext(view, pending), config.maxTokens);
    if (budget.status === "invalid_limit" || budget.status === "unserializable") {
      return { type: "fail", message: budget.message ?? "Context budget is invalid" };
    }
    if (budget.status === "cannot_fit") {
      if (!resolved.compaction.enabled) return { type: "fail", message: `${budget.message}; compaction is disabled` };
      if (scope.overflowUsed) return { type: "fail", message: "context overflow repeated" };
      return { type: "compact", reason: "overflow" };
    }
    // assess compares an estimate of the next request, so contextTokens against this threshold is only approximate.
    const threshold = effectiveInputThreshold(model.contextWindow, resolved.compaction.maxTokens);
    if (resolved.compaction.enabled && !scope.thresholdUsed && budget.estimatedInput > threshold) {
      return { type: "compact", reason: "threshold" };
    }
    return { type: "send" };
  }

  private prepareCompaction(view: StorageView, state: Extract<OperationState, { phase: "summary_deciding" }>) {
    const config = this.config(view);
    const resolved = resolveLaneModel(view, this.name, this.harness.options);
    const model = resolved.model;
    if (!model) return { ok: false as const, code: "invalid" as const, message: `Unknown model ${resolved.provider}/${resolved.modelId}` };
    if (resolved.compaction.enabled && (!Number.isSafeInteger(resolved.compaction.maxTokens) || resolved.compaction.maxTokens <= 0)) {
      return { ok: false as const, code: "invalid" as const, message: "compaction.maxTokens must be a positive integer" };
    }
    const threshold = effectiveInputThreshold(model.contextWindow, resolved.compaction.maxTokens);
    return planCompaction({
      entries: this.visibleEntries(view),
      systemPrompt: config.systemPrompt,
      tools: this.toolDefinitions(),
      model,
      ...(config.maxTokens !== undefined ? { requestedOutput: config.maxTokens } : {}),
      boundary: state.boundary,
      keepTokens: keepRecentBudget(model.contextWindow, threshold),
    });
  }

  private summaryRequest(view: StorageView, state: Extract<OperationState, { phase: "summary_effect_pending" }>) {
    const config = this.config(view);
    const model = this.harness.options.models.getModel(config.provider, config.modelId);
    if (!model) return undefined;
    const entries: TranscriptEntry[] = [];
    for (const id of state.summarizedIds) {
      const entry = view.entry(id);
      if (!entry) return { ok: false as const, message: "summary plan is missing" };
      if (entry.payload.type === "compaction") {
        entries.push({ id: entry.id, timestamp: entry.timestamp, kind: "compaction", summary: entry.payload.summary });
        continue;
      }
      if (entry.payload.message.role === "custom") continue;
      entries.push({ id: entry.id, timestamp: entry.timestamp, kind: "message", message: entry.payload.message });
    }
    return fitSummaryRequest(model, config.systemPrompt, entries, state.summaryMaxTokens);
  }

  private ensureConfig(view: StorageView, apply: Apply): void {
    stampSession(view, apply);
    this.ensureLane(view, apply, this.name);
  }

  private ensureLane(view: StorageView, apply: Apply, name: string): void {
    if (!view.get(configAddress(name))) {
      const options = this.harness.options;
      const limit = options.toolResultLimit ?? DEFAULT_TOOL_RESULT_LIMIT;
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("toolResultLimit must be a positive integer");
      const config: LaneConfig = {
        provider: options.model.provider,
        modelId: options.model.modelId,
        thinkingLevel: options.thinkingLevel ?? "off",
        steeringMode: options.steeringMode ?? "one-at-a-time",
        followUpMode: options.followUpMode ?? "one-at-a-time",
        toolExecution: options.toolExecution ?? "parallel",
        compaction: options.compaction ?? { enabled: false, maxTokens: 80_000 },
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        maxAttempts: options.maxAttempts ?? 2,
        ...resolveRequestPolicy(options),
        toolResultLimit: limit,
        systemPrompt: options.systemPrompt ?? "",
      };
      apply([{ type: "set", address: configAddress(name), value: config }]);
    }
    if (!view.get(laneAddress(name))) {
      apply([{
        type: "set",
        address: laneAddress(name),
        value: { currentOperationId: null, lastOperationId: null, inbox: [] } satisfies LaneRecord,
      }]);
    }
    if (view.get<string | null>(tipAddress(name)) === undefined) {
      apply([{ type: "set", address: tipAddress(name), value: null }]);
    }
  }

  private writeOperation(apply: Apply, record: LaneRecord, meta: OperationMeta, state: OperationState): void {
    apply([
      { type: "set", address: metaAddress(meta.operationId), value: meta },
      { type: "set", address: stateAddress(meta.operationId), value: state },
      { type: "set", address: laneAddress(this.name), value: { ...record, currentOperationId: meta.operationId } },
    ]);
  }

  private record(view: StorageView): LaneRecord {
    return (
      view.get<LaneRecord>(laneAddress(this.name)) ?? {
        currentOperationId: null,
        lastOperationId: null,
        inbox: [],
      }
    );
  }

  private config(view: StorageView): LaneConfig {
    const config = view.get<LaneConfig>(configAddress(this.name));
    if (!config) throw new Error("lane config is missing");
    const policy = storedRequestPolicy(config);
    if (!Number.isSafeInteger(config.toolResultLimit) || config.toolResultLimit <= 0) {
      throw new Error("lane config has no tool result limit");
    }
    return { ...config, ...policy };
  }

  private deadline(timeoutMs: number, parent: AbortSignal): RequestDeadline {
    const arm = this.harness.options.armDeadline ?? armRequestDeadline;
    return arm(timeoutMs, parent);
  }

  private tool(name: string): HarnessTool | undefined {
    return (this.harness.options.tools ?? []).find((tool) => tool.name === name);
  }

  private async approvalRequired(call: { toolCallId: string; name: string }, args: unknown): Promise<boolean> {
    if (sessionAllowed(this.harness).has(call.name)) return false;
    const predicate = this.harness.options.requiresApproval;
    if (!predicate) return false;
    try {
      return await predicate({ toolCallId: call.toolCallId, name: call.name, arguments: args }) === true;
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() : String(error).trim();
      throw new ApprovalPredicateFailure(message || "approval predicate failed");
    }
  }

  /** Settle the open operation. A thrown predicate must not leave the lane parked or reject `drive`. */
  private failForPredicate(view: StorageView, apply: Apply, operationId: string, message: string): void {
    if (this.harness.isAbandoned) return;
    if (this.record(view).currentOperationId !== operationId) return;
    const meta = view.get<OperationMeta>(metaAddress(operationId));
    if (!meta || meta.lane !== this.name) return;
    this.finish(view, apply, meta, "failed", message);
  }

  /**
   * Persist the decision on the parked call before the tool runs or the denial is written.
   * A later drive, including one after a crash, acts on that record once.
   */
  private stageApproval(
    view: StorageView,
    apply: Apply,
    toolCallId: string,
    decision: "allow" | "deny",
    reason: string | undefined,
  ): { action: "drive"; operationId: string } | { action: "unknown" } | { action: "settled" } {
    const operationId = this.record(view).currentOperationId;
    const state = operationId ? view.get<OperationState>(stateAddress(operationId)) : undefined;
    if (operationId && state?.phase === "tools") {
      const call = state.calls.find((item) => item.toolCallId === toolCallId && item.approval);
      const approval = call?.approval;
      if (call && approval && !approval.decision && call.status === "planned") {
        const trimmed = reason?.trim();
        const calls = state.calls.map((item) => item.resultEntryId !== call.resultEntryId ? item : {
          ...item,
          approval: {
            arguments: approval.arguments,
            requestedAt: approval.requestedAt,
            decision,
            ...(trimmed ? { reason: trimmed } : {}),
          },
        });
        apply([{ type: "set", address: stateAddress(operationId), value: { ...state, calls } }]);
        return { action: "drive", operationId };
      }
      if (approval?.decision && call?.status === "planned") return { action: "drive", operationId };
      if (approval) return { action: "settled" };
    }
    if (storedToolResult(view, this.name, toolCallId)) return { action: "settled" };
    return { action: "unknown" };
  }

  private hookList(): readonly AgentHook[] {
    return this.harness.options.hooks ?? [];
  }

  private armed(view: StorageView, operationId: string, call: ToolCallState, assistant: Entry | undefined): ArmedCall {
    const stored = view.get<unknown>(toolArgsAddress(operationId, call.resultEntryId));
    return {
      ...call,
      operationId,
      args: stored ?? readArgs(assistant, call.sourceIndex),
      replay: call.replay ?? "never",
    };
  }

  private async settledOrWait(operationId: string): Promise<Result<DriveOutcome>> {
    const result = await admitted(this.harness).read((view) => view.get<OperationResult>(resultAddress(operationId)));
    if (!result) return { ok: true, value: { kind: "waiting", operationId, reason: "retry", notBefore: Date.now() } };
    if (result.lane !== this.name) return failure("operation_mismatch", "result does not belong to this lane");
    return { ok: true, value: { kind: "settled", result } };
  }
}

interface ArmedCall extends ToolCallState {
  operationId: string;
  args: unknown;
  replay: ReplayPolicy;
}

type ToolPrep =
  | { type: "done" }
  | { type: "run"; mode: ToolExecutionMode; calls: ArmedCall[] }
  | { type: "decide"; mode: ToolExecutionMode; batch: ToolDecision[] };

interface ToolDecision {
  call: ToolCallState;
  args: unknown;
  outcome?: string;
  tool?: HarnessTool;
  waitApproval?: boolean;
}

function user(text: string): HarnessMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function importedAssistant(config: { provider: string; modelId: string }, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "import",
    provider: config.provider,
    model: config.modelId,
    usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

class ApprovalPredicateFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalPredicateFailure";
  }
}

function earliestApprovalRequestedAt(state: Extract<OperationState, { phase: "tools" }>): number {
  let earliest: number | undefined;
  for (const call of state.calls) {
    if (call.status !== "planned" || !call.approval || call.approval.decision !== undefined) continue;
    const at = call.approval.requestedAt;
    if (earliest === undefined || at < earliest) earliest = at;
  }
  if (earliest === undefined) throw new Error("approval wait has no requestedAt");
  return earliest;
}

/**
 * Result text when a `replay: "never"` tool is still `effect_pending` after restart.
 * The call is not run again: the effect may already have happened, and its result was not stored.
 * A stored checkpoint is appended on the next line.
 */
const INTERRUPTED_TOOL_EFFECT =
  "interrupted before settlement; the tool may already have executed and the result is unknown";

function approvalDenial(reason: string | undefined): string {
  const text = reason?.trim();
  return text ? text : "Tool call denied";
}

function cloneArgs(args: unknown): unknown {
  return args === undefined ? {} : structuredClone(args);
}

function storedToolResult(view: StorageView, lane: string, toolCallId: string): boolean {
  const tip = view.get<string | null>(tipAddress(lane)) ?? null;
  return ancestors(view, tip).some((entry) => {
    if (entry.payload.type !== "message") return false;
    const message = entry.payload.message;
    return message.role === "toolResult" && message.toolCallId === toolCallId;
  });
}

/** True when the next call that is not already settled is parked with no decision. */
function blockedOnApproval(state: Extract<OperationState, { phase: "tools" }>): boolean {
  for (const call of state.calls) {
    if (call.status === "completed" || call.status === "outcome_ready") continue;
    return call.status === "planned" && call.approval !== undefined && call.approval.decision === undefined;
  }
  return false;
}

function toolMessage(call: { toolCallId: string; name: string }, text: string, isError: boolean, _terminate: boolean) {
  return {
    role: "toolResult" as const,
    toolCallId: call.toolCallId,
    toolName: call.name,
    content: [{ type: "text" as const, text }],
    isError,
    timestamp: Date.now(),
  };
}

function readArgs(entry: Entry | undefined, sourceIndex: number): unknown {
  if (!entry || entry.payload.type !== "message" || entry.payload.message.role !== "assistant") return {};
  const block = entry.payload.message.content[sourceIndex];
  return block?.type === "toolCall" ? block.arguments : {};
}

const OUTPUT_TAIL_LIMIT = 4_000;
const CHECKPOINT_INTERVAL_MS = 1_000;

function toolActivity(view: StorageView, state: OperationState | undefined): ToolActivity[] {
  if (!state || state.phase !== "tools") return [];
  return state.calls.map((call) => {
    const activity: ToolActivity = {
      toolCallId: call.toolCallId,
      name: call.name,
      status: call.status === "planned" ? "planned" : call.status === "effect_pending" ? "running" : "settled",
    };
    const outputTail = storedOutputTail(view, call);
    if (outputTail !== undefined) activity.outputTail = outputTail;
    return activity;
  });
}

function toolOutputTails(view: StorageView, state: OperationState | undefined): ToolOutputView["tails"] {
  if (!state || state.phase !== "tools") return [];
  const tails: ToolOutputView["tails"] = [];
  for (const call of state.calls) {
    const outputTail = storedOutputTail(view, call);
    if (outputTail === undefined) continue;
    tails.push({ toolCallId: call.toolCallId, outputTail });
  }
  return tails;
}

function storedOutputTail(view: StorageView, call: { status: string; resultEntryId: string }): string | undefined {
  if (call.status !== "effect_pending") return undefined;
  const partial = view.get<string>(toolOutputAddress(call.resultEntryId));
  if (typeof partial !== "string") return undefined;
  return checkpointTail(partial);
}

function visibleFrom(chain: readonly Entry[]): TranscriptEntry[] {
  let start = 0;
  for (let index = chain.length - 1; index >= 0; index--) {
    if (chain[index]?.payload.type === "compaction") {
      start = index;
      break;
    }
  }
  const entries: TranscriptEntry[] = [];
  for (const entry of chain.slice(start)) {
    if (entry.payload.type === "compaction") {
      entries.push({ id: entry.id, timestamp: entry.timestamp, kind: "compaction", summary: entry.payload.summary });
      continue;
    }
    const message = entry.payload.message;
    if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "deferred")) continue;
    if (message.role === "custom") continue;
    entries.push({ id: entry.id, timestamp: entry.timestamp, kind: "message", message });
  }
  return entries;
}

function projectUsage(view: StorageView, lane: string, chain: readonly Entry[], options: HarnessOptions): LaneUsage {
  const counted = entriesAfterSummary(chain);
  return {
    lastTurn: lastTurnUsage(view, counted, options),
    total: attributedTotal(view, lane, options),
    contextTokens: contextTokenCount(counted),
    compactionThreshold: compactionThreshold(view, lane, options),
  };
}

/** Full prompt length. An omitted cache count is left out of the sum. */
function promptSize(usage: Usage): number {
  return usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function lastTurnUsage(view: StorageView, chain: readonly Entry[], options: HarnessOptions): LaneUsage["lastTurn"] {
  for (let index = chain.length - 1; index >= 0; index--) {
    const entry = chain[index];
    if (!entry || entry.payload.type !== "message") continue;
    const message = entry.payload.message;
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "deferred") continue;
    // At settlement the entry is written first, then the usage row on the next seq; pairing depends on that order.
    const row = view.usageRows().find((candidate) => candidate.seq === entry.seq + 1);
    if (!row) return null;
    const cacheRead = typeof row.cacheRead === "number" ? row.cacheRead : null;
    const cacheWrite = typeof row.cacheWrite === "number" ? row.cacheWrite : null;
    const reasoning = typeof row.reasoning === "number" ? row.reasoning : null;
    return {
      input: row.input,
      output: row.output,
      cacheRead,
      cacheWrite,
      reasoning,
      hitRate: cacheHitRate({
        input: row.input,
        ...(cacheRead !== null ? { cacheRead } : {}),
        ...(cacheWrite !== null ? { cacheWrite } : {}),
      }),
      // An unquoted row is an all-null `LaneUsageCost`. `UsageCost` cannot type those null charges.
      cost: rowCost(options, row) as UsageCost | null,
    };
  }
  return null;
}

function contextTokenCount(chain: readonly Entry[]): number | null {
  const visible = visibleFrom(chain);
  for (let index = visible.length - 1; index >= 0; index--) {
    const entry = visible[index];
    if (entry?.kind === "message" && entry.message.role === "assistant") {
      return promptSize(entry.message.usage) + entry.message.usage.output;
    }
  }
  return null;
}

/**
 * Entries that count after the newest summary.
 * A finish compaction writes the summary and the kept-tail copies in one commit. The copies sit directly after
 * the summary and keep the source timestamp, which is strictly earlier than the summary's own timestamp.
 * Skip that contiguous run. Count from the first entry that is not strictly earlier. With no summary, the whole chain counts.
 */
function entriesAfterSummary(chain: readonly Entry[]): Entry[] {
  let summaryIndex = -1;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (chain[index]?.payload.type === "compaction") {
      summaryIndex = index;
      break;
    }
  }
  if (summaryIndex < 0) return [...chain];
  const summary = chain[summaryIndex];
  if (!summary) return [...chain];
  let start = summaryIndex + 1;
  while (start < chain.length) {
    const entry = chain[start];
    if (!entry || entry.timestamp >= summary.timestamp) break;
    start += 1;
  }
  return chain.slice(start);
}

function attributedTotal(view: StorageView, lane: string, options: HarnessOptions): LaneUsage["total"] {
  const rows = view.usageRows().filter((row) => operationLane(view, row.operationId) === lane);
  let input = 0;
  let output = 0;
  for (const row of rows) {
    input += row.input;
    output += row.output;
  }
  const cacheRead = sumStoredCount(rows, "cacheRead");
  const cacheWrite = sumStoredCount(rows, "cacheWrite");
  const reasoning = sumStoredCount(rows, "reasoning");
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    hitRate: cacheRead === null ? null : cacheHitRate({
      input,
      cacheRead,
      ...(cacheWrite === null ? {} : { cacheWrite }),
    }),
    cost: totalCost(options, rows),
  };
}

/** Sum a stored count. Null when there are no rows, or any row left the field out or stored null. A reported 0 stays 0. */
function sumStoredCount(rows: readonly UsageRow[], key: "cacheRead" | "cacheWrite" | "reasoning"): number | null {
  if (rows.length === 0) return null;
  let sum = 0;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "number") return null;
    sum += value;
  }
  return sum;
}

function totalCost(options: HarnessOptions, rows: readonly UsageRow[]): LaneUsageCost | null {
  if (rows.length === 0) return null;
  const parts: LaneUsageCost[] = [];
  for (const row of rows) {
    const priced = rowCost(options, row);
    if (!priced) return null;
    parts.push(priced);
  }
  return {
    input: sumCharge(parts, "input"),
    output: sumCharge(parts, "output"),
    cacheRead: sumCharge(parts, "cacheRead"),
    cacheWrite: sumCharge(parts, "cacheWrite"),
    total: sumCharge(parts, "total"),
  };
}

function sumCharge(parts: readonly LaneUsageCost[], key: keyof UsageCost): number | null {
  let sum = 0;
  for (const part of parts) {
    const value = part[key];
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

function rowCost(options: HarnessOptions, row: UsageRow): LaneUsageCost | null {
  if (row.cost?.total === null) return { input: null, output: null, cacheRead: null, cacheWrite: null, total: null };
  if (!row.model) return null;
  const model = options.models.getModel(row.model.provider, row.model.modelId);
  if (!model) return null;
  return usageCost(model, {
    input: row.input,
    output: row.output,
    ...(typeof row.cacheRead === "number" ? { cacheRead: row.cacheRead } : {}),
    ...(typeof row.cacheWrite === "number" ? { cacheWrite: row.cacheWrite } : {}),
  });
}

/**
 * Start of the open turn. A turn is one persisted run operation: tools, retries, approval waits,
 * and auto-compaction stay on that operation, so its `startedAt` does not move.
 * Compaction and navigation operations are not turns. Null when nothing is running.
 */
function turnStartedAt(view: StorageView, lane: string): number | null {
  const operationId = view.get<LaneRecord>(laneAddress(lane))?.currentOperationId ?? null;
  if (!operationId) return null;
  const meta = view.get<OperationMeta>(metaAddress(operationId));
  if (!meta || meta.lane !== lane || meta.intent.kind !== "run") return null;
  return meta.startedAt;
}

/** Error text on the newest assistant. The retry wait is written in the same commit as that message. */
function retryErrorText(view: StorageView, lane: string): string | null {
  const tip = view.get<string | null>(tipAddress(lane)) ?? null;
  const chain = ancestors(view, tip);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = chain[index];
    if (!entry || entry.payload.type !== "message") continue;
    const message = entry.payload.message;
    if (message.role !== "assistant") continue;
    return typeof message.errorMessage === "string" && message.errorMessage.length > 0 ? message.errorMessage : null;
  }
  return null;
}

function operationLane(view: StorageView, operationId: string): string | undefined {
  const meta = view.get<OperationMeta>(metaAddress(operationId));
  if (meta) return meta.lane;
  return view.get<OperationResult>(resultAddress(operationId))?.lane;
}

/**
 * Stored lane config when the lane has been initialized, otherwise the harness options.
 * Does not create the lane. `assess` and the usage projection both read the model and compaction settings here.
 */
function resolveLaneModel(view: StorageView, lane: string, options: HarnessOptions): {
  provider: string;
  modelId: string;
  compaction: LaneConfig["compaction"];
  model: ReturnType<HarnessOptions["models"]["getModel"]>;
} {
  const stored = view.get<LaneConfig>(configAddress(lane));
  const compaction = stored?.compaction ?? options.compaction ?? { enabled: false, maxTokens: 80_000 };
  const provider = stored?.provider ?? options.model.provider;
  const modelId = stored?.modelId ?? options.model.modelId;
  return { provider, modelId, compaction, model: options.models.getModel(provider, modelId) };
}

function compactionThreshold(view: StorageView, lane: string, options: HarnessOptions): number | null {
  const resolved = resolveLaneModel(view, lane, options);
  if (!resolved.compaction.enabled) return null;
  if (!Number.isSafeInteger(resolved.compaction.maxTokens) || resolved.compaction.maxTokens <= 0) return null;
  const model = resolved.model;
  if (!model || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) return null;
  return effectiveInputThreshold(model.contextWindow, resolved.compaction.maxTokens);
}

/** Last `OUTPUT_TAIL_LIMIT` code units. A cut that starts on a low surrogate drops that unit so a pair stays whole. */
function checkpointTail(partial: string): string {
  const tail = partial.slice(-OUTPUT_TAIL_LIMIT);
  const lead = tail.charCodeAt(0);
  if (lead >= 0xDC00 && lead <= 0xDFFF) return tail.slice(1);
  return tail;
}

function ancestors(view: StorageView, tip: string | null): Entry[] {
  const chain: Entry[] = [];
  let current = tip;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const entry = view.entry(current);
    if (!entry) break;
    chain.push(entry);
    current = entry.parentId;
  }
  return chain.reverse();
}

function usageWrite(id: string, operationId: string, message: AssistantMessage): Write {
  const quoted = message.usage.cost?.total;
  return {
    type: "usage",
    id,
    operationId,
    input: message.usage.input,
    output: message.usage.output,
    totalTokens: message.usage.totalTokens,
    cacheRead: message.usage.cacheRead ?? null,
    cacheWrite: message.usage.cacheWrite ?? 0,
    reasoning: message.usage.reasoning ?? null,
    model: { provider: message.provider, modelId: message.model },
    ...(quoted === null || quoted === undefined ? { cost: { total: null } } : {}),
  };
}

function applyDeadline(message: AssistantMessage, action: ReturnType<typeof classifyDeadline>, frames: readonly AssistantFrame[]): AssistantMessage {
  if (action.kind === "unchanged") return message;
  if (action.kind === "retryable_timeout") {
    return {
      ...message,
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      retryable: true,
      overflow: false,
      errorMessage: "model request timed out",
    };
  }
  const content = reduceFrames(frames).content.filter((block) => block.type !== "toolCall");
  return {
    ...message,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stopReason: "aborted",
    retryable: false,
    overflow: false,
    errorMessage: "model request timed out after output started",
  };
}

function timeoutMessage(model: { api: string; provider: string; id: string }, action: "retryable_timeout", content: AssistantMessage["content"]): AssistantMessage {
  return applyDeadline({
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
    stopReason: "error",
    errorMessage: "model request failed",
    timestamp: Date.now(),
  }, { kind: action }, []);
}

function missingModel(config: LaneConfig): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: "missing",
    provider: config.provider,
    model: config.modelId,
    usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
    stopReason: "error",
    errorMessage: `Unknown model ${config.provider}/${config.modelId}`,
    timestamp: Date.now(),
  };
}

function failure(code: HarnessFailure["code"], message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

async function settleAll(tasks: Promise<void>[]): Promise<void> {
  const settled = await Promise.allSettled(tasks);
  for (const outcome of settled) {
    if (outcome.status === "rejected") throw outcome.reason;
  }
}

/** Wait until `notBefore`, or until `signal` aborts. An already-aborted signal finishes without a timer. */
export function waitUntil(notBefore: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const ms = Math.max(0, notBefore - Date.now());
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      } finally {
        resolve();
      }
    };
    const onAbort = () => finish();
    const timer = setTimeout(finish, ms);
    try {
      signal.addEventListener("abort", onAbort, { once: true });
    } catch (error) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
      }
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (signal.aborted) finish();
  });
}

export function laneAddress(lane: string): Address {
  return value("pi.lane.state", lane);
}

export function tipAddress(lane: string): Address {
  return value("pi.branch.tip", lane);
}

function configAddress(lane: string): Address {
  return value("pi.lane.config", lane);
}

function metaAddress(id: string): Address {
  return value("pi.op.meta", id);
}

function stateAddress(id: string): Address {
  return value("pi.op.state", id);
}

function resultAddress(id: string): Address {
  return value("pi.result", id);
}

function pendingAddress(id: string): Address {
  return value("pi.pending.entry", id);
}

function toolOutputAddress(id: string): Address {
  return value("pi.pending.tool_output", id);
}

function toolArgsAddress(operationId: string, resultId: string): Address {
  return value("pi.op.tool_args", `${operationId}:${resultId}`);
}

function frameAddress(operationId: string, responseId: string): Address {
  return list("pi.pending.assistant_frame", `${operationId}:${responseId}`);
}

void list;
void value;
