import { NOOP_TELEMETRY_CONTEXT } from "./noop.ts";
import type { AttributeValue, RecordedTelemetrySpan, SpanAttributes, SpanOptions, SpanStatus, TelemetryContext, TelemetrySpan } from "./types.ts";

function isPrimitive(item: unknown): boolean {
  return typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item));
}

function copyAttributes(attributes: SpanAttributes = {}): SpanAttributes {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined).map(([key, value]) => {
    if (Array.isArray(value)) {
      const copied: unknown[] = [...value];
      if (!copied.every((item) => isPrimitive(item) && typeof item === typeof copied[0])) throw new TypeError("invalid telemetry attribute");
      return [key, copied as AttributeValue];
    }
    if (!isPrimitive(value)) throw new TypeError("invalid telemetry attribute");
    return [key, value];
  }));
}

function copyStatus(status: SpanStatus): SpanStatus {
  if (status.status === "ok") return { status: "ok" };
  if (status.status !== "error") throw new TypeError("invalid telemetry status");
  const error = status.error;
  if (!error) return { status: "error" };
  if (typeof error.name !== "string" || typeof error.message !== "string") throw new TypeError("invalid telemetry error");
  return { status: "error", error: { name: error.name, message: error.message } };
}

/** Process-local recording, with detached snapshots and explicit parentage. No runtime dependencies. */
export class InMemoryTelemetryContext implements TelemetryContext {
  private readonly records: RecordedTelemetrySpan[] = [];

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return this.record(undefined, options, callback);
  }

  private record<T>(parent: RecordedTelemetrySpan | undefined, options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    if (parent?.settled) return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);
    let record: RecordedTelemetrySpan;
    try {
      const name = options.name;
      if (typeof name !== "string" || !name) throw new TypeError("invalid span name");
      record = {
        id: this.records.length + 1, parentId: parent?.id ?? null, name,
        attributes: copyAttributes(options.attributes), events: [], status: { status: "ok" }, settled: false,
      };
      this.records.push(record);
    } catch { return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback); }
    let explicit = false;
    const span: TelemetrySpan = {
      startSpan: (childOptions, child) => this.record(record, childOptions, child),
      addEvent(name, attributes) {
        if (record.settled) return;
        try {
          if (typeof name !== "string" || !name) return;
          record.events.push({ name, attributes: copyAttributes(attributes) });
        } catch {}
      },
      setAttributes(attributes) {
        if (record.settled) return;
        try { record.attributes = { ...record.attributes, ...copyAttributes(attributes) }; } catch {}
      },
      setStatus(status) {
        if (record.settled) return;
        try { record.status = copyStatus(status); explicit = true; } catch {}
      },
    };
    const settle = (failed: boolean) => {
      if (!explicit) record.status = { status: failed ? "error" : "ok" };
      record.settled = true;
    };
    try {
      return Promise.resolve(callback(span)).then(
        (value) => { settle(false); return value; },
        (error: unknown) => { settle(true); throw error; },
      );
    } catch (error) { settle(true); return Promise.reject(error); }
  }

  getSpans(): RecordedTelemetrySpan[] {
    return this.records.map((record) => ({
      ...record, attributes: copyAttributes(record.attributes), status: copyStatus(record.status),
      events: record.events.map((event) => ({ name: event.name, attributes: copyAttributes(event.attributes) })),
    }));
  }
}
