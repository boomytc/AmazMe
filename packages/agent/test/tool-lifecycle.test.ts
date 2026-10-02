import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type AgentTool } from "@amazme/agent";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/providers/faux";

function agentFor(tools: AgentTool[], calls: Array<{ name: string; args?: unknown; id?: string }>) {
  const provider = fauxProvider({
    respond: (_context, _options, state) => {
      if (state.callCount === 1) {
        return fauxAssistant(calls.map((call) => fauxToolCall(call.name, call.args ?? {}, call.id)));
      }
      return fauxAssistant("after");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  const agent = new Agent({ streamFn: models.streamSimple.bind(models), model, systemPrompt: "test", tools });
  return { agent, model };
}

function textTool(name: string, execute: AgentTool["execute"], executionMode?: "sequential"): AgentTool {
  return {
    name,
    description: name,
    parameters: { type: "object", additionalProperties: true },
    ...(executionMode ? { executionMode } : {}),
    execute,
  };
}

test("aborting inside tool_execution_start does not execute the tool", async () => {
  let runs = 0;
  const { agent } = agentFor([
    textTool("echo", async () => {
      runs += 1;
      return { content: [{ type: "text", text: "ran" }] };
    }),
  ], [{ name: "echo" }]);
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") agent.abort();
  });
  const produced = await agent.prompt("go");
  assert.equal(runs, 0);
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" && result.isError, true);
  assert.match(result?.role === "toolResult" ? messageText(result) : "", /cancelled/);
  await agent.waitForIdle();
});

test("aborting a sequential tool prevents the next tool from starting", async () => {
  const started: string[] = [];
  const { agent } = agentFor([
    textTool("first", async (_args, context) => {
      started.push("first");
      assert.equal(context.signal.aborted, false);
      agent.abort();
      assert.equal(context.signal.aborted, true);
      return { content: [{ type: "text", text: "first" }] };
    }, "sequential"),
    textTool("second", async () => {
      started.push("second");
      return { content: [{ type: "text", text: "second" }] };
    }, "sequential"),
  ], [{ name: "first", id: "call_first" }, { name: "second", id: "call_second" }]);
  const events: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") events.push(event.toolName);
  });
  const produced = await agent.prompt("go");
  assert.deepEqual(started, ["first"]);
  assert.deepEqual(events, ["first"]);
  const results = produced.filter((message) => message.role === "toolResult");
  assert.deepEqual(results.map((result) => result.toolCallId), ["call_first", "call_second"]);
  assert.equal(results[1]?.isError, true);
});

test("cancelling a later parallel start prevents all pending executions and pairs every call", async () => {
  const executed: string[] = [];
  const names = ["first", "second", "third"];
  const { agent } = agentFor(names.map((name) => textTool(name, async () => {
    executed.push(name);
    return { content: [] };
  })), names.map((name) => ({ name, id: `call_${name}` })));
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "second") agent.abort();
  });
  const produced = await agent.prompt("go");
  assert.deepEqual(executed, []);
  const results = produced.filter((message) => message.role === "toolResult");
  assert.deepEqual(results.map((result) => result.toolCallId), names.map((name) => `call_${name}`));
  assert.ok(results.every((result) => result.isError));
});

test("an update failure drains all accepted updates before the run becomes idle", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let secondStarted = false;
  let settled = false;
  const { agent } = agentFor([textTool("work", async (_args, context) => {
    context.onUpdate?.("failed");
    context.onUpdate?.("blocked");
    return { content: [] };
  })], [{ name: "work" }]);
  agent.subscribe(async (event) => {
    if (event.type !== "tool_execution_update") return;
    if (event.partial === "failed") throw new Error("update failed");
    secondStarted = true;
    await blocked;
  });
  const pending = agent.prompt("go").then(() => { settled = true; return undefined; }, (error: unknown) => { settled = true; return error; });
  try {
    await waitFor(() => secondStarted);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
  } finally {
    release();
  }
  assert.match(String(await pending), /update failed/);
  await agent.waitForIdle();
});

