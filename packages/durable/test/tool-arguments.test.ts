import assert from "node:assert/strict";
import test from "node:test";
import { AgentHarness, type HarnessTool } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { createModels, messageText, type JsonSchema } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/providers/faux";

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

function laneFor(args: unknown, execute: HarnessTool["execute"]) {
  const provider = fauxProvider({
    respond: (_context, _options, state) => {
      if (state.callCount === 1) return fauxAssistant([fauxToolCall("nested", args)]);
      const result = _context.messages.find((message) => message.role === "toolResult");
      return fauxAssistant(result ? messageText(result) : "missing");
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const tool: HarnessTool = { name: "nested", description: "nested", parameters: nested, replay: "never", execute };
  return new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [tool],
    systemPrompt: "sys",
  }).lane();
}

async function toolText(args: unknown, execute: HarnessTool["execute"]): Promise<string> {
  const lane = laneFor(args, execute);
  const result = await lane.prompt("go");
  assert.equal(result.status, "completed");
  const entry = (await lane.entries()).find((item) => item.payload.type === "message" && item.payload.message.role === "toolResult");
  assert.ok(entry && entry.payload.type === "message" && entry.payload.message.role === "toolResult");
  return messageText(entry.payload.message);
}

test("durable rejects invalid nested arguments before execute", async () => {
  let runs = 0;
  const text = await toolText({ config: { count: "1", tags: [1] } }, async () => {
    runs += 1;
    return { content: [{ type: "text", text: "ran" }] };
  });
  assert.equal(runs, 0);
  assert.match(text, /config\.count: must be number/);
  assert.match(text, /config\.tags\.0: must be string/);
});

test("durable rejects additional properties and executes a valid nested value", async () => {
  let rejectedRuns = 0;
  const rejected = await toolText({ extra: true, config: { count: 3, tags: ["a"] } }, async () => {
    rejectedRuns += 1;
    return { content: [{ type: "text", text: "ran" }] };
  });
  assert.equal(rejectedRuns, 0);
  assert.match(rejected, /extra: additional property is not allowed/);

  let runs = 0;
  const text = await toolText({ config: { count: 3, tags: ["a"] } }, async (args) => {
    runs += 1;
    const count = (args as { config: { count: number } }).config.count;
    return { content: [{ type: "text", text: String(count) }] };
  });
  assert.equal(runs, 1);
  assert.equal(text, "3");
});

test("durable still returns an error result for an unknown tool", async () => {
  const provider = fauxProvider({
    respond: (_context, _options, state) => (state.callCount === 1 ? fauxAssistant([fauxToolCall("missing", {})]) : fauxAssistant("after")),
  });
  const models = createModels();
  models.setProvider(provider);
  const lane = new AgentHarness(new MemoryStorage(), {
    models,
    model: { provider: "faux", modelId: "faux-1" },
    tools: [],
    systemPrompt: "sys",
  }).lane();
  const result = await lane.prompt("go");
  assert.equal(result.status, "completed");
  const entry = (await lane.entries()).find((item) => item.payload.type === "message" && item.payload.message.role === "toolResult");
  assert.ok(entry && entry.payload.type === "message" && entry.payload.message.role === "toolResult");
  assert.equal(entry.payload.message.isError, true);
  assert.match(messageText(entry.payload.message), /Unknown tool: missing/);
});
