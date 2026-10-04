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
  frameFromEvent,
  reduceFrames,
  resolveOutputBudget,
  type ThinkingLevel,
} from "@amazme/ai";
import { createTypedSpanStarter, type SchemaTelemetrySpan, type TelemetryContext } from "@amazme/telemetry";
import { acceptedSummary, continuationContext, fitSummaryRequest, planCompaction, summaryRejection } from "./compaction/plan.ts";
import { effectiveInputThreshold, keepRecentBudget } from "./compaction/policy.ts";
import type { TranscriptEntry } from "./compaction/select.ts";
import {
  armRequestDeadline,
  classifyDeadline,
  resolveRequestPolicy,
  retryDelayMs,
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
  /** Model-request deadline. Distinct from any tool execution limit. */
  requestTimeoutMs: number;
  /** Stored retry wait. The settled `notBefore` is `now + retryDelayMs(retry, attempt)`. */
  retry: RetryWait;
  /** Maximum tool-result characters placed in the next model request. The log keeps the original. */
  toolResultLimit: number;
  systemPrompt: string;
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
  /** Deadline for one model request. Omitted uses 60 seconds. Not a tool limit. */
  requestTimeoutMs?: number;
  /** Retry wait stored on the lane. Omitted uses a 1 second base capped at 60 seconds. */
  retry?: RetryWait;
  /** Tool-result clip for the next model request. Omitted uses 8_000 characters. */
  toolResultLimit?: number;
  /**
   * Test seam for the model deadline. Production uses {@link armRequestDeadline}.
   * The returned signal must abort when `parent` aborts.
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
  | { kind: "waiting"; operationId: string; reason: "retry"; notBefore: number };

export interface OperationAdmission {
  operationId: string;
  kind: "run" | "compaction" | "navigation";
  startedAt: number;
}

export type LanePhase = OperationState["phase"];

export interface LaneStatus {
  lane: string;
  tipId: string | null;
  phase: LanePhase | null;
  operationId: string | null;
  lastOperationId: string | null;
  status: "open" | "aborting" | null;
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

/** A tool call of the current operation. Settled calls stay in `entries`; this list is only the open batch. */
export interface ToolActivity {
  toolCallId: string;
  name: string;
  /** `running` is `effect_pending`. `outcome_ready` and `completed` are `settled`. */
  status: "planned" | "running" | "settled";
}

/** One consistent read of a lane. Every field is a detached copy taken at `version`. */
export interface LaneSnapshot extends LaneStatus {
  version: number;
  entries: Entry[];
  pendingResponse: PendingResponse | null;
  tools: ToolActivity[];
}

export type OperationRequest =
  | { kind: "prompt"; text: string; operationId?: string }
  | { kind: "compaction"; operationId?: string }
  | { kind: "navigation"; targetId: string | null; summarize?: boolean; operationId?: string };

interface Scope {
  control: { status: "running" } | { status: "cancel_requested"; requestedAt: number };
  attempt: number;
  overflowUsed: boolean;
  thresholdUsed: boolean;
}

interface ToolCallState {
  sourceIndex: number;
  resultEntryId: string;
  toolCallId: string;
  name: string;
  status: "planned" | "effect_pending" | "outcome_ready" | "completed";
  replay?: ReplayPolicy;
  terminate?: boolean;
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
  | { type: "yield" };

const running = (): Scope => ({ control: { status: "running" }, attempt: 0, overflowUsed: false, thresholdUsed: false });

/** Admitted storage calls. The public `storage` field stays the caller's instance. */
const trackedStorage = new WeakMap<AgentHarness, Storage>();

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
   * Open another conversation at `entryId` in this log. The source tip and its admitted wait stay put.
   * Later entries on either conversation do not move the other tip.
   */
  fork(name: string, entryId: string | null): Promise<Result<{ lane: string }>> {
    if (this.harness.isClosed) return Promise.resolve(failure("closed", "harness is closed"));
    if (name.length === 0 || name.includes("\0") || name === this.name) {
      return Promise.resolve(failure("invalid_message", "fork needs another conversation"));
    }
    return admitted(this.harness).run((view, apply) => {
      this.ensureConfig(view, apply);
      const tip = view.get<string | null>(tipAddress(this.name)) ?? null;
      if (entryId !== null && !ancestors(view, tip).some((entry) => entry.id === entryId)) {
        return failure("unknown_target", "fork point is not in this conversation");
      }
      this.ensureLane(view, apply, name);
      apply([{ type: "set", address: tipAddress(name), value: entryId }]);
      return { ok: true as const, value: { lane: name } };
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
        tools: toolActivity(state),
      });
    });
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
      if (!request.text.trim()) return failure("invalid_message", "prompt is empty");
      const placed = this.placeInbox(view, apply, record, true, true);
      const promptId = uuidv7();
      const parent = placed.tipId;
      apply([
        {
          type: "entry",
          id: promptId,
          parentId: parent,
          timestamp: startedAt,
          payload: { type: "message", message: user(request.text) },
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
    if (state.phase === "tools") return { type: "tools", operationId };
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
      const stream = this.harness.options.models.streamSimple(model, request, {
        signal: deadline.signal,
        thinkingLevel: config.thinkingLevel,
        telemetryContext,
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      });
      result = stream.result();
      for await (const event of stream) {
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
    const stream = this.harness.options.models.streamSimple(
      model,
      summaryContext,
      { signal: deadline.signal, thinkingLevel: "off", maxTokens: request.maxTokens, telemetryContext },
    );
    let message: AssistantMessage | undefined;
    try {
      for await (const event of stream) {
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
          notBefore: Date.now() + retryDelayMs(config.retry, state.scope.attempt + 1),
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
      const armed = action.type === "run"
        ? action
        : await this.commitDecidedTools(operationId, action.mode, await this.decideToolCalls(action.batch, signal), signal);
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
      const reason = cancel ? "cancelled" : "interrupted before settlement";
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
    const decided: ToolDecision[] = [];
    let needsHook = false;
    for (const call of batch) {
      const args = readArgs(assistant, call.sourceIndex);
      const tool = this.tool(call.name);
      const invalid = tool ? validateArguments(tool.parameters, args) : `Unknown tool: ${call.name}`;
      if (cancel || !tool || invalid) {
        decided.push({ call, args, outcome: cancel ? "cancelled" : invalid || "unavailable" });
        continue;
      }
      needsHook = true;
      decided.push({ call, args, tool });
    }
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
    const accept = (partial: string, options?: { checkpoint?: boolean }): void => {
      if (!accepting || !options?.checkpoint) return;
      const pending = Promise.resolve()
        .then(() => admitted(this.harness).run((view, apply) => {
          if (this.harness.isAbandoned) return;
          const state = view.get<OperationState>(stateAddress(call.operationId));
          if (state?.phase !== "tools") return;
          const current = state.calls.find((item) => item.resultEntryId === call.resultEntryId);
          if (current?.status !== "effect_pending") return;
          apply([{ type: "set", address: toolOutputAddress(call.resultEntryId), value: partial }]);
        }))
        .then(() => undefined);
      writes.push(pending);
      void pending.catch(() => undefined);
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
      {
        type: "usage",
        id: planned.usageId,
        operationId: planned.operationId,
        input: message.usage.input,
        output: message.usage.output,
        totalTokens: message.usage.totalTokens,
      },
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
    const chain = ancestors(view, tip);
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
    const model = this.harness.options.models.getModel(config.provider, config.modelId);
    if (!model) return { type: "fail", message: `Unknown model ${config.provider}/${config.modelId}` };
    if (config.compaction.enabled && (!Number.isSafeInteger(config.compaction.maxTokens) || config.compaction.maxTokens <= 0)) {
      return { type: "fail", message: "compaction.maxTokens must be a positive integer" };
    }
    const budget = resolveOutputBudget(model, this.providerContext(view, pending), config.maxTokens);
    if (budget.status === "invalid_limit" || budget.status === "unserializable") {
      return { type: "fail", message: budget.message ?? "Context budget is invalid" };
    }
    if (budget.status === "cannot_fit") {
      if (!config.compaction.enabled) return { type: "fail", message: `${budget.message}; compaction is disabled` };
      if (scope.overflowUsed) return { type: "fail", message: "context overflow repeated" };
      return { type: "compact", reason: "overflow" };
    }
    const threshold = effectiveInputThreshold(model.contextWindow, config.compaction.maxTokens);
    if (config.compaction.enabled && !scope.thresholdUsed && budget.estimatedInput > threshold) {
      return { type: "compact", reason: "threshold" };
    }
    return { type: "send" };
  }

  private prepareCompaction(view: StorageView, state: Extract<OperationState, { phase: "summary_deciding" }>) {
    const config = this.config(view);
    const model = this.harness.options.models.getModel(config.provider, config.modelId);
    if (!model) return { ok: false as const, code: "invalid" as const, message: `Unknown model ${config.provider}/${config.modelId}` };
    if (config.compaction.enabled && (!Number.isSafeInteger(config.compaction.maxTokens) || config.compaction.maxTokens <= 0)) {
      return { ok: false as const, code: "invalid" as const, message: "compaction.maxTokens must be a positive integer" };
    }
    const threshold = effectiveInputThreshold(model.contextWindow, config.compaction.maxTokens);
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
}

function user(text: string): HarnessMessage {
  return { role: "user", content: text, timestamp: Date.now() };
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

function toolActivity(state: OperationState | undefined): ToolActivity[] {
  if (!state || state.phase !== "tools") return [];
  return state.calls.map((call) => ({
    toolCallId: call.toolCallId,
    name: call.name,
    status: call.status === "planned" ? "planned" : call.status === "effect_pending" ? "running" : "settled",
  }));
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
  return {
    type: "usage",
    id,
    operationId,
    input: message.usage.input,
    output: message.usage.output,
    totalTokens: message.usage.totalTokens,
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
