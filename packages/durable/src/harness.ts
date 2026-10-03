import { applyAfter, walkAfter, walkBefore, walkTransform, type AgentHook, type AgentMessage } from "@amazme/agent";
import {
  uuidv7,
  toolDefinition,
  validateArguments,
  type AssistantMessage,
  type Context,
  frameFromEvent,
  reduceFrames,
  resolveOutputBudget,
  type ThinkingLevel,
} from "@amazme/ai";
import { createTypedSpanStarter, type SchemaTelemetrySpan, type TelemetryContext } from "@amazme/telemetry";
import { acceptedSummary, continuationContext, fitSummaryRequest, planCompaction, summaryRejection } from "./compaction/plan.ts";
import { effectiveInputThreshold, keepRecentBudget } from "./compaction/policy.ts";
import type { TranscriptEntry } from "./compaction/select.ts";
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
  | { type: "tools"; operationId: string };

const running = (): Scope => ({ control: { status: "running" }, attempt: 0, overflowUsed: false, thresholdUsed: false });

/**
 * Durable lane runtime. `accept` records an operation and does not call a model.
 * `drive` advances the total operation state. A new process resumes from that state:
 * provider streams are not reattached, unsafe tools are not repeated, safe tools are.
 */
export class AgentHarness {
  private closed = false;
  private abandoned = false;
  private abort = new AbortController();
  private readonly drives = new Map<string, Promise<Result<DriveOutcome>>>();
  private readonly laneAborts = new Map<string, AbortController>();
  /** Effects this process has armed. A restarted harness has an empty set, so the same leaf means recovery. */
  readonly live = new Set<string>();
  readonly storage: Storage;
  readonly options: HarnessOptions;

  constructor(storage: Storage, options: HarnessOptions) {
    this.storage = storage;
    this.options = options;
  }

  lane(name = "main"): AgentLane {
    return new AgentLane(this, name);
  }

