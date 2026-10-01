import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT, startSpan, type SpanAttributes, type TelemetryContext, type TelemetrySpan } from "@amazme/telemetry";
import { createTelemetryConformance } from "@amazme/telemetry/testing";

for (const [name, factory] of [
  ["noop", () => ({ context: NOOP_TELEMETRY_CONTEXT })],
  ["memory", () => ({ context: new InMemoryTelemetryContext() })],
] as const) {
  for (const check of createTelemetryConformance(factory)) test(`${name}: ${check.name}`, check.run);
}

test("memory snapshots detach arrays, statuses and events, merging only defined attributes", async () => {
  const context = new InMemoryTelemetryContext();
  const list = [1, 2];
  let span: TelemetrySpan | undefined;
  await context.startSpan({ name: "root", attributes: { list, kept: 1 } }, (current) => {
    span = current;
    list.push(3);
    current.setAttributes({ kept: undefined, added: true });
    current.setAttributes(Object.fromEntries([["__proto__", "safe"]]));
    current.addEvent("first", { list });
    current.addEvent("second");
    current.setStatus({ status: "error", error: { name: "test", message: "explicit" } });
  });
  const snapshot = context.getSpans();
  const root = snapshot[0]!;
  assert.deepEqual(root.attributes.list, [1, 2]);
  assert.equal(root.attributes.kept, 1);
  assert.equal(root.attributes.added, true);
  assert.equal(root.attributes.__proto__, "safe");
  (root.attributes.list as number[]).push(99);
  (root.events[0]!.attributes.list as number[]).push(99);
  assert.equal(root.status.status, "error");
  if (root.status.status === "error") root.status.error!.message = "changed";
  root.events.push({ name: "changed", attributes: {} });
  span!.addEvent("late");
  span!.setStatus({ status: "ok" });
  span!.setAttributes({ late: true });
  await span!.startSpan({ name: "late child" }, () => 42);
  assert.equal(context.getSpans().length, 1);
  assert.deepEqual(context.getSpans()[0]!.attributes.list, [1, 2]);
  assert.deepEqual(context.getSpans()[0]!.events.map((event) => event.name), ["first", "second"]);
  assert.deepEqual(context.getSpans()[0]!.events[0]!.attributes.list, [1, 2, 3]);
  assert.deepEqual(context.getSpans()[0]!.status, { status: "error", error: { name: "test", message: "explicit" } });
});

test("concurrent nested spans keep explicit parents and default failure status without error contents", async () => {
  const context = new InMemoryTelemetryContext();
  const error = new Error("private error");
  await Promise.all(["a", "b"].map((name) => context.startSpan({ name }, async (span) => {
    await Promise.resolve();
    await span.startSpan({ name: `${name}.child` }, () => 42);
    await assert.rejects(span.startSpan({ name: `${name}.error` }, () => { throw error; }), (caught) => caught === error);
  })));
  const records = context.getSpans();
  for (const name of ["a", "b"]) {
    const parent = records.find((record) => record.name === name)!;
    assert.equal(records.find((record) => record.name === `${name}.child`)!.parentId, parent.id);
    assert.deepEqual(records.find((record) => record.name === `${name}.error`)!.status, { status: "error" });
  }
  assert.ok(records.every((record) => record.settled));
  assert.doesNotMatch(JSON.stringify(records), /private error/);
});

test("invalid attributes are ignored atomically and explicit status uses the last valid call", async () => {
  const context = new InMemoryTelemetryContext();
  await context.startSpan({ name: "root" }, (span) => {
    span.setAttributes({ valid: true, invalid: Infinity });
    span.addEvent("invalid", { mixed: ["a", 1] } as unknown as SpanAttributes);
    span.setAttributes({ sparse: new Array<number>(3) });
    span.setStatus({ status: "error" });
    span.setStatus({ status: "ok" });
    span.setStatus({ status: "other" } as never);
  });
  assert.deepEqual(context.getSpans()[0]!.attributes, {});
  assert.deepEqual(context.getSpans()[0]!.events, []);
  assert.deepEqual(context.getSpans()[0]!.status, { status: "ok" });
});

const brokenSpan: TelemetrySpan = {
  startSpan() { throw new Error("child exporter failed"); },
  addEvent() { throw new Error("event exporter failed"); },
  setAttributes() { throw new Error("attributes exporter failed"); },
  setStatus() { throw new Error("status exporter failed"); },
};

const adapters: Array<[string, TelemetryContext]> = [
  ["throwing context getter", Object.defineProperty({}, "startSpan", { get() { throw new Error("context failed"); } }) as TelemetryContext],
  ["throwing span getters", { startSpan(_options, callback) {
    return callback(Object.defineProperties({}, Object.fromEntries(["startSpan", "addEvent", "setStatus", "setAttributes"].map((name) =>
      [name, { get() { throw new Error("span failed"); } }]))) as TelemetrySpan) as Promise<never>;
  } }],
  ["startup throw", { startSpan() { throw new Error("startup failed"); } }],
  ["rejection before callback", { startSpan() { return Promise.reject(new Error("export failed")); } }],
  ["recording failures", { startSpan(_options, callback) { return callback(brokenSpan) as Promise<never>; } }],
  ["throw after callback", { startSpan(_options, callback) { void callback(brokenSpan); throw new Error("export failed"); } }],
  ["duplicate callback and wrong result", { startSpan(_options, callback) { void callback(brokenSpan); void callback(brokenSpan); return Promise.resolve("wrong") as Promise<never>; } }],
  ["export never settles", { startSpan(_options, callback) { void callback(brokenSpan); return new Promise(() => {}); } }],
  ["delayed callback", { startSpan(_options, callback) { queueMicrotask(() => { void callback(brokenSpan); }); return Promise.resolve(undefined) as Promise<never>; } }],
];

for (const [name, context] of adapters) {
  test(`passive boundary: ${name} cannot change or repeat business work`, async () => {
    let calls = 0;
    let children = 0;
    const value = {};
    assert.equal(await startSpan(context, { name: "business" }, async (span) => {
      calls++;
      span.addEvent("event");
      span.setAttributes({ test: true });
      span.setStatus({ status: "error" });
      await span.startSpan({ name: "child" }, () => { children++; });
      return value;
    }), value);
    assert.equal(calls, 1);
    assert.equal(children, 1);
    const error = {};
    await assert.rejects(startSpan(context, { name: "failure" }, () => { throw error; }), (caught) => caught === error);
  });
}