test("a failed parallel tool subscriber waits for sibling tools before releasing the run", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let siblingStarted = false;
  let settled = false;
  let siblingSignal: AbortSignal | undefined;
  const { agent } = agentFor([
    textTool("failed", async (_args, context) => { context.onUpdate?.("partial"); return { content: [] }; }),
    textTool("sibling", async (_args, context) => { siblingStarted = true; siblingSignal = context.signal; await blocked; return { content: [] }; }),
  ], [{ name: "failed" }, { name: "sibling" }]);
  agent.subscribe((event) => {
    if (event.type === "tool_execution_update") throw new Error("update failed");
  });
  const pending = agent.prompt("go").then(() => { settled = true; return undefined; }, (error: unknown) => { settled = true; return error; });
  try {
    await waitFor(() => siblingStarted);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(siblingSignal?.aborted, true);
    assert.equal(settled, false);
    await assert.rejects(agent.prompt("overlap"), /already processing/);
  } finally {
    release();
  }
  assert.match(String(await pending), /update failed/);
  await agent.waitForIdle();
});

test("an active tool receives the run abort signal and is not forced to stop", async () => {
  let seen: AbortSignal | undefined;
  const { agent } = agentFor([
    textTool("echo", async (_args, context) => {
      seen = context.signal;
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true });
        agent.abort();
      });
      return { content: [{ type: "text", text: "stopped" }] };
    }),
  ], [{ name: "echo" }]);
  const produced = await agent.prompt("go");
  assert.equal(seen?.aborted, true);
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" ? messageText(result) : "", "stopped");
});

test("updates accepted during a call finish before tool_execution_end, and later updates are ignored", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saved: ((partial: string) => void) | undefined;
  const { agent } = agentFor([
    textTool("echo", async (_args, context) => {
      saved = context.onUpdate;
      context.onUpdate?.("partial");
      return { content: [{ type: "text", text: "done" }] };
    }),
  ], [{ name: "echo" }]);
  const order: string[] = [];
  agent.subscribe(async (event) => {
    if (event.type === "tool_execution_update") {
      order.push("update-start");
      await gate;
      order.push("update-done");
    }
    if (event.type === "tool_execution_end") order.push("tool-end");
    if (event.type === "agent_end") order.push("agent-end");
  });
  const pending = agent.prompt("go");
  await waitFor(() => order.includes("update-start"));
  assert.equal(order.includes("tool-end"), false);
  release();
  await pending;
  saved?.("late");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["update-start", "update-done", "tool-end", "agent-end"]);
});

test("a thrown tool becomes an error result", async () => {
  const { agent } = agentFor([
    textTool("echo", async () => {
      throw new Error("boom");
    }),
  ], [{ name: "echo" }]);
  const produced = await agent.prompt("go");
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" && result.isError, true);
  assert.match(result?.role === "toolResult" ? messageText(result) : "", /boom/);
});

test("a rejected update subscriber rejects the run, leaves the agent idle, and is not a successful tool result", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    let runs = 0;
    const { agent } = agentFor([
      textTool("echo", async (_args, context) => {
        runs += 1;
        context.onUpdate?.("partial");
        return { content: [{ type: "text", text: "ran" }] };
      }),
    ], [{ name: "echo" }]);
    agent.subscribe((event) => {
      if (event.type === "tool_execution_update") return Promise.reject(new Error("update failed"));
    });
    await assert.rejects(agent.prompt("go"), /update failed/);
    await agent.waitForIdle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(runs, 1);
    assert.equal(agent.state.messages.some((message) => message.role === "toolResult"), false);
    const again = await agent.prompt("next");
    assert.equal(again.at(-1)?.role, "assistant");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 1000) throw new Error("timed out waiting for tool lifecycle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
