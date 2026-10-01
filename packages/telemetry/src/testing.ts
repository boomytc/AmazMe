import assert from "node:assert/strict";
import type { SpanAttributes, TelemetryContext, TelemetrySpan } from "./types.ts";

export interface TelemetryConformanceCase { name: string; run(): Promise<void> }
export interface TelemetryFixture { context: TelemetryContext; dispose?(): void | Promise<void> }

/** Runner-neutral adapter checks. Each case owns a fresh context; only this entry needs Node. */
export function createTelemetryConformance(factory: () => TelemetryFixture | Promise<TelemetryFixture>): TelemetryConformanceCase[] {
  const cases: Array<{ name: string; run(context: TelemetryContext): Promise<void> }> = [
    {
      name: "callback executes synchronously once and preserves the result identity",
      async run(context) {
        const value = {};
        let calls = 0;
        const pending = context.startSpan({ name: "test" }, () => { calls++; return value; });
        assert.equal(calls, 1);
        assert.equal(await pending, value);
        assert.equal(calls, 1);
      },
    },
    {
      name: "sync throws and async rejections preserve the original error",
      async run(context) {
        const error = {};
        await assert.rejects(context.startSpan({ name: "sync" }, () => { throw error; }), (caught) => caught === error);
        await assert.rejects(context.startSpan({ name: "async" }, () => Promise.reject(error)), (caught) => caught === error);
      },
    },
    {
      name: "async work remains pending until its own completion",
      async run(context) {
        let release: (value: object) => void = () => {};
        const work = new Promise<object>((resolve) => { release = resolve; });
        let settled = false;
        const pending = context.startSpan({ name: "async" }, () => work);
        void pending.then(() => { settled = true; });
        await Promise.resolve();
        assert.equal(settled, false);
        const value = {};
        release(value);
        assert.equal(await pending, value);
      },
    },
    {
      name: "nested callbacks preserve both success and failure",
      async run(context) {
        const value = {};
        const error = {};
        await context.startSpan({ name: "parent" }, async (span) => {
          assert.equal(await span.startSpan({ name: "child" }, () => value), value);
          await assert.rejects(span.startSpan({ name: "failed" }, () => { throw error; }), (caught) => caught === error);
        });
      },
    },
    {
      name: "malformed diagnostics do not throw or suppress business work",
      async run(context) {
        const malformed = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("bad diagnostic"); } }) as SpanAttributes;
        let calls = 0;
        const value = {};
        assert.equal(await context.startSpan({ name: "invalid", attributes: malformed }, () => { calls++; return value; }), value);
        assert.equal(calls, 1);
        await context.startSpan({ name: "record" }, (span) => {
          span.setAttributes(malformed);
          span.addEvent("event", malformed);
          span.setStatus(Object.defineProperty({}, "status", { get() { throw new Error("bad status"); } }) as never);
        });
      },
    },
    {
      name: "recording calls and child business work remain safe after settlement",
      async run(context) {
        let span: TelemetrySpan | undefined;
        await context.startSpan({ name: "parent" }, (current) => { span = current; });
        assert.ok(span);
        span.addEvent("late");
        span.setAttributes({ late: true });
        span.setStatus({ status: "error" });
        assert.equal(await span.startSpan({ name: "late child" }, () => 42), 42);
      },
    },
  ];
  return cases.map(({ name, run }) => ({ name, async run() {
    const fixture = await factory();
    try { await run(fixture.context); }
    finally { await fixture.dispose?.(); }
  } }));
}
