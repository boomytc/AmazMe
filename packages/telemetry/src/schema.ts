import { startSpan } from "./start-span.ts";
import type { SpanAttributes, TelemetryContext, TelemetrySpan } from "./types.ts";

export type TelemetryAttributeType = "string" | "number" | "boolean" | "string[]" | "number[]" | "boolean[]";

export interface TelemetryAttributeMetadata {
  description: string;
  sensitive?: boolean;
  cardinality?: "low" | "high";
}

export type TelemetryAttributeDefinition = TelemetryAttributeMetadata &
  (
    | { type: "string"; values?: readonly string[]; examples?: readonly string[] }
    | { type: "number"; values?: readonly number[]; examples?: readonly number[] }
    | { type: "boolean"; values?: readonly boolean[]; examples?: readonly boolean[] }
    | { type: "string[]"; elementValues?: readonly string[]; examples?: readonly (readonly string[])[] }
    | { type: "number[]"; elementValues?: readonly number[]; examples?: readonly (readonly number[])[] }
    | { type: "boolean[]"; elementValues?: readonly boolean[]; examples?: readonly (readonly boolean[])[] }
  );

export type TelemetryStartAttributeDefinition = TelemetryAttributeDefinition & { required: boolean };
export type TelemetryEventAttributeDefinition = TelemetryAttributeDefinition & { required: boolean };

export interface TelemetryEventDefinition {
  description: string;
  attributes: Record<string, TelemetryEventAttributeDefinition>;
}

export type TelemetryParentDefinition =
  | { kind: "any" }
  | { kind: "root_or_external" }
  | { kind: "spans"; spans: readonly string[] };

export interface TelemetrySpanDefinition {
  description: string;
  parents: TelemetryParentDefinition;
  startAttributes: Record<string, TelemetryStartAttributeDefinition>;
  endAttributes: Record<string, TelemetryAttributeDefinition>;
  events?: Record<string, TelemetryEventDefinition>;
  status: { default: "ok"; errorWhen: string };
}

export interface TelemetrySchemaDefinition {
  version: number;
  spans: Record<string, TelemetrySpanDefinition>;
}

/** Keeps the schema value as its literal type. The value is data, not a validator. */
export function defineTelemetrySchema<const T extends TelemetrySchemaDefinition>(schema: T): T {
  return schema;
}

type AttributeDefinitionValue<Definition extends TelemetryAttributeDefinition> = Definition extends {
  type: "string";
  values: readonly (infer Value extends string)[];
}
  ? Value
  : Definition extends { type: "string" }
    ? string
    : Definition extends { type: "number"; values: readonly (infer Value extends number)[] }
      ? Value
      : Definition extends { type: "number" }
        ? number
        : Definition extends { type: "boolean"; values: readonly (infer Value extends boolean)[] }
          ? Value
          : Definition extends { type: "boolean" }
            ? boolean
            : Definition extends { type: "string[]"; elementValues: readonly (infer Value extends string)[] }
              ? readonly Value[]
              : Definition extends { type: "string[]" }
                ? readonly string[]
                : Definition extends { type: "number[]"; elementValues: readonly (infer Value extends number)[] }
                  ? readonly Value[]
                  : Definition extends { type: "number[]" }
                    ? readonly number[]
                    : Definition extends { type: "boolean[]"; elementValues: readonly (infer Value extends boolean)[] }
                      ? readonly Value[]
                      : readonly boolean[];

type RequiredAttributeNames<
  Definitions extends Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>,
> = {
  [Name in keyof Definitions]-?: Definitions[Name]["required"] extends true ? Name : never;
}[keyof Definitions];

type OptionalAttributeNames<
  Definitions extends Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>,
> = Exclude<keyof Definitions, RequiredAttributeNames<Definitions>>;

export type InferRequiredAndOptionalAttributes<
  Definitions extends Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>,
> = keyof Definitions extends never
  ? Record<string, never>
  : {
      [Name in RequiredAttributeNames<Definitions>]: AttributeDefinitionValue<Definitions[Name]>;
    } & {
      [Name in OptionalAttributeNames<Definitions>]?: AttributeDefinitionValue<Definitions[Name]>;
    };

