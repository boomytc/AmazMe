import assert from "node:assert/strict";
import test from "node:test";
import { createModels, createProvider, type Model } from "@amazme/ai";
import { openaiCompletionsApi } from "@amazme/ai/api/openai-completions";
import { AgentHarness } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";

const model: Model<"openai-completions"> = {
  id: "reasoner",
  name: "reasoner",
  provider: "wire",
  api: "openai-completions",
  input: ["text"],
  reasoning: true,
  contextWindow: 8000,
  maxTokens: 1000,
  cost: { input: 1_000_000, output: 2_000_000 },
};

function sse(text: string): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`,
    "",
    `data: ${JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function http(status: number, error: unknown): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
}

const cases: Array<{ name: string; responses: Array<() => Response>; calls: number; status: "completed" | "failed" }> = [
  {
    name: "rate limit",
    responses: [
      () => http(429, { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Rate limit reached" }),
      () => sse("ok"),
    ],
    calls: 2,
    status: "completed",
  },
  {
    name: "quota",
    responses: [() => http(429, { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" })],
    calls: 1,
    status: "failed",
  },
  {
    name: "authentication",
    responses: [() => http(401, { code: "invalid_api_key", message: "Incorrect API key" })],
    calls: 1,
    status: "failed",
  },
  {
    name: "invalid request",
    responses: [() => http(400, { type: "invalid_request_error", message: "bad param" })],
    calls: 1,
    status: "failed",
  },
  {
    name: "unavailable",
    responses: [() => http(503, { message: "overloaded" }), () => sse("ok")],
    calls: 2,
    status: "completed",
  },
  {
    name: "unrecognized server",
    responses: [() => http(501, { message: "not implemented" })],
    calls: 1,
    status: "failed",
  },
];

for (const item of cases) {
  test(`completions ${item.name} uses the harness retry budget`, async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const models = createModels({ env: { OPENAI_API_KEY: "sk-test" } });
    models.setProvider(createProvider({
      id: "wire",
      baseUrl: "https://example.test/v1",
      auth: { env: "OPENAI_API_KEY" },
      models: [model],
      api: openaiCompletionsApi({
        fetch: async (_input, init) => {
          const response = item.responses[calls];
          calls += 1;
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          if (!response) throw new Error(`unexpected request ${calls}`);
          return response();
        },
      }),
    }));
    const runtime = new AgentHarness(new MemoryStorage(), {
      models,
      model: { provider: "wire", modelId: "reasoner" },
      thinkingLevel: "low",
      maxAttempts: 2,
      retry: { baseDelayMs: 0, maxDelayMs: 0 },
    });
    try {
      const result = await runtime.lane().prompt("go");
      assert.equal(calls, item.calls, item.name);
      assert.equal(result.status, item.status, item.name);
      assert.equal(bodies.length, item.calls);
      for (const body of bodies) {
        assert.equal(body.reasoning_effort, "low");
        assert.deepEqual(body.stream_options, { include_usage: true });
      }
      if (item.status === "completed") {
        const rows = await runtime.storage.read((view) => view.usageRows());
        assert.ok(rows.some((row) => row.input === 12 && row.output === 5 && row.totalTokens === 17));
      }
    } finally {
      runtime.close();
    }
  });
}

test("a streamed rate-limit failure stays in the tree but its tool calls never enter a retry request", async () => {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown; tool_calls?: unknown }> }> = [];
  let executions = 0;
  const models = createModels({ env: {} });
  models.setProvider(createProvider({
    id: "wire", baseUrl: "https://example.test/v1", auth: { env: "WIRE_KEY", ambient: "k" }, models: [model],
    api: openaiCompletionsApi({ fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
      if (bodies.length > 1) return sse("ok");
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "partial", tool_calls: [
          { index: 0, id: "call_1", function: { name: "work", arguments: "{}" } },
        ] } }] })}\n\n`,
        `data: ${JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit reached" } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
    } }),
  }));
  const runtime = new AgentHarness(new MemoryStorage(), {
    models, model: { provider: "wire", modelId: model.id }, maxAttempts: 2,
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
    tools: [{ name: "work", description: "work", parameters: { type: "object" }, execute: async () => {
      executions++; return { content: [] };
    } }],
  });
  try {
    const result = await runtime.lane().prompt("go");
    assert.equal(result.status, "completed");
    assert.equal(bodies.length, 2);
    assert.equal(executions, 0);
    assert.deepEqual(bodies[1]?.messages, bodies[0]?.messages);
    const assistants = await runtime.storage.read((view) => view.entries().flatMap((entry) =>
      entry.payload.type === "message" && entry.payload.message.role === "assistant" ? [entry.payload.message] : []));
    assert.deepEqual(assistants.map((message) => message.stopReason), ["error", "stop"]);
    assert.equal(assistants[0]?.content.some((block) => block.type === "toolCall"), true);
  } finally {
    runtime.close();
  }
});

test("malformed final tool arguments fail without executing or retrying", async () => {
  let calls = 0;
  let executions = 0;
  const models = createModels({ env: {} });
  models.setProvider(createProvider({
    id: "wire", baseUrl: "https://example.test/v1", auth: { env: "WIRE_KEY", ambient: "k" }, models: [model],
    api: openaiCompletionsApi({ fetch: async () => {
      calls++;
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
          { index: 0, id: "call_1", function: { name: "work", arguments: '{"value":' } },
        ] } }] })}\n\n`,
        'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""));
    } }),
  }));
  const runtime = new AgentHarness(new MemoryStorage(), {
    models, model: { provider: "wire", modelId: model.id }, maxAttempts: 2,
    tools: [{ name: "work", description: "work", parameters: { type: "object" }, execute: async () => {
      executions++; return { content: [] };
    } }],
  });
  try {
    const result = await runtime.lane().prompt("go");
    assert.equal(result.status, "failed");
    assert.equal(calls, 1);
    assert.equal(executions, 0);
  } finally {
    runtime.close();
  }
});
