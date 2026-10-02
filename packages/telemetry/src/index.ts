export type { AttributeValue, RecordedTelemetrySpan, SpanAttributes, SpanOptions, SpanStatus, TelemetryContext, TelemetrySpan } from "./types.ts";
export { NOOP_TELEMETRY_CONTEXT } from "./noop.ts";
export { InMemoryTelemetryContext } from "./memory.ts";
export { startSpan } from "./start-span.ts";
export {
  createTypedSpanStarter,
  defineTelemetrySchema,
  type ExactTelemetryAttributes,
  type SchemaTelemetrySpan,
  type TelemetryAttributeDefinition,
  type TelemetryEventAttributeDefinition,
  type TelemetryEventDefinition,
  type TelemetryParentDefinition,
  type TelemetrySchemaDefinition,
  type TelemetrySchemaSpanEndAttributes,
  type TelemetrySchemaSpanEventAttributes,
  type TelemetrySchemaSpanEventName,
  type TelemetrySchemaSpanName,
  type TelemetrySchemaSpanStartAttributes,
  type TelemetrySpanDefinition,
  type TelemetryStartAttributeDefinition,
  type TypedSpanStarter,
} from "./schema.ts";