export type InferOptionalAttributes<Definitions extends Record<string, TelemetryAttributeDefinition>> =
  keyof Definitions extends never
    ? Record<string, never>
    : { [Name in keyof Definitions]?: AttributeDefinitionValue<Definitions[Name]> };

export type ExactTelemetryAttributes<Expected, Actual extends Expected> = Actual &
  Record<Exclude<keyof Actual, keyof Expected>, never>;

type TelemetrySchemaTuple = readonly [TelemetrySchemaDefinition, ...TelemetrySchemaDefinition[]];

export type TelemetrySchemaSpanName<Schema extends TelemetrySchemaDefinition> = keyof Schema["spans"] & string;

type SchemaSpan<Schema extends TelemetrySchemaDefinition, Name extends TelemetrySchemaSpanName<Schema>> = Schema["spans"][Name];

export type TelemetrySchemaSpanStartAttributes<
  Schema extends TelemetrySchemaDefinition,
  Name extends TelemetrySchemaSpanName<Schema>,
> = SchemaSpan<Schema, Name>["startAttributes"] extends infer Definitions extends Record<string, TelemetryStartAttributeDefinition>
  ? InferRequiredAndOptionalAttributes<Definitions>
  : never;

export type TelemetrySchemaSpanEndAttributes<
  Schema extends TelemetrySchemaDefinition,
  Name extends TelemetrySchemaSpanName<Schema>,
> = SchemaSpan<Schema, Name>["endAttributes"] extends infer Definitions extends Record<string, TelemetryAttributeDefinition>
  ? InferOptionalAttributes<Definitions>
  : never;

type SchemaSpanEvents<Schema extends TelemetrySchemaDefinition, Name extends TelemetrySchemaSpanName<Schema>> =
  SchemaSpan<Schema, Name> extends { events: infer Events extends Record<string, TelemetryEventDefinition> }
    ? Events
    : Record<never, never>;

export type TelemetrySchemaSpanEventName<
  Schema extends TelemetrySchemaDefinition,
  Name extends TelemetrySchemaSpanName<Schema>,
> = keyof SchemaSpanEvents<Schema, Name> & string;

type SchemaSpanEvent<
  Schema extends TelemetrySchemaDefinition,
  Name extends TelemetrySchemaSpanName<Schema>,
  EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
> = SchemaSpanEvents<Schema, Name> extends infer Events
  ? EventName extends keyof Events
    ? Events[EventName]
    : never
  : never;

type SchemaSpanEventAttributeDefinitions<
  Schema extends TelemetrySchemaDefinition,
  Name extends TelemetrySchemaSpanName<Schema>,
  EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
> = SchemaSpanEvent<Schema, Name, EventName> extends {
  attributes: infer Definitions extends Record<string, TelemetryEventAttributeDefinition>;
}
  ? Definitions
  : Record<never, never>;

export type TelemetrySchemaSpanEventAttributes<
  Schema extends TelemetrySchemaDefinition,
  Name extends TelemetrySchemaSpanName<Schema>,
  EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
> = SchemaSpanEvent<Schema, Name, EventName> extends {
  attributes: infer Definitions extends Record<string, TelemetryEventAttributeDefinition>;
}
  ? InferRequiredAndOptionalAttributes<Definitions>
  : never;

type EventArguments<
  Definitions extends Record<string, TelemetryEventAttributeDefinition>,
  Attributes extends InferRequiredAndOptionalAttributes<Definitions>,
> = [RequiredAttributeNames<Definitions>] extends [never]
  ? [attributes?: ExactTelemetryAttributes<InferRequiredAndOptionalAttributes<Definitions>, Attributes>]
  : [attributes: ExactTelemetryAttributes<InferRequiredAndOptionalAttributes<Definitions>, Attributes>];

export type SchemaTelemetrySpan<Schema extends TelemetrySchemaDefinition, Name extends TelemetrySchemaSpanName<Schema>> =
  Omit<TelemetrySpan, "addEvent" | "setAttributes"> & {
    addEvent<
      EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
      const Attributes extends InferRequiredAndOptionalAttributes<SchemaSpanEventAttributeDefinitions<Schema, Name, EventName>> =
        InferRequiredAndOptionalAttributes<SchemaSpanEventAttributeDefinitions<Schema, Name, EventName>>,
    >(
      name: EventName,
      ...args: EventArguments<SchemaSpanEventAttributeDefinitions<Schema, Name, EventName>, Attributes>
    ): void;
    setAttributes<const Attributes extends TelemetrySchemaSpanEndAttributes<Schema, Name>>(
      attributes: ExactTelemetryAttributes<TelemetrySchemaSpanEndAttributes<Schema, Name>, Attributes>,
    ): void;
  };

