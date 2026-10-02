import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, type AgentMessage, type AgentTool } from "@amazme/agent";
import { AgentHarness } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
import { baseAssistant, createAssistantEventStream, createModels, fauxAssistant, fauxProvider, fauxToolCall, messageText, type FauxResponder } from "@amazme/ai";
import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT, startSpan, type TelemetryContext, type TelemetrySpan } from "@amazme/telemetry";

function setup(telemetryContext?: TelemetryContext, respond: FauxResponder = (_context, _options, state) =>
  state.callCount === 1 ? fauxAssistant([fauxToolCall("echo", { secret: "private-args" })]) : fauxAssistant("private-answer")) {
  const models = createModels({ telemetryContext, env: { FAUX_API_KEY: "private-key" } });
  const provider = fauxProvider({ respond });
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1")!;
  return { models, provider, model };
}

for (const runtime of ["agent", "harness"] as const) {
  test(`${runtime}: requests and tools share a parent, inheriting the Models context without collecting content`, async () => {
    const context = new InMemoryTelemetryContext();
    const { models, provider, model } = setup(context);
    let runs = 0;
    const tools: AgentTool[] = [{
      name: "echo", description: "echo", parameters: { type: "object" },
      async execute(args, options) {
        runs++;
        assert.deepEqual(args, { secret: "private-args" });
        assert.ok(options.telemetryContext);
        await startSpan(options.telemetryContext, { name: "app.detail" }, () => 42);
        return { content: [{ type: "text", text: "private-result" }] };
      },
    }];
    let messages: AgentMessage[];
    if (runtime === "agent") {
      messages = await new Agent({ models, model, tools }).prompt("private-prompt");
    } else {
      const storage = new MemoryStorage();
      const harness = new AgentHarness(storage, { models, model: { provider: "faux", modelId: "faux-1" }, tools });
      assert.equal((await harness.lane().prompt("private-prompt")).status, "completed");
      messages = (await harness.lane().entries()).flatMap((entry) => entry.payload.type === "message" ? [entry.payload.message] : []);
      assert.doesNotMatch(JSON.stringify(await storage.read((view) => view.values())), /telemetryContext|amazme\.harness\.drive/);
      harness.close();
    }
    assert.equal(runs, 1);
    assert.equal(provider.state.callCount, 2);
    const last = messages.at(-1)!;
    assert.equal(last.role, "assistant");
    if (last.role === "assistant") assert.equal(messageText(last), "private-answer");
    const spans = context.getSpans();
    const root = spans.find((span) => span.name === `amazme.${runtime === "agent" ? "agent.run" : "harness.drive"}`)!;
    assert.ok(root);
    const requests = spans.filter((span) => span.name === "amazme.ai.request");
    assert.equal(requests.length, 2);
    assert.ok(requests.every((span) => span.parentId === root.id));
    const tool = spans.find((span) => span.name === "amazme.tool.execute")!;
    assert.equal(tool.parentId, root.id);
    assert.equal(spans.find((span) => span.name === "app.detail")!.parentId, tool.id);
    assert.ok(spans.every((span) => span.settled && span.status.status === "ok"));
    assert.doesNotMatch(JSON.stringify(spans), /private-(prompt|args|answer|result|key)/);
  });
}

test("AI forwards deltas while its span is open and settles before exposing the terminal result", async () => {
  const context = new InMemoryTelemetryContext();
  const { models, provider, model } = setup(context);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  models.setProvider({ ...provider, streamSimple(active) {
    const stream = createAssistantEventStream();
    const message = baseAssistant(active, [{ type: "text", text: "streamed" }], "stop");
    message.usage = { input: 2, output: 3, totalTokens: 5, cost: { input: 0, output: 0, total: 0 } };
    stream.push({ type: "text_delta", delta: "streamed", partial: { ...message, stopReason: "pending" } });
    void gate.then(() => { stream.push({ type: "done", reason: "stop", message }); });
    return stream;
  } });
  const stream = models.streamSimple(model, { messages: [] });
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "text_delta");
  assert.equal(context.getSpans()[0]!.settled, false);
  release();
  assert.equal((await stream.result()).stopReason, "stop");
  const recorded = context.getSpans()[0]!;
  assert.equal(recorded.settled, true);
  assert.equal(recorded.attributes.inputTokens, 2);
  assert.equal(recorded.attributes.outputTokens, 3);
  assert.equal(recorded.attributes.totalTokens, 5);
  await iterator.return?.();
});

