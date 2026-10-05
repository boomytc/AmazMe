/**
 * Why `drive` is waiting.
 * `retry` is a model resend at `notBefore`. `approval` is a tool call parked for the user.
 * An approval wait's `notBefore` is the earliest parked `requestedAt`, which is already in the past.
 */
export const DRIVE_WAIT_REASONS = ["retry", "approval"] as const;
export type DriveWaitReason = (typeof DRIVE_WAIT_REASONS)[number];

export interface HostRetryWait {
  operationId: string;
  reason: DriveWaitReason;
  notBefore: number;
}

export interface RetryClock {
  now(): number;
  /**
   * Arm `run` after `delayMs`. `delayMs` is zero when `notBefore` has already passed.
   * The returned function cancels that arm so a later schedule can drop it.
   */
  schedule(delayMs: number, run: () => void): () => void;
}

export interface PendingApprovalSource {
  pendingApprovals(): Promise<{ items: readonly unknown[] }>;
}

/**
 * One retry timer per lane and operation.
 * Two drives of the same operation each called `clock.schedule`, and both timeouts later called `drive`.
 * The later schedule cancels the earlier arm. An approval block cancels and does not arm.
 */
const retryArms = new WeakMap<object, Map<string, () => void>>();

function replaceRetryTimer(lane: object, operationId: string, cancel: (() => void) | undefined): void {
  let arms = retryArms.get(lane);
  const previous = arms?.get(operationId);
  if (cancel) {
    if (!arms) {
      arms = new Map();
      retryArms.set(lane, arms);
    }
    arms.set(operationId, cancel);
  } else {
    arms?.delete(operationId);
  }
  previous?.();
}

/**
 * Arm one automatic model retry for this operation.
 * `pendingApprovals().items` is checked first. A non-empty list means tools are waiting for the user,
 * so no timer is armed and any timer already armed for this operation is cancelled.
 * After that list is empty, the retry is armed from `notBefore`. A second schedule for the same
 * operation cancels the previous timer before the new one can fire.
 * Returns whether a retry was armed.
 */
export async function scheduleHostRetry(
  lane: PendingApprovalSource,
  waiting: HostRetryWait,
  clock: RetryClock,
  run: () => void,
): Promise<boolean> {
  const pending = await lane.pendingApprovals();
  if (pending.items.length > 0) {
    replaceRetryTimer(lane, waiting.operationId, undefined);
    return false;
  }
  const cancel = clock.schedule(Math.max(0, waiting.notBefore - clock.now()), () => {
    const arms = retryArms.get(lane);
    if (arms?.get(waiting.operationId) === cancel) arms.delete(waiting.operationId);
    run();
  });
  replaceRetryTimer(lane, waiting.operationId, cancel);
  return true;
}

interface DrivenLane extends PendingApprovalSource {
  drive(operationId: string, options?: { waitForRetry?: boolean }): Promise<
    | { ok: true; value: { kind: "settled" } | (HostRetryWait & { kind: "waiting" }) }
    | { ok: false }
  >;
}

const armedLanes = new WeakSet<object>();

/** Host lanes arm the next model retry when `drive` stops on a wait. Approval items block that arm. */
export function installHostRetries<T extends DrivenLane>(
  harness: { lane(name?: string): T },
  clock: RetryClock = liveRetryClock(),
): void {
  const open = harness.lane.bind(harness);
  harness.lane = (name?: string): T => {
    const lane = open(name);
    armLane(lane, clock);
    return lane;
  };
}

function armLane(lane: DrivenLane, clock: RetryClock): void {
  if (armedLanes.has(lane)) return;
  armedLanes.add(lane);
  const drive = lane.drive.bind(lane);
  lane.drive = async (operationId, options) => {
    const outcome = await drive(operationId, options);
    if (outcome.ok && outcome.value.kind === "waiting") {
      const waiting: HostRetryWait = {
        operationId: outcome.value.operationId,
        reason: outcome.value.reason,
        notBefore: outcome.value.notBefore,
      };
      await scheduleHostRetry(lane, waiting, clock, () => {
        void lane.drive(operationId).then(() => undefined, () => undefined);
      });
    }
    return outcome;
  };
}

function liveRetryClock(): RetryClock {
  return {
    now: () => Date.now(),
    schedule(delayMs, run) {
      const timer = setTimeout(run, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
}