  /** Drop this process without settling in-flight effects. Storage stays where the last commit left it. */
  abandon(): void {
    this.abandoned = true;
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
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
    let settle: (value: Result<DriveOutcome>) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const run = new Promise<Result<DriveOutcome>>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.drives.set(key, run);
    void start().then(settle, fail).finally(() => {
      if (this.drives.get(key) === run) this.drives.delete(key);
    });
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

  async accept(request: OperationRequest): Promise<Result<OperationAdmission>> {
    if (this.harness.isClosed) return failure("closed", "harness is closed");
    return this.harness.storage.run((view, apply) => this.acceptLocked(view, apply, request));
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
      const planned = await this.harness.storage.run((view, apply) => this.plan(view, apply, operationId, span));
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
      if (this.harness.isAbandoned) return this.settledOrWait(operationId);
      if (planned.type === "assistant") {
        try {
          const message = await this.streamAssistant(planned, signal, span);
          if (this.harness.isAbandoned) return this.settledOrWait(operationId);
          await this.harness.storage.run((view, apply) => this.settleAssistant(view, apply, planned, message));
        } finally {
          this.harness.live.delete(planned.responseEntryId);
        }
        continue;
      }
      if (planned.type === "summary") {
        try {
          const message = await this.streamSummary(signal, span);
          if (this.harness.isAbandoned) return this.settledOrWait(operationId);
          await this.harness.storage.run((view, apply) => this.settleSummary(view, apply, planned, message));
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

  async requestAbort(operationId: string): Promise<Result<{ operationId: string; newlyRequested: boolean }>> {
    if (this.harness.isClosed) return failure("closed", "harness is closed");
    const result = await this.harness.storage.run((view, apply) => {
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

  async inspect(): Promise<{
    lane: string;
    tipId: string | null;
    phase: OperationState["phase"] | null;
    operationId: string | null;
    lastOperationId: string | null;
    status: "open" | "aborting" | null;
  }> {
    return this.harness.storage.read((view) => {
      const record = view.get<LaneRecord>(laneAddress(this.name));
      const operationId = record?.currentOperationId ?? null;
      const state = operationId ? view.get<OperationState>(stateAddress(operationId)) : undefined;
      return {
        lane: this.name,
        tipId: view.get<string | null>(tipAddress(this.name)) ?? null,
        phase: state?.phase ?? null,
        operationId,
        lastOperationId: record?.lastOperationId ?? null,
        status: state ? (state.scope.control.status === "cancel_requested" ? "aborting" : "open") : null,
      };
    });
  }

  async entries(): Promise<Entry[]> {
    return this.harness.storage.read((view) => {
      const tip = view.get<string | null>(tipAddress(this.name)) ?? null;
      return ancestors(view, tip);
    });
  }

  private async enqueue(message: HarnessMessage, kind: InboxItem["kind"]): Promise<Result<{ entryId: string }>> {
    if (this.harness.isClosed) return failure("closed", "harness is closed");
    if (message.role !== "user" && message.role !== "custom") return failure("invalid_message", "queue accepts user messages");
    const entryId = uuidv7();
    await this.harness.storage.run((view, apply) => {
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

  private async streamAssistant(planned: Extract<Plan, { type: "assistant" }>, signal: AbortSignal, telemetryContext: TelemetryContext): Promise<AssistantMessage> {
    const context = await this.harness.storage.read((view) => this.providerContext(view));
    const config = await this.harness.storage.read((view) => this.config(view));
    const model = this.harness.options.models.getModel(config.provider, config.modelId);
    if (!model) return missingModel(config);
    const replaced = await walkTransform(this.hookList(), context.messages as AgentMessage[], signal);
    const request = replaced ? { ...context, messages: replaced as typeof context.messages } : context;
    const stream = this.harness.options.models.streamSimple(model, request, {
      signal,
      thinkingLevel: config.thinkingLevel,
      telemetryContext,
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    });
    let frames = Promise.resolve();
    let frameFailure: { error: unknown } | undefined;
    try {
      for await (const event of stream) {
        const frame = frameFromEvent(event);
        if (!frame) continue;
        const queued = this.appendFrame(planned, frame).catch((error: unknown) => {
          frameFailure ??= { error };
        });
        frames = frames.then(() => queued);
      }
    } finally {
      await frames;
    }
    if (frameFailure) throw frameFailure.error;
    return stream.result();
  }

  private async streamSummary(signal: AbortSignal, telemetryContext: TelemetryContext): Promise<AssistantMessage> {
    const prepared = await this.harness.storage.read((view) => {
      const operationId = this.record(view).currentOperationId;
      const state = operationId ? view.get<OperationState>(stateAddress(operationId)) : undefined;
      const config = this.config(view);
      if (!state || state.phase !== "summary_effect_pending") return { config, request: undefined };
      return { config, request: this.summaryRequest(view, state) };
    });
    const model = this.harness.options.models.getModel(prepared.config.provider, prepared.config.modelId);
    const request = prepared.request;
    if (!model || !request || !request.ok) {
      const failed = missingModel(prepared.config);
      if (model) failed.errorMessage = request && !request.ok ? request.message : "summary plan is missing";
      return failed;
    }
    const replaced = await walkTransform(this.hookList(), request.context.messages as AgentMessage[], signal);
    const summaryContext = replaced
      ? { ...request.context, messages: replaced as typeof request.context.messages }
      : request.context;
    const stream = this.harness.options.models.streamSimple(
      model,
      summaryContext,
      { signal, thinkingLevel: "off", maxTokens: request.maxTokens, telemetryContext },
    );
    let message: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === "done") message = event.message;
      if (event.type === "error") message = event.error;
    }
    return message ?? stream.result();
  }

  private appendFrame(planned: { operationId: string; responseEntryId: string }, frame: import("@amazme/ai").AssistantFrame): Promise<void> {
    return this.harness.storage.run((view, apply) => {
      const state = view.get<OperationState>(stateAddress(planned.operationId));
      if (state?.phase !== "assistant_effect_pending" || state.responseEntryId !== planned.responseEntryId) return;
      apply([{ type: "append", address: frameAddress(planned.operationId, planned.responseEntryId), item: frame }]);
    });
  }

  private settleAssistant(
    view: StorageView,
    apply: Apply,
    planned: Extract<Plan, { type: "assistant" }>,
    message: AssistantMessage,
  ): void {
    const state = view.get<OperationState>(stateAddress(planned.operationId));
    const meta = view.get<OperationMeta>(metaAddress(planned.operationId));
    if (!state || !meta || state.phase !== "assistant_effect_pending" || state.responseEntryId !== planned.responseEntryId) return;
    const config = this.config(view);
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
          notBefore: Date.now() + 10,
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
      const action = await this.harness.storage.run((view, apply) => this.armTools(view, apply, operationId, telemetryContext, signal));
      if (action.type === "done") return;
      const sequential = action.mode === "sequential";
      const execute = async (call: ArmedCall) => {
        try {
          const result = await createTypedSpanStarter(telemetryContext, [durableTelemetrySchema])(
            "amazme.tool.execute",
            { tool: call.name, toolCallId: call.toolCallId },
            async (span) => {
              const result = await this.executeTool(call, signal, span);
              if (result.isError || signal.aborted) span.setStatus({ status: "error" });
              return result;
            });
          if (this.harness.isAbandoned) return;
          const update = await walkAfter(this.hookList(), {
            toolCallId: call.toolCallId,
            toolName: call.name,
            args: call.args,
            result,
          }, signal);
          await this.harness.storage.run((view, apply) => this.stageTool(view, apply, operationId, call, applyAfter(result, update)));
        } catch (error) {
          this.harness.live.delete(call.resultEntryId);
          throw error;
        }
      };
      if (sequential) {
        const call = action.calls[0];
        if (call) await execute(call);
      } else {
        await settleAll(action.calls.map((call) => execute(call)));
      }
    }
  }

  private async armTools(view: StorageView, apply: Apply, operationId: string, telemetryContext: DriveSpan, signal: AbortSignal): Promise<{ type: "done" } | { type: "run"; mode: ToolExecutionMode; calls: ArmedCall[] }> {
    const state = view.get<OperationState>(stateAddress(operationId));
    if (!state || state.phase !== "tools") return { type: "done" };
    this.materializeTools(view, apply, operationId);
    const refreshed = view.get<OperationState>(stateAddress(operationId));
    if (!refreshed || refreshed.phase !== "tools") return { type: "done" };
    const config = this.config(view);
    const assistant = view.entry(refreshed.responseEntryId);
    const toRun: ArmedCall[] = [];
    let calls = refreshed.calls.map((call) => ({ ...call }));
    const cancel = refreshed.scope.control.status === "cancel_requested";
    const sequential = config.toolExecution === "sequential" || calls.some((call) => this.tool(call.name)?.executionMode === "sequential");
    const recoverable = calls.filter((call) => call.status === "effect_pending" && !this.harness.live.has(call.resultEntryId));
    for (const call of recoverable) {
      if (call.replay === "safe" && !cancel) {
        this.harness.live.add(call.resultEntryId);
        toRun.push(this.armed(view, operationId, call, assistant));
        telemetryContext.addEvent("amazme.harness.recovered", { effect: "tool", replay: "safe" });
        if (sequential) break;
        continue;
      }
      calls = calls.map((item) => (item.resultEntryId === call.resultEntryId ? { ...item, status: "outcome_ready" as const, terminate: false } : item));
      const checkpoint = view.get<string>(toolOutputAddress(call.resultEntryId));
      const reason = cancel ? "cancelled" : "interrupted before settlement";
      const text = checkpoint ? `${reason}\n${checkpoint}` : reason;
      apply([{
        type: "set",
        address: pendingAddress(call.resultEntryId),
        value: { type: "message", message: toolMessage(call, text, true, false) },
      }]);
    }
    if (recoverable.some((call) => call.replay !== "safe" || cancel)) {
      apply([{ type: "set", address: stateAddress(operationId), value: { ...refreshed, calls } }]);
      this.materializeTools(view, apply, operationId);
      telemetryContext.addEvent("amazme.harness.recovered", { effect: "tool", ...(cancel ? {} : { replay: "never" as const }) });
      if (toRun.length > 0) return { type: "run", mode: sequential ? "sequential" : "parallel", calls: toRun };
      return { type: "done" };
    }
    if (toRun.length > 0) return { type: "run", mode: sequential ? "sequential" : "parallel", calls: toRun };
    const planned = calls.filter((call) => call.status === "planned");
    const batch = sequential ? planned.slice(0, 1) : planned;
    if (batch.length === 0) return { type: "done" };
    const decided: Array<
      | { call: ToolCallState; args: unknown; outcome: string }
      | { call: ToolCallState; args: unknown; tool: HarnessTool }
    > = [];
    for (const call of batch) {
      const args = readArgs(assistant, call.sourceIndex);
      const tool = this.tool(call.name);
      const invalid = tool ? validateArguments(tool.parameters, args) : `Unknown tool: ${call.name}`;
      if (cancel || !tool || invalid) {
        decided.push({ call, args, outcome: cancel ? "cancelled" : invalid || "unavailable" });
        continue;
      }
      const decision = await walkBefore(this.hookList(), {
        toolCallId: call.toolCallId,
        toolName: call.name,
        args,
      }, signal);
      if (decision?.action === "block") {
        decided.push({ call, args, outcome: decision.reason });
        continue;
      }
      decided.push({ call, args, tool });
    }
    for (const item of decided) {
      if ("outcome" in item) {
        calls = calls.map((entry) => entry.resultEntryId === item.call.resultEntryId ? { ...entry, status: "outcome_ready" as const, terminate: false } : entry);
        apply([{
          type: "set",
          address: pendingAddress(item.call.resultEntryId),
          value: { type: "message", message: toolMessage(item.call, item.outcome, true, false) },
        }]);
        continue;
      }
      calls = calls.map((entry) =>
        entry.resultEntryId === item.call.resultEntryId
          ? { ...entry, status: "effect_pending" as const, replay: item.tool.replay ?? "never" }
          : entry,
      );
      apply([{ type: "set", address: toolArgsAddress(operationId, item.call.resultEntryId), value: item.args }]);
      this.harness.live.add(item.call.resultEntryId);
      toRun.push({ ...item.call, operationId, args: item.args, replay: item.tool.replay ?? "never" });
    }
    apply([{ type: "set", address: stateAddress(operationId), value: { ...refreshed, calls } }]);
    this.materializeTools(view, apply, operationId);
    if (toRun.length === 0) return { type: "done" };
    return { type: "run", mode: sequential ? "sequential" : "parallel", calls: toRun };
  }

  private async executeTool(call: ArmedCall, signal: AbortSignal, telemetryContext: TelemetryContext): Promise<ToolResult> {
    if (signal.aborted) return { content: [{ type: "text", text: "cancelled" }], isError: true };
    const tool = this.tool(call.name);
    if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${call.name}` }], isError: true };
    const writes: Promise<void>[] = [];
    let accepting = true;
    const accept = (partial: string, options?: { checkpoint?: boolean }): void => {
      if (!accepting || !options?.checkpoint) return;
      const pending = Promise.resolve()
        .then(() => this.harness.storage.run((view, apply) => {
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
    try {
      result = await tool.execute(call.args, { signal, telemetryContext, onUpdate: accept });
    } catch (error) {
      result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    } finally {
      accepting = false;
    }
    await settleAll(writes);
    return result;
  }

  private stageTool(view: StorageView, apply: Apply, operationId: string, call: ArmedCall, result: ToolResult): void {
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

  private providerContext(view: StorageView): Context {
    const config = this.config(view);
    return {
      systemPrompt: config.systemPrompt,
      messages: this.visibleEntries(view).map((entry) => entry.kind === "compaction"
        ? { role: "user" as const, content: entry.summary, timestamp: entry.timestamp }
        : entry.message),
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

  /** Place the next model call, or a compaction, after the messages for this request are already in the tree. */
  private beginModelRequest(view: StorageView, apply: Apply, meta: OperationMeta, scope: Scope): Plan {
    const decision = this.assess(view, scope);
    if (decision.type === "fail") return { type: "settled", result: this.finish(view, apply, meta, "failed", decision.message) };
    if (decision.type === "compact") {
      const nextScope: Scope = {
        ...scope,
        thresholdUsed: decision.reason === "threshold" ? true : scope.thresholdUsed,
        overflowUsed: decision.reason === "overflow" ? true : scope.overflowUsed,
      };
      apply([{
        type: "set",
        address: stateAddress(meta.operationId),
        value: { phase: "summary_deciding", scope: nextScope, reason: decision.reason, boundary: "resume" },
      }]);
      return { type: "continue" };
    }
    apply([{ type: "set", address: stateAddress(meta.operationId), value: { phase: "assistant_ready", scope } }]);
    return { type: "continue" };
  }

  private assess(view: StorageView, scope: Scope): { type: "send" } | { type: "compact"; reason: SummaryReason } | { type: "fail"; message: string } {
    const config = this.config(view);
    const model = this.harness.options.models.getModel(config.provider, config.modelId);
    if (!model) return { type: "fail", message: `Unknown model ${config.provider}/${config.modelId}` };
    if (config.compaction.enabled && (!Number.isSafeInteger(config.compaction.maxTokens) || config.compaction.maxTokens <= 0)) {
      return { type: "fail", message: "compaction.maxTokens must be a positive integer" };
    }
    const budget = resolveOutputBudget(model, this.providerContext(view), config.maxTokens);
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
    if (!view.get(configAddress(this.name))) {
      const options = this.harness.options;
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
        systemPrompt: options.systemPrompt ?? "",
      };
      apply([{ type: "set", address: configAddress(this.name), value: config }]);
    }
    if (!view.get(laneAddress(this.name))) {
      apply([{
        type: "set",
        address: laneAddress(this.name),
        value: { currentOperationId: null, lastOperationId: null, inbox: [] } satisfies LaneRecord,
      }]);
    }
    if (view.get<string | null>(tipAddress(this.name)) === undefined) {
      apply([{ type: "set", address: tipAddress(this.name), value: null }]);
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
    return config;
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
    const result = await this.harness.storage.read((view) => view.get<OperationResult>(resultAddress(operationId)));
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

function waitUntil(notBefore: number, signal: AbortSignal): Promise<void> {
  const ms = Math.max(0, notBefore - Date.now());
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
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
