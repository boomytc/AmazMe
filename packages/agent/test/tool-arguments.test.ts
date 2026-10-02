import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type AgentTool } from "@amazme/agent";
import { createModels, fauxAssistant, fauxProvider, fauxToolCall, messageText, type JsonSchema } from "@amazme/ai";

const nested: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["config"],
  properties: {
    config: {
      type: "object",
      additionalProperties: false,
      required: ["count"],
      properties: {
        count: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
};

function tool(runs: { count: number }): AgentTool {
  return {
    name: "nested",
    description: "nested",
    parameters: nested,
    async execute(args) {
      runs.count += 1;
      const config = (args as { config: { count: number } }).config;
      return { content: [{ type: "text", text: String(config.count) }] };
    },
  };
}

function run(args: unknown, tools: AgentTool[]) {
  const provider = fauxProvider({
    respond: (_context, _options, state) => {
      if (state.callCount === 1) return fauxAssistant([fauxToolCall("nested", args)]);
      const result = _context.messages.find((message) => message.role === "toolResult");
      return fauxAssistant(result ? messageText(result) : "missing");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  return new Agent({ models, model, systemPrompt: "test", tools }).prompt("go");
}

test("agent rejects a nested string where a number is required and does not execute the tool", async () => {
  const runs = { count: 0 };
  const produced = await run({ config: { count: "1", tags: ["a"] } }, [tool(runs)]);
  assert.equal(runs.count, 0);
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" && result.isError, true);
  assert.match(result?.role === "toolResult" ? messageText(result) : "", /config\.count: must be number/);
});

test("agent rejects an array element of the wrong type", async () => {
  const runs = { count: 0 };
  const produced = await run({ config: { count: 2, tags: ["a", 1] } }, [tool(runs)]);
  assert.equal(runs.count, 0);
  const result = produced.find((message) => message.role === "toolResult");
  assert.match(result?.role === "toolResult" ? messageText(result) : "", /config\.tags\.1: must be string/);
});

test("agent rejects an additional property and executes a valid nested value", async () => {
  const rejected = { count: 0 };
  const rejectedRun = await run({ config: { count: 2 }, extra: 1 }, [tool(rejected)]);
  assert.equal(rejected.count, 0);
  const rejectedResult = rejectedRun.find((message) => message.role === "toolResult");
  assert.match(rejectedResult?.role === "toolResult" ? messageText(rejectedResult) : "", /extra: additional property is not allowed/);

  const accepted = { count: 0 };
  const produced = await run({ config: { count: 2, tags: ["a"] } }, [tool(accepted)]);
  assert.equal(accepted.count, 1);
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" ? messageText(result) : "", "2");
});

test("agent still returns an error result for an unknown tool", async () => {
  const provider = fauxProvider({
    respond: (_context, _options, state) => (state.callCount === 1 ? fauxAssistant([fauxToolCall("missing", {})]) : fauxAssistant("after")),
  });
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  const produced = await new Agent({ models, model, systemPrompt: "test", tools: [] }).prompt("go");
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" && result.isError, true);
  assert.match(result?.role === "toolResult" ? messageText(result) : "", /Unknown tool: missing/);
});
