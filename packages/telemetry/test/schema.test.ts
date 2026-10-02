import assert from "node:assert/strict";
import test from "node:test";
import {
  createTypedSpanStarter,
  defineTelemetrySchema,
  InMemoryTelemetryContext,
  type SchemaTelemetrySpan,
  type TelemetryContext,
  type TelemetrySpan,
} from "@amazme/telemetry";

const operationSchema = defineTelemetrySchema({
  version: 1,
  spans: {
    operation: {
      description: "Test operation",
      parents: { kind: "root_or_external" },
      startAttributes: {
        kind: { type: "string", required: true, values: ["read", "write"], description: "Kind", cardinality: "low" },
      },
      endAttributes: {},
      events: {
        result: {
          description: "Result",
          attributes: {
            outcome: { type: "string", required: true, values: ["ok", "error"], description: "Outcome", cardinality: "low" },
          },
        },
      },
      status: { default: "ok", errorWhen: "The operation fails" },
    },
  },
});

const requestSchema = defineTelemetrySchema({
  version: 1,
  spans: {
    request: {
      description: "Test request",
      parents: { kind: "spans", spans: ["operation"] },
      startAttributes: {
        provider: { type: "string", required: true, description: "Provider", cardinality: "low" },
      },
      endAttributes: {
        response: { type: "string", description: "Response kind", cardinality: "low" },
      },
      status: { default: "ok", errorWhen: "The request fails" },
    },
  },
});

test("a typed starter infers span attributes and records the child under its parent", async () => {
  assert.equal(JSON.parse(JSON.stringify(operationSchema)).version, 1);
  const context = new InMemoryTelemetryContext();
  const start = createTypedSpanStarter(context, [operationSchema, requestSchema]);
  const value = await start("operation", { kind: "read" }, (operation, startChild) => {
    operation.addEvent("result", { outcome: "ok" });
    return startChild("request", { provider: "example" }, (request) => {
      request.setAttributes({ response: "cached" });
      return 42;
    });
  });
  assert.equal(value, 42);
  const spans = context.getSpans();
  const operation = spans.find((span) => span.name === "operation");
  const request = spans.find((span) => span.name === "request");
  assert.ok(operation);
  assert.equal(request?.parentId, operation?.id);
  assert.equal(request?.attributes.response, "cached");
  assert.equal(operation?.status.status, "ok");
});

test("schema values are not read or validated when a span starts", async () => {
  const context = new InMemoryTelemetryContext();
  const schemas = new Proxy([operationSchema, requestSchema] as const, {
    get() {
      throw new Error("schema read");
    },
  });
  const start = createTypedSpanStarter(context, schemas);
  assert.equal(await start("operation", { kind: "write" }, () => "done"), "done");
});

test("a typed starter keeps the passive boundary and does not wait for export", async () => {
  let calls = 0;
  const throwing: TelemetryContext = { startSpan() { throw new Error("export failed"); } };
  const startThrowing = createTypedSpanStarter(throwing, [operationSchema]);
  assert.equal(await startThrowing("operation", { kind: "read" }, () => {
    calls++;
    return 1;
  }), 1);
  assert.equal(calls, 1);

  let duplicated = 0;
  const repeating: TelemetryContext = {
    startSpan(_options, callback) {
      void callback(idleSpan);
      void callback(idleSpan);
      return new Promise(() => {});
    },
  };
  const startRepeating = createTypedSpanStarter(repeating, [operationSchema]);
  const settled = await Promise.race([
    startRepeating("operation", { kind: "read" }, () => {
      duplicated++;
      return 5;
    }),
    new Promise<string>((resolve) => setTimeout(() => resolve("waited"), 200)),
  ]);
  assert.equal(settled, 5);
  assert.equal(duplicated, 1);
});

const idleSpan: TelemetrySpan = {
  startSpan(_options, callback) {
    return Promise.resolve(callback(idleSpan));
  },
  addEvent() {},
  setAttributes() {},
  setStatus() {},
};

test("typed span names and attributes are closed", () => {
  const start = createTypedSpanStarter(new InMemoryTelemetryContext(), [operationSchema, requestSchema]);
  const accepted = start("operation", { kind: "read" }, (span) => {
    span.addEvent("result", { outcome: "ok" });
    span.setStatus({ status: "error" });
    return span;
  });
  void accepted;
  const rejected = () => {
    // @ts-expect-error unknown span names are rejected
    void start("unknown", {}, () => {});
    // @ts-expect-error kind only allows the declared values
    void start("operation", { kind: "other" }, () => {});
    // @ts-expect-error kind is a string, not a number
    void start("operation", { kind: 1 }, () => {});
    // @ts-expect-error kind is required
    void start("operation", {}, () => {});
    // @ts-expect-error undeclared start attributes are rejected
    void start("operation", { kind: "read", extra: true }, () => {});
    // @ts-expect-error request attributes are not operation attributes
    void start("request", { kind: "read" }, () => {});
    // @ts-expect-error duplicate span names across schemas are rejected
    void createTypedSpanStarter(new InMemoryTelemetryContext(), [operationSchema, operationSchema]);
  };
  void rejected;
  const rejectOperation = (span: SchemaTelemetrySpan<typeof operationSchema, "operation">) => {
    span.addEvent("result", { outcome: "ok" });
    // @ts-expect-error required event attributes cannot be omitted
    span.addEvent("result");
    // @ts-expect-error event values only allow the declared set
    span.addEvent("result", { outcome: "other" });
    // @ts-expect-error undeclared event attributes are rejected
    span.addEvent("result", { outcome: "ok", extra: true });
    // @ts-expect-error undeclared events are rejected
    span.addEvent("unknown", {});
    // @ts-expect-error an empty end schema rejects every attribute
    span.setAttributes({ unknown: true });
  };
  const rejectRequest = (span: SchemaTelemetrySpan<typeof requestSchema, "request">) => {
    span.setAttributes({ response: "cached" });
    // @ts-expect-error response is a string
    span.setAttributes({ response: 1 });
    // @ts-expect-error undeclared end attributes are rejected
    span.setAttributes({ response: "cached", extra: true });
  };
  void rejectOperation;
  void rejectRequest;
});
