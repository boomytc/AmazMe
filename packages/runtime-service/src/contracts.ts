import type { JsonValue } from "@amazme/protocol";
import Type, { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

const Strict = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** Lane names are service data: the runtime decides which lanes exist; the protocol never sees them. */
export const LaneNameSchema = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" });
export const OperationIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
const SubscriptionIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
const RuntimeIdSchema = SubscriptionIdSchema;
const EntryIdSchema = Type.String({ minLength: 1 });
/** Replies carry IDs and lanes as Durable stored them; in-process callers may have used any non-empty string. */
const StoredIdSchema = Type.String({ minLength: 1 });
const Text = Type.String({ maxLength: 1_000_000 });
const Time = Type.Number();

const PromptRequestSchema = Strict({ kind: Type.Literal("prompt"), text: Text, operationId: Type.Optional(OperationIdSchema) });
const CompactionRequestSchema = Strict({ kind: Type.Literal("compaction"), operationId: Type.Optional(OperationIdSchema) });
const NavigationRequestSchema = Strict({
  kind: Type.Literal("navigation"),
  targetId: Nullable(EntryIdSchema),
  summarize: Type.Optional(Type.Boolean()),
  operationId: Type.Optional(OperationIdSchema),
});
export const OperationRequestSchema = Type.Union([PromptRequestSchema, CompactionRequestSchema, NavigationRequestSchema]);
export type OperationRequest = Static<typeof OperationRequestSchema>;

const AcceptCall = Strict({ method: Type.Literal("accept"), lane: LaneNameSchema, request: OperationRequestSchema });
const DriveCall = Strict({ method: Type.Literal("drive"), lane: LaneNameSchema, operationId: OperationIdSchema, waitForRetry: Type.Optional(Type.Boolean()) });
const SnapshotCall = Strict({ method: Type.Literal("snapshot"), lane: LaneNameSchema });
const ResultCall = Strict({ method: Type.Literal("result"), lane: LaneNameSchema, operationId: OperationIdSchema });
const SteerCall = Strict({ method: Type.Literal("steer"), lane: LaneNameSchema, text: Text });
const FollowUpCall = Strict({ method: Type.Literal("followUp"), lane: LaneNameSchema, text: Text });
const RequestAbortCall = Strict({ method: Type.Literal("requestAbort"), lane: LaneNameSchema, operationId: OperationIdSchema });
const SubscribeCall = Strict({ method: Type.Literal("subscribe"), lane: LaneNameSchema, subscriptionId: SubscriptionIdSchema });
const UnsubscribeCall = Strict({ method: Type.Literal("unsubscribe"), subscriptionId: SubscriptionIdSchema });
/** Calls on a runtime route. Each names its lane explicitly. */
export const RuntimeCallSchema = Type.Union([
  AcceptCall, DriveCall, SnapshotCall, ResultCall, SteerCall, FollowUpCall, RequestAbortCall, SubscribeCall, UnsubscribeCall,
]);
export type RuntimeCall = Static<typeof RuntimeCallSchema>;

/** Calls on the server route that ask the router to attach or detach this connection. */
export const ManagementCallSchema = Type.Union([
  Strict({ method: Type.Literal("attach"), runtimeId: RuntimeIdSchema }),
  Strict({ method: Type.Literal("detach") }),
]);
export type ManagementCall = Static<typeof ManagementCallSchema>;

export const LANE_PHASES = [
  "starting",
  "checkpoint",
  "assistant_ready",
  "assistant_effect_pending",
  "retry_wait",
  "tools",
  "summary_deciding",
  "summary_effect_pending",
  "navigation_ready",
] as const;

/** Message content stays opaque beyond its role; the protocol already guarantees strict JSON. */
const MessageSchema = Type.Object({ role: Type.String() }, { additionalProperties: true });
const ContentBlockSchema = Type.Object({ type: Type.String() }, { additionalProperties: true });
const EntrySchema = Strict({
  id: EntryIdSchema,
  parentId: Nullable(EntryIdSchema),
  seq: Type.Integer({ minimum: 0 }),
  timestamp: Time,
  payload: Type.Union([
    Strict({ type: Type.Literal("message"), message: MessageSchema }),
    Strict({ type: Type.Literal("compaction"), summary: Type.String() }),
  ]),
});
export type EntryDto = Static<typeof EntrySchema>;

const PendingResponseSchema = Strict({
  operationId: StoredIdSchema,
  responseEntryId: EntryIdSchema,
  content: Type.Array(ContentBlockSchema),
  stopReason: Nullable(Type.String()),
  errorMessage: Nullable(Type.String()),
});
export type PendingResponseDto = Static<typeof PendingResponseSchema>;

export const LaneSnapshotSchema = Strict({
  version: Type.Integer({ minimum: 0 }),
  lane: StoredIdSchema,
  tipId: Nullable(EntryIdSchema),
  phase: Nullable(Type.Union([
    Type.Literal("starting"),
    Type.Literal("checkpoint"),
    Type.Literal("assistant_ready"),
    Type.Literal("assistant_effect_pending"),
    Type.Literal("retry_wait"),
    Type.Literal("tools"),
    Type.Literal("summary_deciding"),
    Type.Literal("summary_effect_pending"),
    Type.Literal("navigation_ready"),
  ])),
  operationId: Nullable(StoredIdSchema),
  lastOperationId: Nullable(StoredIdSchema),
  status: Nullable(Type.Union([Type.Literal("open"), Type.Literal("aborting")])),
  entries: Type.Array(EntrySchema),
  pendingResponse: Nullable(PendingResponseSchema),
});
export type LaneSnapshotDto = Static<typeof LaneSnapshotSchema>;

/**
 * Subscription updates: a complete newer snapshot, or the service ending the subscription on its side
 * (`runtime_closed`, `snapshot_failed`, `snapshot_unavailable`). After `ended` nothing else arrives.
 */
export const LaneUpdateSchema = Type.Union([
  Strict({ kind: Type.Literal("snapshot"), snapshot: LaneSnapshotSchema }),
  Strict({ kind: Type.Literal("ended"), code: Type.String({ minLength: 1 }), message: Type.String() }),
]);
export type LaneUpdateDto = Static<typeof LaneUpdateSchema>;

const OperationKindSchema = Type.Union([Type.Literal("run"), Type.Literal("compaction"), Type.Literal("navigation")]);
export const OperationResultSchema = Strict({
  operationId: StoredIdSchema,
  lane: StoredIdSchema,
  kind: OperationKindSchema,
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("aborted")]),
  fromTipId: Nullable(EntryIdSchema),
  tipId: Nullable(EntryIdSchema),
  startedAt: Time,
  endedAt: Time,
  error: Type.Optional(Type.String()),
});
export type OperationResultDto = Static<typeof OperationResultSchema>;

