import type { TelemetryContext, TelemetrySpan } from "./types.ts";

const inert: TelemetrySpan = Object.freeze({
  startSpan<T>(_options: unknown, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    try { return Promise.resolve(callback(inert)); }
    catch (error) { return Promise.reject(error); }
  },
  addEvent() {}, setAttributes() {}, setStatus() {},
});

/** Does not inspect or retain diagnostic payloads. */
export const NOOP_TELEMETRY_CONTEXT: TelemetryContext = inert;
