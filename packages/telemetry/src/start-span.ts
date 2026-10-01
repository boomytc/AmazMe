import { NOOP_TELEMETRY_CONTEXT } from "./noop.ts";
import type { SpanOptions, TelemetryContext, TelemetrySpan } from "./types.ts";

/**
 * Passive adapter boundary. Business work owns its promise, executes once, and never waits
 * for an exporter. A faulty, delayed, or duplicate adapter callback cannot repeat the work.
 */
export function startSpan<T>(
  context: TelemetryContext | undefined,
  options: SpanOptions,
  callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
  let invoked = false;
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const result = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  const invoke = (span: TelemetrySpan): Promise<T> => {
    if (invoked) return result;
    invoked = true;
    let active = true;
    const passive: TelemetrySpan = {
      startSpan: (childOptions, child) => startSpan(active ? span : undefined, childOptions, child),
      addEvent(name, attributes) { if (active) { try { span.addEvent(name, attributes); } catch {} } },
      setAttributes(attributes) { if (active) { try { span.setAttributes(attributes); } catch {} } },
      setStatus(status) { if (active) { try { span.setStatus(status); } catch {} } },
    };
    try {
      Promise.resolve(callback(passive)).then(
        (value) => { active = false; resolve(value); },
        (error: unknown) => { active = false; reject(error); },
      );
    } catch (error) { active = false; reject(error); }
    return result;
  };
  try {
    void Promise.resolve((context ?? NOOP_TELEMETRY_CONTEXT).startSpan(options, invoke)).catch(() => {});
  } catch {}
  if (!invoked) void NOOP_TELEMETRY_CONTEXT.startSpan(options, invoke).catch(() => {});
  return result;
}