for (const reason of ["error", "aborted"] as const) {
  test(`resolved ${reason} responses set both AI and Agent failure status without retaining errors`, async () => {
    const context = new InMemoryTelemetryContext();
    const { models, model } = setup(context, () => fauxAssistant("private-body", { stopReason: reason, errorMessage: "private-error" }));
    const messages = await new Agent({ models, model }).prompt("go");
    const last = messages.at(-1);
    assert.equal(last?.role === "assistant" && last.stopReason, reason);
    assert.ok(context.getSpans().every((span) => span.status.status === "error"));
    assert.doesNotMatch(JSON.stringify(context.getSpans()), /private-(body|error)/);
  });
}

test("AI dispatch failures record error status and keep the established error response", async () => {
  const context = new InMemoryTelemetryContext();
  const { model } = setup();
  const models = createModels({ telemetryContext: context });
  const message = await models.completeSimple(model, { messages: [] });
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /Unknown provider/);
  assert.deepEqual(context.getSpans()[0]!.status, { status: "error" });
});

test("per-request context overrides the Models default and can explicitly disable recording", async () => {
  const defaults = new InMemoryTelemetryContext();
  const override = new InMemoryTelemetryContext();
  const { models, model } = setup(defaults, () => fauxAssistant("ok"));
  await models.completeSimple(model, { messages: [] });
  await models.completeSimple(model, { messages: [] }, { telemetryContext: override });
  await models.completeSimple(model, { messages: [] }, { telemetryContext: NOOP_TELEMETRY_CONTEXT });
  assert.equal(defaults.getSpans().length, 1);
  assert.equal(override.getSpans().length, 1);
});

for (const runtime of ["agent", "harness"] as const) {
  test(`${runtime}: caught tool failures record an error span while the model can finish normally`, async () => {
    const defaults = new InMemoryTelemetryContext();
    const override = new InMemoryTelemetryContext();
    const { models, model } = setup(defaults);
    const tools: AgentTool[] = [{ name: "echo", description: "echo", parameters: { type: "object" }, async execute() {
      throw new Error("private-tool-error");
    } }];
    if (runtime === "agent") {
      await new Agent({ models, model, tools, telemetryContext: override }).prompt("go");
    } else {
      const harness = new AgentHarness(new MemoryStorage(), { models, model: { provider: "faux", modelId: "faux-1" }, tools, telemetryContext: override });
      assert.equal((await harness.lane().prompt("go")).status, "completed");
      harness.close();
    }
    assert.equal(defaults.getSpans().length, 0);
    const spans = override.getSpans();
    assert.deepEqual(spans.find((span) => span.name === "amazme.tool.execute")!.status, { status: "error" });
    assert.equal(spans[0]!.status.status, "ok");
    assert.doesNotMatch(JSON.stringify(spans), /private-tool-error/);
  });
}

for (const replay of ["safe", "never"] as const) {
  test(`Harness tool recovery reports ${replay} without changing its replay policy`, async (t) => {
    const { models, provider } = setup();
    const storage = new MemoryStorage();
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.after(() => { release(); });
    let runs = 0;
    const tools: AgentTool[] = [{ name: "echo", description: "echo", parameters: { type: "object" }, replay, async execute(_args, options) {
      runs++;
      if (runs === 1) {
        options.onUpdate?.("private-checkpoint", { checkpoint: true });
        entered();
        await gate;
      }
      return { content: [{ type: "text", text: "ok" }] };
    } }];
    const options = { models, model: { provider: "faux", modelId: "faux-1" }, tools };
    const first = new AgentHarness(storage, options);
    const admitted = await first.lane().accept({ kind: "prompt", text: "go" });
    assert.ok(admitted.ok);
    const driving = first.lane().drive(admitted.value.operationId);
    await started;
    await storage.whenIdle();
    first.abandon();
    const context = new InMemoryTelemetryContext();
    const second = new AgentHarness(storage, { ...options, telemetryContext: context });
    const outcome = await second.lane().drive(admitted.value.operationId);
    assert.ok(outcome.ok && outcome.value.kind === "settled");
    assert.equal(outcome.value.result.status, "completed");
    release();
    await driving;
    assert.equal(runs, replay === "safe" ? 2 : 1);
    assert.equal(provider.state.callCount, 2);
    const spans = context.getSpans();
    assert.deepEqual(spans[0]!.events, [{ name: "amazme.harness.recovered", attributes: { effect: "tool", replay } }]);
    assert.equal(spans.filter((span) => span.name === "amazme.tool.execute").length, replay === "safe" ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(spans), /private-checkpoint/);
    second.close();
  });
}

