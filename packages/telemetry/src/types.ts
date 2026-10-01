export type AttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];
export interface SpanAttributes { [name: string]: AttributeValue | undefined }
export interface SpanOptions { name: string; attributes?: SpanAttributes }
export type SpanStatus = { status: "ok" } | { status: "error"; error?: { name: string; message: string } };

/** Invoke the callback synchronously once; preserve its result and rejection, recording passively. */
export interface TelemetryContext {
  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

/** Recording methods are synchronous and non-throwing; calls after settlement are inert. */
export interface TelemetrySpan extends TelemetryContext {
  addEvent(name: string, attributes?: SpanAttributes): void;
  setAttributes(attributes: SpanAttributes): void;
  setStatus(status: SpanStatus): void;
}

export interface RecordedTelemetrySpan {
  id: number;
  parentId: number | null;
  name: string;
  attributes: SpanAttributes;
  events: Array<{ name: string; attributes: SpanAttributes }>;
  status: SpanStatus;
  settled: boolean;
}
