import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantEventStream,
  createModels,
  fauxAssistant,
  fauxProvider,
  fauxToolCall,
  frameFromEvent,
  MemoryCredentialStore,
  messageFromFrames,
  normalizeToolCallId,
  openaiProvider,
  reduceFrames,
  resolveApiKey,
  transformMessages,
  type AssistantEvent,
  type Model,
} from "@amazme/ai";

const textModel: Model = {
  id: "m",
  name: "m",
  provider: "openai",
  api: "openai-completions",
  input: ["text"],
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 1, output: 1 },
};

test("auth prefers the request key, then the stored credential, and never falls through a stored credential to the environment", async () => {
  const store = new MemoryCredentialStore();
  await store.set("openai", { type: "api_key", key: "stored" });
  const stored = await resolveApiKey({
    providerId: "openai",
    auth: { env: "OPENAI_API_KEY" },
    store,
    env: { OPENAI_API_KEY: "from-env" },
  });
  assert.equal(stored?.apiKey, "stored");
  assert.equal(stored?.source, "store");

  const request = await resolveApiKey({
    providerId: "openai",
    auth: { env: "OPENAI_API_KEY" },
    store,
    env: { OPENAI_API_KEY: "from-env" },
    apiKey: "request",
  });
  assert.equal(request?.source, "request");

  const empty = new MemoryCredentialStore();
  const fromEnv = await resolveApiKey({
    providerId: "openai",
    auth: { env: "OPENAI_API_KEY" },
    store: empty,
    env: { OPENAI_API_KEY: "from-env" },
  });
  assert.equal(fromEnv?.source, "env");
});

test("transformMessages rewrites tool ids and drops images the destination cannot see", () => {
  const longId = `call_${"abc|def_".repeat(20)}`;
  const normalized = normalizeToolCallId(longId);
  assert.match(normalized, /^[a-zA-Z0-9_-]+$/);
  assert.ok(normalized.length <= 64);

  const messages = transformMessages(
    [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "aaaa" }], timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: longId, name: "read", arguments: { path: "a" } }],
        api: "openai-responses",
        provider: "openai",
        model: "x",
        usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: longId,
        toolName: "read",
        content: [{ type: "text", text: "body" }, { type: "image", mimeType: "image/png", data: "bbbb" }],
        isError: false,
        timestamp: 3,
      },
    ],
    textModel,
  );
  const user = messages[0];
  assert.ok(user && user.role === "user" && Array.isArray(user.content));
  assert.equal(user.content.some((block) => block.type === "image"), false);
  const assistant = messages[1];
  assert.ok(assistant && assistant.role === "assistant");
  const call = assistant.content.find((block) => block.type === "toolCall");
  const tool = messages[2];
  assert.ok(call && call.type === "toolCall");
  assert.ok(tool && tool.role === "toolResult");
  assert.equal(tool.toolCallId, call.id);
  assert.equal(assistant.content.some((block) => block.type === "thinking"), false);
});

test("frames rebuild text without treating a stop frame as settlement", () => {
  const events: AssistantEvent[] = [
    { type: "text_delta", delta: "hello ", partial: fauxAssistant("hello ") },
    { type: "text_delta", delta: "world", partial: fauxAssistant("hello world") },
    { type: "toolcall_end", contentIndex: 1, toolCall: fauxToolCall("read", { path: "a" }, "call_1"), partial: fauxAssistant("hello world") },
    { type: "done", reason: "stop", message: fauxAssistant("hello world") },
  ];
  const frames = events.map((event) => frameFromEvent(event)).filter((frame) => frame !== undefined);
  const reduced = reduceFrames(frames);
  assert.equal(reduced.content[0]?.type === "text" ? reduced.content[0].text : "", "hello world");
  assert.equal(reduced.stopReason, "stop");
  const recovered = messageFromFrames({ api: "faux", provider: "faux", id: "faux-1" }, frames.filter((frame) => frame.type !== "stop"));
  assert.equal(recovered.stopReason, "aborted");
});

test("models routes a request to the provider that owns the model and resolves its auth", async () => {
  const store = new MemoryCredentialStore();
  const models = createModels({ store, env: { OPENAI_API_KEY: "sk-test" } });
  const seen: string[] = [];
  models.setProvider(
    openaiProvider({
      fetch: async (_url, init) => {
        const headers = new Headers(init?.headers);
        seen.push(headers.get("authorization") ?? "");
        const body = [
          'data: {"choices":[{"delta":{"content":"Hi"}}]}',
          "",
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n");
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    }),
  );
  const model = models.getModel("openai", "gpt-4o-mini");
  assert.ok(model);
  const message = await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
  assert.equal(message.content[0]?.type === "text" ? message.content[0].text : "", "Hi");
  assert.equal(seen[0], "Bearer sk-test");
  const missing = await models.completeSimple({ ...model, provider: "missing" }, { messages: [] });
  assert.equal(missing.stopReason, "error");
  assert.match(missing.errorMessage ?? "", /Unknown provider: missing/);
});

test("openai completions reassembles streamed tool call arguments", async () => {
  const models = createModels({ env: { OPENAI_API_KEY: "sk" } });
  let sent = "";
  models.setProvider(
    openaiProvider({
      fetch: async (_url, init) => {
        sent = String(init?.body ?? "");
        return new Response(
          [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":""}}]}}]}',
            "",
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
            "",
            'data: {"choices":[{"finish_reason":"tool_calls"}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { status: 200 },
        );
      },
    }),
  );
  const model = models.getModel("openai", "gpt-4o-mini");
  assert.ok(model);
  const rawId = "bad|id";
  const message = await models.completeSimple(model, {
    systemPrompt: "Be brief",
    messages: [
      { role: "system", content: "Be brief", timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "aaaa" }], timestamp: 2 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "toolCall", id: rawId, name: "read", arguments: { path: "a" } },
        ],
        api: "openai-completions",
        provider: "openai",
        model: model.id,
        usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: rawId,
        toolName: "read",
        content: [{ type: "text", text: "body" }],
        isError: false,
        timestamp: 4,
      },
      { role: "user", content: "read a", timestamp: 5 },
    ],
    tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
  });
  const body = JSON.parse(sent) as {
    messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>;
  };
  assert.equal(body.messages.filter((item) => item.role === "system" && item.content === "Be brief").length, 1);
  assert.equal(sent.includes("aaaa"), false);
  assert.equal(sent.includes(rawId), false);
  assert.match(sent, /hmm/);
  const assistant = body.messages.find((item) => item.role === "assistant");
  const tool = body.messages.find((item) => item.role === "tool");
  assert.equal(tool?.tool_call_id, assistant?.tool_calls?.[0]?.id);
  const call = message.content.find((block) => block.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  assert.equal(call.name, "read");
  assert.deepEqual(call.arguments, { path: "a.txt" });
  assert.equal(message.stopReason, "toolUse");
});

test("faux streams text deltas and records the transcript it was given", async () => {
  const provider = fauxProvider({
    respond: (_context, _options, _state, model) => fauxAssistant("abcdefghijk"),
  });
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  const stream = models.streamSimple(model, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }] });
  const deltas: string[] = [];
  for await (const event of stream) {
    if (event.type === "text_delta") deltas.push(event.delta);
  }
  assert.deepEqual(deltas.join(""), "abcdefghijk");
  assert.equal(provider.state.callCount, 1);
  assert.equal(provider.state.contexts[0]?.systemPrompt, "sys");
  const manual = createAssistantEventStream();
  manual.end(fauxAssistant("x"));
  assert.equal((await manual.result()).role, "assistant");
});