test("interrupted summaries emit recovery diagnostics and remain aborted without resending", async (t) => {
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => { release(); });
  const { models, provider } = setup(undefined, async (_context, _options, state) => {
    if (state.callCount === 2) { entered(); await gate; }
    return fauxAssistant("ok");
  });
  const storage = new MemoryStorage();
  const options = { models, model: { provider: "faux", modelId: "faux-1" } };
  const first = new AgentHarness(storage, options);
  await first.lane().prompt("seed");
  const admitted = await first.lane().accept({ kind: "compaction" });
  assert.ok(admitted.ok);
  const driving = first.lane().drive(admitted.value.operationId);
  await started;
  first.abandon();
  const context = new InMemoryTelemetryContext();
  const second = new AgentHarness(storage, { ...options, telemetryContext: context });
  const outcome = await second.lane().drive(admitted.value.operationId);
  assert.ok(outcome.ok && outcome.value.kind === "settled");
  assert.equal(outcome.value.result.status, "aborted");
  release();
  await driving;
  assert.equal(provider.state.callCount, 2);
  assert.equal(context.getSpans().length, 1);
  assert.deepEqual(context.getSpans()[0]!.events, [{ name: "amazme.harness.recovered", attributes: { effect: "summary" } }]);
  second.close();
});

const failingSpan: TelemetrySpan = {
  startSpan() { throw new Error("child failed"); },
  addEvent() { throw new Error("event failed"); },
  setAttributes() { throw new Error("attributes failed"); },
  setStatus() { throw new Error("status failed"); },
};
for (const [adapterName, telemetryContext] of [
  ["noop", NOOP_TELEMETRY_CONTEXT],
  ["startup throw", { startSpan() { throw new Error("export failed"); } } satisfies TelemetryContext],
  ["duplicate and recording failures", { startSpan(_options, callback) {
    void callback(failingSpan);
    void callback(failingSpan);
    return Promise.reject(new Error("export failed"));
  } } satisfies TelemetryContext],
] as const) {
  for (const runtime of ["agent", "harness"] as const) {
    test(`${runtime}: ${adapterName} preserves one tool execution and two model requests`, async () => {
      const { models, provider, model } = setup(telemetryContext);
      let runs = 0;
      const tools: AgentTool[] = [{ name: "echo", description: "echo", parameters: { type: "object" }, async execute() {
        runs++;
        return { content: [{ type: "text", text: "result" }] };
      } }];
      if (runtime === "agent") {
        const agent = new Agent({ models, model, tools });
        const output = await agent.prompt("go");
        const last = output.at(-1)!;
        assert.equal(last.role === "assistant" && messageText(last), "private-answer");
        await agent.waitForIdle();
      } else {
        const harness = new AgentHarness(new MemoryStorage(), { models, model: { provider: "faux", modelId: "faux-1" }, tools });
        assert.equal((await harness.lane().prompt("go")).status, "completed");
        harness.close();
      }
      assert.equal(runs, 1);
      assert.equal(provider.state.callCount, 2);
    });
  }
}

test("joined Harness drives share one span and recover JSONL frames without resending", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-telemetry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "storage.jsonl");
  const storage = new JsonlStorage(file);
  const firstContext = new InMemoryTelemetryContext();
  const { models, provider, model } = setup();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => { release(); });
  let calls = 0;
  models.setProvider({ ...provider, streamSimple(active) {
    calls++;
    const stream = createAssistantEventStream();
    const message = baseAssistant(active, [{ type: "text", text: "interrupted" }], "stop");
    stream.push({ type: "text_delta", delta: "interrupted", partial: { ...message, stopReason: "pending" } });
    void gate.then(() => { stream.push({ type: "done", reason: "stop", message }); });
    return stream;
  } });
  const options = { models, model: { provider: model.provider, modelId: model.id } };
  const first = new AgentHarness(storage, { ...options, telemetryContext: firstContext });
  const admitted = await first.lane().accept({ kind: "prompt", text: "go" });
  assert.ok(admitted.ok);
  const id = admitted.value.operationId;
  const driving = first.lane().drive(id);
  const joined = first.lane().drive(id);
  assert.equal(driving, joined);
  let framed = false;
  for (let step = 0; step < 100; step++) {
    framed = await storage.read((view) => view.lists().some((list) => list.items.length > 0));
    if (framed) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(framed);
  first.abandon();
  const secondContext = new InMemoryTelemetryContext();
  const second = new AgentHarness(new JsonlStorage(file), { ...options, telemetryContext: secondContext });
  const outcome = await second.lane().drive(id);
  assert.ok(outcome.ok && outcome.value.kind === "settled");
  assert.equal(outcome.value.result.status, "aborted");
  release();
  await driving;
  assert.equal(calls, 1);
  assert.equal(firstContext.getSpans().filter((span) => span.name === "amazme.harness.drive").length, 1);
  const records = secondContext.getSpans();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]!.events, [{ name: "amazme.harness.recovered", attributes: { effect: "assistant" } }]);
  assert.equal(records[0]!.status.status, "error");
  assert.doesNotMatch(readFileSync(file, "utf8"), /telemetryContext|amazme\.harness\.drive|amazme\.harness\.recovered/);
  second.close();
});
