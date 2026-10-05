import { encodeServerMessage, ProtocolError, type JsonValue, type ProtocolLimits } from "@amazme/protocol";
import type { EntryDto, LaneSnapshotDto, LaneWindowDto } from "./contracts.ts";

/** Request and subscription ids are at most this long, so a fit check leaves room for a real id. */
const PADDED_ID = "a".repeat(128);

export interface HistoryPage {
  entries: EntryDto[];
  older: number;
  skipped: number;
}

type Envelope = { kind: "response" } | { kind: "update"; subscriptionId: string };

/** `undefined` means even the header does not fit in one frame. */
export function fitWindow(snapshot: LaneSnapshotDto, limits: ProtocolLimits, envelope: Envelope): LaneWindowDto | undefined {
  const skippedEntries = snapshot.entries.filter((entry) => !entryFits(entry, snapshot, limits, envelope));
  const candidates = snapshot.entries.filter((entry) => entryFits(entry, snapshot, limits, envelope));
  const withPending = shrink(snapshot, candidates, snapshot.pendingResponse, false, skippedEntries.length, limits, envelope);
  if (withPending) return withPending;
  if (snapshot.pendingResponse !== null) {
    return shrink(snapshot, candidates, null, true, skippedEntries.length, limits, envelope);
  }
  return undefined;
}

function shrink(
  snapshot: LaneSnapshotDto,
  candidates: readonly EntryDto[],
  pendingResponse: LaneSnapshotDto["pendingResponse"],
  pendingOmitted: boolean,
  skipped: number,
  limits: ProtocolLimits,
  envelope: Envelope,
): LaneWindowDto | undefined {
  let entries = [...candidates];
  let omitted = 0;
  const build = (): LaneWindowDto => ({
    version: snapshot.version,
    lane: snapshot.lane,
    tipId: snapshot.tipId,
    phase: snapshot.phase,
    operationId: snapshot.operationId,
    lastOperationId: snapshot.lastOperationId,
    status: snapshot.status,
    pendingResponse,
    pendingOmitted,
    tools: snapshot.tools,
    entries,
    omitted,
    skipped,
    activity: snapshot.activity,
  });
  while (!windowFits(limits, build(), envelope)) {
    if (entries.length === 0) return undefined;
    entries = entries.slice(1);
    omitted += 1;
  }
  return build();
}

/** Drops the oldest entries of one page until the response fits. An entry that cannot fit alone is `skipped`. */
export function fitHistory(entries: readonly EntryDto[], older: number, limits: ProtocolLimits): HistoryPage | undefined {
  let page = [...entries];
  let olderCount = older;
  let skipped = 0;
  const build = (): HistoryPage => ({ entries: page, older: olderCount, skipped });
  const asJson = (value: HistoryPage): JsonValue => value as unknown as JsonValue;
  while (!responseFits(limits, asJson(build()))) {
    if (page.length === 0) return undefined;
    const oldest = page[0]!;
    page = page.slice(1);
    if (responseFits(limits, asJson({ entries: [oldest], older: 0, skipped: 0 }))) olderCount += 1;
    else skipped += 1;
  }
  return build();
}

export function responseFits(limits: ProtocolLimits, result: JsonValue): boolean {
  return encodes(limits, { type: "response", id: PADDED_ID, ok: true, result });
}

function windowFits(limits: ProtocolLimits, window: LaneWindowDto, envelope: Envelope): boolean {
  if (envelope.kind === "response") return responseFits(limits, window);
  return encodes(limits, { type: "service_update", subscriptionId: envelope.subscriptionId, update: { kind: "advance", advance: window } });
}

function entryFits(entry: EntryDto, snapshot: LaneSnapshotDto, limits: ProtocolLimits, envelope: Envelope): boolean {
  const alone: LaneWindowDto = {
    version: snapshot.version,
    lane: snapshot.lane,
    tipId: snapshot.tipId,
    phase: snapshot.phase,
    operationId: snapshot.operationId,
    lastOperationId: snapshot.lastOperationId,
    status: snapshot.status,
    pendingResponse: null,
    pendingOmitted: true,
    tools: snapshot.tools,
    entries: [entry],
    omitted: 0,
    skipped: 0,
    activity: snapshot.activity,
  };
  return windowFits(limits, alone, envelope);
}

function encodes(limits: ProtocolLimits, message: JsonValue): boolean {
  try {
    encodeServerMessage(message as Parameters<typeof encodeServerMessage>[0], limits);
    return true;
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "limit_exceeded") return false;
    throw error;
  }
}
