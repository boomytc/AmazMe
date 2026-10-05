import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type AgentTool, userMessage } from "@amazme/agent";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall, type FauxResponder } from "@amazme/ai/testing";

function echoTool(options: { terminate?: boolean; delayMs?: number; onRun?: (name: string) => void; name?: string } = {}): AgentTool {
  const name = options.name ?? "echo";
  return {
    name,
    description: name,
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(args) {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      options.onRun?.(name);
      const text = typeof args === "object" && args && "text" in args ? String((args as { text: unknown }).text) : "";
      return { content: [{ type: "text", text }], terminate: options.terminate === true };
    },
  };
}

function agentWith(respond: FauxResponder, tools: AgentTool[] = [], toolExecution?: "parallel" | "sequential") {
  const provider = fauxProvider({ respond });
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  const agent = new Agent({
    streamFn: models.streamSimple.bind(models),
    model,
    systemPrompt: "test",
    tools,
    ...(toolExecution ? { toolExecution } : {}),
  });
  return { agent, provider };
}

test("a tool result is sent back to the model before the final answer", async () => {
  const { agent, provider } = agentWith((context, _options, state) => {
    if (state.callCount === 1) return fauxAssistant([fauxToolCall("echo", { text: "hi" })]);
    const tool = context.messages.find((message) => message.role === "toolResult");
    return fauxAssistant(tool ? messageText(tool) : "missing");
  }, [echoTool()]);
  const produced = await agent.prompt("say hi");
  assert.equal(provider.state.callCount, 2);
  const roles = produced.map((message) => message.role);
  assert.deepEqual(roles.filter((role) => role !== "system"), ["user", "assistant", "toolResult", "assistant"]);
  const last = produced[produced.length - 1];
  assert.equal(last && last.role === "assistant" && last.content[0]?.type === "text" ? last.content[0].text : "", "hi");
});

test("parallel tool completion can differ from persisted source order", async () => {
  const finished: string[] = [];
  const { agent } = agentWith(
    (_context, _options, state) => {
      if (state.callCount === 1) {
        return fauxAssistant([fauxToolCall("slow", { text: "slow" }, "call_slow"), fauxToolCall("fast", { text: "fast" }, "call_fast")]);
      }
      return fauxAssistant("done");
    },
    [echoTool({ name: "slow", delayMs: 40, onRun: () => finished.push("slow") }), echoTool({ name: "fast", delayMs: 5, onRun: () => finished.push("fast") })],
  );
  const ends: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") ends.push(event.toolName);
  });
  const produced = await agent.prompt("go");
  assert.deepEqual(finished, ["fast", "slow"]);
  assert.deepEqual(ends, ["fast", "slow"]);
  const results = produced.filter((message) => message.role === "toolResult");
  assert.deepEqual(
    results.map((message) => (message.role === "toolResult" ? messageText(message) : "")),
    ["slow", "fast"],
  );
});

test("steering enters on the next turn and follow-up waits until the run would stop", async () => {
  const seen: string[][] = [];
  const { agent, provider } = agentWith((context, _options, state) => {
    seen.push(
      context.messages.filter((message) => message.role === "user").map((message) => (typeof message.content === "string" ? message.content : "")),
    );
    if (state.callCount === 1) {
      agent.steer("steer-msg");
      agent.followUp("follow-msg");
      return fauxAssistant([fauxToolCall("echo", { text: "tool" })]);
    }
    return fauxAssistant(state.callCount === 2 ? "after-steer" : "after-follow");
  }, [echoTool()]);
  await agent.prompt("prompt");
  assert.equal(provider.state.callCount, 3);
  assert.deepEqual(seen[0], ["prompt"]);
  assert.equal(seen[1]?.includes("steer-msg"), true);
  assert.equal(seen[1]?.includes("follow-msg"), false);
  assert.equal(seen[2]?.includes("follow-msg"), true);
});

test("a truncated tool call is not executed", async () => {
  let runs = 0;
  const seen: string[] = [];
  const { agent, provider } = agentWith((context, _options, state) => {
    const tool = context.messages.find((message) => message.role === "toolResult");
    if (tool) seen.push(messageText(tool));
    if (state.callCount === 1) return fauxAssistant([fauxToolCall("echo", { text: "nope" })], { stopReason: "length" });
    return fauxAssistant("continued");
  }, [echoTool({ onRun: () => { runs += 1; } })]);
  const produced = await agent.prompt("cut");
  assert.equal(runs, 0);
  assert.equal(provider.state.callCount, 2);
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" ? result.isError : false, true);
  assert.match(seen[0] ?? "", /truncated/);
  const last = produced[produced.length - 1];
  assert.equal(last && last.role === "assistant" && last.content[0]?.type === "text" ? last.content[0].text : "", "continued");
});

test("assistant updates start after message_start and include tool-call events", async () => {
  const { agent } = agentWith((_context, _options, state) => {
    if (state.callCount === 1) return fauxAssistant([fauxToolCall("echo", { text: "x" })]);
    return fauxAssistant("done");
  }, [echoTool()]);
  const trace: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant") trace.push("start");
    if (event.type === "message_update") trace.push(event.assistantMessageEvent.type);
    if (event.type === "message_end" && event.message.role === "assistant") trace.push("end");
  });
  const indexes: number[] = [];
  agent.subscribe((event) => {
    if (event.type !== "message_update") return;
    const streamed = event.assistantMessageEvent;
    if (streamed.type === "toolcall_start" || streamed.type === "toolcall_delta" || streamed.type === "toolcall_end") {
      indexes.push(streamed.contentIndex);
    }
  });
  await agent.prompt("go");
  assert.equal(trace[0], "start");
  assert.ok(trace.indexOf("start") < trace.indexOf("toolcall_end"));
  assert.ok(trace.indexOf("toolcall_end") < trace.indexOf("end"));
  assert.deepEqual([...new Set(indexes)], [0]);
});

test("an error assistant that already contains a tool call is not executed", async () => {
  let runs = 0;
  const { agent, provider } = agentWith(
    () => fauxAssistant([fauxToolCall("echo", { text: "x" })], { stopReason: "error", errorMessage: "nope" }),
    [echoTool({ onRun: () => { runs += 1; } })],
  );
  const produced = await agent.prompt("go");
  assert.equal(runs, 0);
  assert.equal(provider.state.callCount, 1);
  const assistant = produced.find((message) => message.role === "assistant");
  assert.equal(assistant?.role === "assistant" ? assistant.stopReason : "", "error");
  assert.equal(assistant?.role === "assistant" ? assistant.content.some((block) => block.type === "toolCall") : false, true);
});

test("terminate skips the following model turn", async () => {
  const { agent, provider } = agentWith(
    () => fauxAssistant([fauxToolCall("echo", { text: "final" })]),
    [echoTool({ terminate: true })],
  );
  await agent.prompt("stop");
  assert.equal(provider.state.callCount, 1);
});

test("prepareRequest observes the prompt that was just admitted", async () => {
  const provider = fauxProvider({ respond: () => fauxAssistant("ok") });
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  let saw = "";
  const agent = new Agent({
    streamFn: models.streamSimple.bind(models),
    model,
    prepareRequest: (input) => {
      const last = input.messages[input.messages.length - 1];
      saw = last && last.role === "user" && typeof last.content === "string" ? last.content : "";
      return undefined;
    },
  });
  await agent.prompt(userMessage("visible"));
  assert.equal(saw, "visible");
});
