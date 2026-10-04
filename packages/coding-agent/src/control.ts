import type { EntryDto, HistoryPageDto, LaneSnapshotDto } from "@amazme/runtime-service";
import type { LaneSubscription, RemoteLane } from "@amazme/runtime-service/client";

export interface RetryWait {
  operationId: string;
  notBefore: number;
}

export interface ControlView {
  snapshot: LaneSnapshotDto;
  omitted: number;
  skipped: number;
  pendingOmitted: boolean;
  /** Entries loaded with `history`, older than the subscribed window. */
  earlier: EntryDto[];
  older: number;
  retry: RetryWait | null;
  failure: string | null;
}

/**
 * One attached lane. Opening subscribes and, when an operation is already admitted, drives it once.
 * A plain submit follow-ups an open operation and accepts a new prompt only when the lane is idle.
 * Retry waits are shown; the caller decides when to continue them.
 */
export class LaneControl {
  private subscription: LaneSubscription | undefined;
  private earlier: EntryDto[] = [];
  private older = 0;
  private retry: RetryWait | null = null;
  private failure: string | null = null;
  private driving: Promise<void> | undefined;
  private generation = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly lane: RemoteLane, private readonly onView: (view: ControlView) => void) {}

  async open(): Promise<void> {
    this.subscription = await this.lane.subscribe(() => this.noteWindow());
    this.noteWindow();
    const operationId = this.subscription.current().operationId;
    if (operationId) void this.drive(operationId, false);
  }

  view(): ControlView {
    const subscription = this.subscription;
    const snapshot = subscription?.current() ?? emptySnapshot(this.lane.name);
    const coverage = subscription?.coverage() ?? { omitted: 0, skipped: 0, pendingOmitted: false };
    return {
      snapshot,
      omitted: coverage.omitted,
      skipped: coverage.skipped,
      pendingOmitted: coverage.pendingOmitted,
      earlier: this.earlier,
      older: this.older,
      retry: this.retry,
      failure: this.failure,
    };
  }

  /** Idle: accept then drive. Busy: followUp. Does not steer and does not start a second prompt. */
  async submit(text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const operationId = this.view().snapshot.operationId;
    if (operationId) {
      await this.lane.followUp(body);
      return;
    }
    const admitted = await this.lane.accept({ kind: "prompt", text: body });
    await this.drive(admitted.operationId, false);
  }

  async steer(text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    await this.lane.steer(body);
  }

  async abort(): Promise<void> {
    const operationId = this.view().snapshot.operationId;
    if (!operationId) return;
    await this.lane.requestAbort(operationId);
  }

  /** Drive the visible retry, waiting until `notBefore`. */
  async continueRetry(): Promise<void> {
    if (!this.retry) return;
    await this.drive(this.retry.operationId, true);
  }

  async loadEarlier(): Promise<HistoryPageDto> {
    const snapshot = this.view().snapshot;
    const oldest = this.earlier[0]?.id ?? snapshot.entries[0]?.id;
    if (!oldest) return { entries: [], older: 0, skipped: 0 };
    const page = await this.lane.history(oldest, 20);
    const known = new Set([...this.earlier, ...snapshot.entries].map((entry) => entry.id));
    this.earlier = [...page.entries.filter((entry) => !known.has(entry.id)), ...this.earlier];
    this.older = page.older;
    this.emit();
    return page;
  }

  async close(): Promise<void> {
    await this.subscription?.close();
  }

  private noteWindow(): void {
    const snapshot = this.subscription?.current();
    const coverage = this.subscription?.coverage();
    if (!snapshot || !coverage) return;
    if (coverage.omitted === 0 && coverage.skipped === 0) {
      this.earlier = [];
      this.older = 0;
    } else {
      const parent = snapshot.entries[0]?.parentId ?? null;
      const tail = this.earlier.at(-1)?.id;
      if (tail !== undefined && tail !== parent) {
        this.earlier = [];
        this.older = coverage.omitted;
      }
    }
    this.generation += 1;
    this.emit();
    const waiting = this.waiters.splice(0);
    for (const wake of waiting) wake();
  }

  private async drive(operationId: string, waitForRetry: boolean): Promise<void> {
    if (this.driving) {
      await this.driving;
      if (this.view().snapshot.operationId !== operationId) return;
    }
    if (waitForRetry) this.retry = null;
    const started = this.subscription?.current().version ?? -1;
    let run!: Promise<void>;
    run = this.lane.drive(operationId, { waitForRetry }).then(async (outcome) => {
      this.retry = outcome.kind === "waiting" ? { operationId: outcome.operationId, notBefore: outcome.notBefore } : null;
      this.failure = null;
      if (outcome.kind === "settled") await this.untilOperationLeft(operationId, started);
    }, (error: unknown) => {
      this.failure = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      if (this.driving === run) this.driving = undefined;
      this.emit();
    });
    this.driving = run;
    await run;
  }

  private emit(): void {
    this.onView(this.view());
  }

  /** The drive result can arrive before the snapshot that shows it. A stale idle view does not count. */
  private async untilOperationLeft(operationId: string, started: number): Promise<void> {
    while (true) {
      const snap = this.view().snapshot;
      if (snap.version > started && snap.operationId !== operationId) return;
      const seen = this.generation;
      await new Promise<void>((resolve) => {
        if (this.generation !== seen || (this.view().snapshot.version > started && this.view().snapshot.operationId !== operationId)) {
          resolve();
          return;
        }
        this.waiters.push(resolve);
      });
    }
  }
}

function emptySnapshot(lane: string): LaneSnapshotDto {
  return {
    version: 0,
    lane,
    tipId: null,
    phase: null,
    operationId: null,
    lastOperationId: null,
    status: null,
    entries: [],
    pendingResponse: null,
    tools: [],
  };
}

export function renderControl(view: ControlView): string {
  const lines: string[] = [];
  const snap = view.snapshot;
  lines.push(`# ${snap.lane} ${snap.phase ?? "idle"} ${snap.operationId ?? ""}`.trimEnd());
  if (view.earlier.length > 0) lines.push(`loaded ${view.earlier.length} earlier, ${view.older} still older`);
  else if (view.omitted > 0) lines.push(`omitted ${view.omitted}`);
  if (view.skipped > 0) lines.push(`skipped ${view.skipped} entries that do not fit in one frame`);
  for (const entry of [...view.earlier, ...snap.entries]) lines.push(renderEntry(entry));
  if (view.pendingOmitted) lines.push("pending: omitted");
  else if (snap.pendingResponse) lines.push(`pending: ${textOf(snap.pendingResponse.content)}`);
  for (const tool of snap.tools) lines.push(`tool ${tool.name} ${tool.status}`);
  if (view.retry) lines.push(`retry ${view.retry.operationId} notBefore ${view.retry.notBefore}`);
  if (view.failure) lines.push(`failure: ${view.failure}`);
  return lines.join("\n");
}

function renderEntry(entry: EntryDto): string {
  const payload = entry.payload as { type?: string; message?: { role?: string; content?: unknown }; summary?: string };
  if (payload.type === "compaction") return `compaction: ${payload.summary ?? ""}`;
  const message = payload.message;
  return `${message?.role ?? "entry"}: ${textOf(message?.content)}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const record = block as { type?: string; text?: string; name?: string };
    if (record.type === "text") return record.text ?? "";
    if (record.type === "toolCall") return `[tool ${record.name ?? ""}]`;
    return "";
  }).filter((part) => part.length > 0).join("");
}
