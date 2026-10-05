import type { JsonValue } from "@amazme/protocol";
import Type, { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

const Strict = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** Lane names are service data: the runtime decides which lanes exist; the protocol never sees them. */
export const LaneNameSchema = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" });
export const OperationIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
/** References can name operations admitted in process; only the storage separator is reserved. */
const OperationReferenceSchema = Type.String({ minLength: 1, pattern: "^[^\\u0000]+$" });
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
const DriveCall = Strict({ method: Type.Literal("drive"), lane: LaneNameSchema, operationId: OperationReferenceSchema, waitForRetry: Type.Optional(Type.Boolean()) });
const SnapshotCall = Strict({ method: Type.Literal("snapshot"), lane: LaneNameSchema });
const HistoryCall = Strict({
  method: Type.Literal("history"),
  lane: LaneNameSchema,
  before: Nullable(EntryIdSchema),
  limit: Type.Integer({ minimum: 1, maximum: 100 }),
});
const ResultCall = Strict({ method: Type.Literal("result"), lane: LaneNameSchema, operationId: OperationReferenceSchema });
const SteerCall = Strict({ method: Type.Literal("steer"), lane: LaneNameSchema, text: Text });
const FollowUpCall = Strict({ method: Type.Literal("followUp"), lane: LaneNameSchema, text: Text });
const RequestAbortCall = Strict({ method: Type.Literal("requestAbort"), lane: LaneNameSchema, operationId: OperationReferenceSchema });
const SubscribeCall = Strict({ method: Type.Literal("subscribe"), lane: LaneNameSchema, subscriptionId: SubscriptionIdSchema });
const UnsubscribeCall = Strict({ method: Type.Literal("unsubscribe"), subscriptionId: SubscriptionIdSchema });
const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);
const ConfigureCall = Strict({
  method: Type.Literal("configure"),
  lane: LaneNameSchema,
  provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
});
const CatalogCall = Strict({ method: Type.Literal("catalog"), lane: LaneNameSchema });
const ForkCall = Strict({
  method: Type.Literal("fork"),
  lane: LaneNameSchema,
  name: LaneNameSchema,
  entryId: Nullable(EntryIdSchema),
});
const ImportMessageSchema = Strict({
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  text: Text,
});
const ImportCall = Strict({
  method: Type.Literal("import"),
  lane: LaneNameSchema,
  name: LaneNameSchema,
  messages: Type.Array(ImportMessageSchema, { minItems: 1, maxItems: 200 }),
});
const ConversationsCall = Strict({ method: Type.Literal("conversations") });
/** Calls on a runtime route. Lane calls name their lane; unsubscribe and conversations do not. */
export const RuntimeCallSchema = Type.Union([
  AcceptCall, DriveCall, SnapshotCall, HistoryCall, ResultCall, SteerCall, FollowUpCall, RequestAbortCall,
  ConfigureCall, CatalogCall, ForkCall, ImportCall, SubscribeCall, UnsubscribeCall, ConversationsCall,
]);
export type RuntimeCall = Static<typeof RuntimeCallSchema>;

/** Calls on the server route. `remove` deletes one runtime the host offered; it is not a directory API. */
export const ManagementCallSchema = Type.Union([
  Strict({ method: Type.Literal("attach"), runtimeId: RuntimeIdSchema }),
  Strict({ method: Type.Literal("detach") }),
  Strict({ method: Type.Literal("remove"), runtimeId: RuntimeIdSchema }),
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

const ToolActivitySchema = Strict({
  toolCallId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("planned"), Type.Literal("running"), Type.Literal("settled")]),
});
export type ToolActivityDto = Static<typeof ToolActivitySchema>;

/**
 * One turn's USD charges. Same fields as `usageCost`'s return value.
 * The protocol copies this object. It does not price tokens.
 */
export const UsageCostSchema = Strict({
  input: Type.Number(),
  cacheRead: Nullable(Type.Number()),
  cacheWrite: Type.Number(),
  output: Type.Number(),
  total: Nullable(Type.Number()),
});
export type UsageCostDto = Static<typeof UsageCostSchema>;

/**
 * Cumulative charges. Each amount may be null when that part of the sum is unknown.
 * `usageCost` itself returns null for a turn with no price list; a sum of those turns widens each field.
 */
export const CumulativeCostSchema = Strict({
  input: Nullable(Type.Number()),
  cacheRead: Nullable(Type.Number()),
  cacheWrite: Nullable(Type.Number()),
  output: Nullable(Type.Number()),
  total: Nullable(Type.Number()),
});
export type CumulativeCostDto = Static<typeof CumulativeCostSchema>;

const TurnUsageSchema = Strict({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Nullable(Type.Number()),
  cacheWrite: Nullable(Type.Number()),
  /** Already included in `output`. Omitted when the row did not report it. */
  reasoning: Type.Optional(Type.Number()),
  hitRate: Nullable(Type.Number()),
  cost: Nullable(UsageCostSchema),
});
export type TurnUsageDto = Static<typeof TurnUsageSchema>;