export const OperationAdmissionSchema = Strict({ operationId: StoredIdSchema, kind: OperationKindSchema, startedAt: Time });
export type OperationAdmissionDto = Static<typeof OperationAdmissionSchema>;

export const DriveOutcomeSchema = Type.Union([
  Strict({ kind: Type.Literal("settled"), result: OperationResultSchema }),
  Strict({ kind: Type.Literal("waiting"), operationId: StoredIdSchema, reason: Type.Literal("retry"), notBefore: Time }),
]);
export type DriveOutcomeDto = Static<typeof DriveOutcomeSchema>;

export const ResultReplySchema = Strict({ result: Nullable(OperationResultSchema) });
export const EnqueuedReplySchema = Strict({ entryId: EntryIdSchema });
export const AbortReplySchema = Strict({ operationId: StoredIdSchema, newlyRequested: Type.Boolean() });
export const AttachReplySchema = Strict({ attached: Type.Literal(true) });
export const EmptyReplySchema = Type.Union([Type.Null(), Type.Undefined()]);

/**
 * Error codes a runtime call can answer with. Lane failures keep the Durable failure code. `cancelled` means an
 * RPC wait stopped, never that an operation was aborted. The rest come from the generic server's routing,
 * subscription and admission limits.
 */
export const RUNTIME_ERROR_CODES = [
  "invalid_call",
  "unknown_lane",
  "unknown_subscription",
  "runtime_closed",
  "cancelled",
  "drive_failed",
  "lane_busy",
  "invalid_message",
  "unknown_target",
  "operation_mismatch",
  "closed",
  "nothing_to_compact",
  "no_active_operation",
  "unknown_runtime",
  "wrong_server",
  "not_attached",
  "stale_attachment",
  "too_many_requests",
  "duplicate_subscription",
  "too_many_subscriptions",
  "invalid_subscription",
  "connection_closed",
  "call_settled",
  "internal",
] as const;
export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

/** A payload that does not match this contract. */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export function parse<T extends TSchema>(schema: T, value: unknown, label: string): Static<T> {
  if (!Check(schema, value)) throw new ContractError(`invalid ${label}`);
  return value as Static<T>;
}

export const parseRuntimeCall = (value: JsonValue): RuntimeCall => parse(RuntimeCallSchema, value, "runtime call");
export const parseManagementCall = (value: JsonValue): ManagementCall => parse(ManagementCallSchema, value, "management call");
export const parseLaneSnapshot = (value: unknown): LaneSnapshotDto => parse(LaneSnapshotSchema, value, "lane snapshot");
export const parseLaneUpdate = (value: unknown): LaneUpdateDto => parse(LaneUpdateSchema, value, "lane update");