type SpanNameInSchemas<Schemas extends TelemetrySchemaTuple> = {
  [Index in keyof Schemas]: Schemas[Index] extends TelemetrySchemaDefinition ? TelemetrySchemaSpanName<Schemas[Index]> : never;
}[number];

type SpanStartAttributesInSchema<Schema extends TelemetrySchemaDefinition, Name extends string> = Schema extends TelemetrySchemaDefinition
  ? Name extends TelemetrySchemaSpanName<Schema>
    ? TelemetrySchemaSpanStartAttributes<Schema, Name>
    : never
  : never;

type SpanInSchema<Schema extends TelemetrySchemaDefinition, Name extends string> = Schema extends TelemetrySchemaDefinition
  ? Name extends TelemetrySchemaSpanName<Schema>
    ? SchemaTelemetrySpan<Schema, Name>
    : never
  : never;

type DuplicateTelemetrySpanNames<Schemas extends readonly TelemetrySchemaDefinition[], Seen extends string = never> =
  Schemas extends readonly [infer Schema extends TelemetrySchemaDefinition, ...infer Rest extends readonly TelemetrySchemaDefinition[]]
    ? Extract<TelemetrySchemaSpanName<Schema>, Seen> | DuplicateTelemetrySpanNames<Rest, Seen | TelemetrySchemaSpanName<Schema>>
    : never;

type UniqueTelemetrySchemas<Schemas extends TelemetrySchemaTuple> = [DuplicateTelemetrySpanNames<Schemas>] extends [never]
  ? unknown
  : { readonly "duplicate telemetry span names": DuplicateTelemetrySpanNames<Schemas> };

type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (value: infer Intersection) => void
  ? Intersection
  : never;

type TypedSpanStarterForName<Schemas extends TelemetrySchemaTuple, Name extends SpanNameInSchemas<Schemas>> = <
  const Attributes extends SpanStartAttributesInSchema<Schemas[number], Name>,
  Result,
>(
  name: Name,
  attributes: ExactTelemetryAttributes<SpanStartAttributesInSchema<Schemas[number], Name>, Attributes>,
  callback: (span: SpanInSchema<Schemas[number], Name>, startChildSpan: TypedSpanStarter<Schemas>) => Result | Promise<Result>,
) => Promise<Result>;

/** One overload per span name, bound to an explicit context and one or more schemas. */
export type TypedSpanStarter<Schemas extends TelemetrySchemaTuple> = UnionToIntersection<
  { [Name in SpanNameInSchemas<Schemas>]: TypedSpanStarterForName<Schemas, Name> }[SpanNameInSchemas<Schemas>]
>;

function bindTypedSpanStarter<Schemas extends TelemetrySchemaTuple>(
  telemetryContext: TelemetryContext | undefined,
): TypedSpanStarter<Schemas> {
  const start = (
    name: string,
    attributes: SpanAttributes,
    callback: (span: TelemetrySpan, startChildSpan: TypedSpanStarter<Schemas>) => unknown,
  ): Promise<unknown> =>
    startSpan(telemetryContext, { name, attributes }, (span) => callback(span, bindTypedSpanStarter<Schemas>(span)));
  return start as TypedSpanStarter<Schemas>;
}

/**
 * Bind an explicit context to one or more span schemas.
 * The schema values are used for type inference only. This does not validate them,
 * and the call goes through the passive `startSpan` boundary.
 */
export function createTypedSpanStarter<const Schemas extends TelemetrySchemaTuple>(
  telemetryContext: TelemetryContext | undefined,
  _schemas: Schemas & UniqueTelemetrySchemas<Schemas>,
): TypedSpanStarter<Schemas> {
  return bindTypedSpanStarter<Schemas>(telemetryContext);
}
