import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@amazme/agent";
import { createModels, type Model } from "@amazme/ai";
import { openaiProvider } from "@amazme/ai/providers/openai";

interface WireMessage {
  role: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string }>;
}

for (const failure of ["assistant", "subscriber"] as const) {
  test(`the next request is valid after a ${failure} failure without rewriting Agent history`, async () => {
    const requests: Array<{ messages: WireMessage[] }> = [];
    const models = createModels({ env: { OPENAI_API_KEY: "k" } });
    models.setProvider(openaiProvider({ fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as typeof requests[number]);
      if (requests.length === 1) return new Response([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"work","arguments":"{}"}}]}}]}\n\n',
        failure === "assistant"
          ? 'data: {"error":{"type":"server_error","message":"interrupted"}}\n\n'
          : 'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""));
      return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } }));
    const model: Model | undefined = models.getModel("openai", "gpt-4o-mini");
    assert.ok(model);
    let executions = 0;
    const agent = new Agent({
      model, streamFn: models.streamSimple.bind(models),
      tools: [{ name: "work", description: "work", parameters: { type: "object" }, execute: async (_args, context) => {
        executions++; context.onUpdate?.("partial"); return { content: [] };
      } }],
    });
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "tool_execution_update") throw new Error("subscriber failed");
    });
    if (failure === "subscriber") await assert.rejects(agent.prompt("first"), /subscriber failed/);
    else await agent.prompt("first");
    await agent.waitForIdle();
    unsubscribe();
    assert.equal(agent.messages.some((message) => message.role === "toolResult"), false);
    const priorMessages = agent.messages.slice();
    const history = JSON.stringify(priorMessages);
    const answer = await agent.prompt("next");
    const last = answer.at(-1);
    assert.equal(last?.role === "assistant" && last.stopReason, "stop");
    assert.equal(executions, failure === "subscriber" ? 1 : 0);
    const sent = requests[1]?.messages;
    assert.ok(sent);
    if (failure === "assistant") assert.deepEqual(sent.map((message) => message.role), ["system", "user", "user"]);
    else {
      const index = sent.findIndex((message) => message.tool_calls?.length);
      assert.equal(sent[index + 1]?.role, "tool");
      assert.equal(sent[index + 1]?.tool_call_id, sent[index]?.tool_calls?.[0]?.id);
      assert.equal(sent[index + 2]?.role, "user");
    }
    assert.equal(JSON.stringify(agent.messages.slice(0, priorMessages.length)), history);
    assert.equal(agent.messages.some((message) => message.role === "toolResult"), false);
  });
}