const TotalUsageSchema = Strict({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Nullable(Type.Number()),
  cacheWrite: Nullable(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
  hitRate: Nullable(Type.Number()),
  cost: Nullable(CumulativeCostSchema),
});
export type TotalUsageDto = Static<typeof TotalUsageSchema>;

/**
 * Footer data beside the lane snapshot.
 * `usage` is `usage()`. `notBefore`, `retryReason`, and `compacting` are `laneStatus()`.
 * Branch and the two clocks come from the host. Nothing here is Durable private state.
 */
export const ActivitySchema = Strict({
  branch: Nullable(Type.String({ minLength: 1, maxLength: 1024 })),
  sessionStartedAt: Nullable(Time),
  turnStartedAt: Nullable(Time),
  notBefore: Nullable(Time),
  retryReason: Nullable(Type.String({ maxLength: 1_000_000 })),
  compacting: Type.Boolean(),
  usage: Strict({
    lastTurn: Nullable(TurnUsageSchema),
    total: TotalUsageSchema,
  }),
});
export type ActivityDto = Static<typeof ActivitySchema>;

const LaneViewFields = {
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
  tools: Type.Array(ToolActivitySchema),
  activity: ActivitySchema,
};

/** No branch, no clocks, no retry, and no priced usage. */
export function emptyActivity(): ActivityDto {
  return {
    branch: null,
    sessionStartedAt: null,
    turnStartedAt: null,
    notBefore: null,
    retryReason: null,
    compacting: false,
    usage: {
      lastTurn: null,
      total: { input: 0, output: 0, cacheRead: null, cacheWrite: null, hitRate: null, cost: null },
    },
  };
}

/** The full ancestor chain when it fits in one frame. `tools` is only the open batch. */
export const LaneSnapshotSchema = Strict(LaneViewFields);
export type LaneSnapshotDto = Static<typeof LaneSnapshotSchema>;

/**
 * One observation frame. `entries` is a suffix of the ancestor chain.
 * `omitted` entries are older and still readable with `history`.
 * `skipped` entries cannot fit in a frame even alone.
 * `pendingOmitted` means the unsettled reply was left out of this frame.
 */
export const LaneWindowSchema = Strict({
  ...LaneViewFields,
  omitted: Type.Integer({ minimum: 0 }),
  skipped: Type.Integer({ minimum: 0 }),
  pendingOmitted: Type.Boolean(),
});
export type LaneWindowDto = Static<typeof LaneWindowSchema>;

export const HistoryPageSchema = Strict({
  entries: Type.Array(EntrySchema),
  older: Type.Integer({ minimum: 0 }),
  skipped: Type.Integer({ minimum: 0 }),
});
export type HistoryPageDto = Static<typeof HistoryPageSchema>;

/**
 * Subscription updates: a bounded window, or the service ending the subscription
 * (`runtime_closed`, `snapshot_failed`, `snapshot_unavailable`). After `ended` nothing else arrives.
 */
export const LaneUpdateSchema = Type.Union([
  Strict({ kind: Type.Literal("advance"), advance: LaneWindowSchema }),
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
  "runtime_busy",
  "storage_busy",
  "wrong_server",
  "not_attached",
  "stale_attachment",
  "too_many_requests",
  "duplicate_subscription",
  "too_many_subscriptions",
  "invalid_subscription",
  "connection_closed",
  "call_settled",
  "snapshot_unavailable",
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

export const ConversationsReplySchema = Strict({ lanes: Type.Array(LaneNameSchema) });
export type ConversationsReply = Static<typeof ConversationsReplySchema>;

export const LaneSettingsSchema = Strict({
  provider: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  thinkingLevel: ThinkingLevelSchema,
  thinkingLevels: Type.Array(ThinkingLevelSchema),
});
export type LaneSettingsDto = Static<typeof LaneSettingsSchema>;

export const CatalogReplySchema = Strict({
  directory: Type.String(),
  models: Type.Array(Strict({ provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) })),
  thinkingLevels: Type.Array(ThinkingLevelSchema),
});
export type CatalogReplyDto = Static<typeof CatalogReplySchema>;

export const ForkReplySchema = Strict({ lane: LaneNameSchema });
export type ForkReplyDto = Static<typeof ForkReplySchema>;
export const ImportReplySchema = Strict({ lane: LaneNameSchema, tipId: Nullable(EntryIdSchema) });
export type ImportReplyDto = Static<typeof ImportReplySchema>;

export const parseRuntimeCall = (value: JsonValue): RuntimeCall => parse(RuntimeCallSchema, value, "runtime call");
export const parseManagementCall = (value: JsonValue): ManagementCall => parse(ManagementCallSchema, value, "management call");
export const parseLaneSnapshot = (value: unknown): LaneSnapshotDto => parse(LaneSnapshotSchema, value, "lane snapshot");
export const parseLaneWindow = (value: unknown): LaneWindowDto => parse(LaneWindowSchema, value, "lane window");
export const parseLaneUpdate = (value: unknown): LaneUpdateDto => parse(LaneUpdateSchema, value, "lane update");
