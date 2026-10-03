import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type AgentMessage, type AgentTool } from "@amazme/agent";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall, type FauxResponder } from "@amazme/ai/providers/faux";

function echoTool(onRun?: () => void): AgentTool {
  return {
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute() {
      onRun?.();
      return { content: [{ type: "text", text: "original" }] };
    },
  };
}

function agentWith(respond: FauxResponder, tools: AgentTool[], options: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
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
    ...options,
  });
  return { agent, provider };
}

function userText(message: AgentMessage | undefined): string {
  return message?.role === "user" && typeof message.content === "string" ? message.content : "";
}

test("beforeToolCall block skips execute and records the reason", async () => {
  let runs = 0;
  let afterCalls = 0;
  const { agent, provider } = agentWith(
    (context, _options, state) => {
      if (state.callCount === 1) return fauxAssistant([fauxToolCall("echo", { text: "hi" })]);
      const tool = context.messages.find((message) => message.role === "toolResult");
      return fauxAssistant(tool ? messageText(tool) : "missing");
    },
    [echoTool(() => { runs += 1; })],
    {
      hooks: [
        {
          beforeToolCall: () => ({ action: "block", reason: "not allowed" }),
          afterToolCall: () => {
            afterCalls += 1;
            return undefined;
          },
        },
      ],
    },
  );
  const produced = await agent.prompt("go");
  assert.equal(runs, 0);
  assert.equal(afterCalls, 0);
  assert.equal(provider.state.callCount, 2);
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" && result.isError, true);
  assert.match(result?.role === "toolResult" ? messageText(result) : "", /not allowed/);
  assert.equal(Object.hasOwn(result ?? {}, "details"), false);
  const last = produced[produced.length - 1];
  assert.equal(last && last.role === "assistant" && last.content[0]?.type === "text" ? last.content[0].text : "", "not allowed");
});

test("abort during beforeToolCall skips execute and after", async () => {
  let runs = 0;
  let afters = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const { agent, provider } = agentWith(
    () => fauxAssistant([fauxToolCall("echo", { text: "hi" })]),
    [echoTool(() => { runs += 1; })],
    {
      hooks: [{
        beforeToolCall: async () => {
          markStarted();
          await gate;
          return undefined;
        },
        afterToolCall: () => {
          afters += 1;
          return undefined;
        },
      }],
    },
  );
  const pending = agent.prompt("go");
  try {
    await started;
    agent.abort();
    release();
    const produced = await pending;
    assert.equal(runs, 0);
    assert.equal(afters, 0);
    assert.equal(provider.state.callCount, 1);
    const result = produced.find((message) => message.role === "toolResult");
    assert.equal(result?.role === "toolResult" && result.isError, true);
    assert.match(result?.role === "toolResult" ? messageText(result) : "", /cancelled/);
  } finally {
    release();
    await pending.catch(() => undefined);
  }
});

test("afterToolCall replaces the executed result", async () => {
  let runs = 0;
  const { agent, provider } = agentWith(
    () => fauxAssistant([fauxToolCall("echo", { text: "hi" })]),
    [echoTool(() => { runs += 1; })],
    {
      hooks: [
        {
          afterToolCall: ({ result }) => ({
            content: [{ type: "text", text: `copy:${result.content[0]?.text ?? ""}` }],
            isError: true,
            terminate: true,
          }),
        },
      ],
    },
  );
  const produced = await agent.prompt("go");
  assert.equal(runs, 1);
  assert.equal(provider.state.callCount, 1);
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" ? messageText(result) : "", "copy:original");
  assert.equal(result?.role === "toolResult" && result.isError, true);
  assert.equal(Object.hasOwn(result ?? {}, "details"), false);
  assert.equal(Object.hasOwn(result ?? {}, "usage"), false);
});

test("transformContext reaches the model request and stays out of the transcript", async () => {
  const injected: AgentMessage = { role: "user", content: "injected-context", timestamp: 9 };
  const seenByTransform: string[][] = [];
  const seenByModel: string[][] = [];
  const { agent } = agentWith(
    (context, _options, state) => {
      seenByModel.push(context.messages.map((message) => messageText(message)));
      if (state.callCount === 1) return fauxAssistant([fauxToolCall("echo", { text: "hi" })]);
      return fauxAssistant("done");
    },
    [echoTool()],
    {
      prepareRequest: (input) => {
        const prompt = input.messages.find((message) => message.role === "user");
        if (prompt?.role === "user" && prompt.content === "hello") prompt.content = "hello recorded";
        return undefined;
      },
      hooks: [
        {
          transformContext: (messages) => {
            seenByTransform.push(messages.map((message) => (message.role === "custom" ? message.content : messageText(message))));
            return [...messages, injected];
          },
        },
      ],
    },
  );
  const recorded: AgentMessage[] = [];
  agent.subscribe((event) => {
    if (event.type === "message_end") recorded.push(event.message);
  });
  await agent.prompt("hello");
  assert.equal(seenByModel.length, 2);
  assert.equal(seenByTransform[0]?.includes("hello recorded"), true);
  assert.equal(seenByModel[0]?.includes("injected-context"), true);
  assert.equal(seenByModel[0]?.includes("hello recorded"), true);
  assert.equal(seenByModel[1]?.includes("injected-context"), true);
  assert.equal(seenByTransform[1]?.includes("injected-context"), false);
  assert.equal(agent.messages.some((message) => userText(message) === "injected-context"), false);
  assert.equal(recorded.some((message) => userText(message) === "injected-context"), false);
  assert.equal(userText(agent.messages.find((message) => message.role === "user")), "hello recorded");
  assert.equal(agent.messages.some((message) => message.role === "toolResult"), true);
});

test("prepareRequest message mutations stay in the agent transcript", async () => {
  const seen: string[] = [];
  const { agent } = agentWith(
    (context, _options, state) => {
      const user = context.messages.find((message) => message.role === "user" && typeof message.content === "string");
      seen.push(user && user.role === "user" && typeof user.content === "string" ? user.content : "");
      if (state.callCount === 1) return fauxAssistant([fauxToolCall("echo", { text: "hi" })]);
      return fauxAssistant("done");
    },
    [echoTool()],
    {
      prepareRequest: (input) => {
        const prompt = input.messages.find((message) => message.role === "user");
        if (prompt?.role === "user" && prompt.content === "hello") prompt.content = "hello recorded";
        return undefined;
      },
    },
  );
  await agent.prompt("hello");
  assert.deepEqual(seen, ["hello recorded", "hello recorded"]);
  const stored = agent.messages.find((message) => message.role === "user");
  assert.equal(userText(stored), "hello recorded");
});

test("the first blocking before stops later befores, execute, and after", async () => {
  let runs = 0;
  let secondBefore = 0;
  let afterCalls = 0;
  const { agent } = agentWith(
    (_context, _options, state) => state.callCount === 1
      ? fauxAssistant([fauxToolCall("echo", { text: "hi" })])
      : fauxAssistant("stopped"),
    [echoTool(() => { runs += 1; })],
    {
      hooks: [
        {
          beforeToolCall: () => ({ action: "block", reason: "first block" }),
          afterToolCall: () => {
            afterCalls += 1;
            return undefined;
          },
        },
        {
          beforeToolCall: () => {
            secondBefore += 1;
            return undefined;
          },
          afterToolCall: () => {
            afterCalls += 1;
            return undefined;
          },
        },
      ],
    },
  );
  const produced = await agent.prompt("go");
  assert.equal(secondBefore, 0);
  assert.equal(runs, 0);
  assert.equal(afterCalls, 0);
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" && result.isError, true);
  assert.match(result?.role === "toolResult" ? messageText(result) : "", /first block/);
  assert.equal(Object.hasOwn(result ?? {}, "details"), false);
});

test("the second after sees the text the first already replaced", async () => {
  let seen = "";
  let seenError = false;
  const { agent, provider } = agentWith(
    () => fauxAssistant([fauxToolCall("echo", { text: "hi" })]),
    [echoTool()],
    {
      hooks: [
        {
          afterToolCall: () => ({
            content: [{ type: "text", text: "replaced-once" }],
            isError: true,
          }),
        },
        {
          afterToolCall: ({ result }) => {
            seen = result.content[0]?.text ?? "";
            seenError = result.isError === true;
            return {
              content: [{ type: "text", text: `seen:${seen}` }],
              terminate: true,
            };
          },
        },
      ],
    },
  );
  const produced = await agent.prompt("go");
  assert.equal(seen, "replaced-once");
  assert.equal(seenError, true);
  assert.equal(provider.state.callCount, 1);
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" ? messageText(result) : "", "seen:replaced-once");
  assert.equal(result?.role === "toolResult" && result.isError, true);
  assert.equal(Object.hasOwn(result ?? {}, "details"), false);
  assert.equal(Object.hasOwn(result ?? {}, "usage"), false);
});

test("the second transform sees the first injection and the transcript does not keep either", async () => {
  const first: AgentMessage = { role: "user", content: "injected-first", timestamp: 1 };
  const second: AgentMessage = { role: "user", content: "injected-second", timestamp: 2 };
  const seenBySecond: string[][] = [];
  const seenByModel: string[][] = [];
  const { agent } = agentWith(
    (context, _options, state) => {
      seenByModel.push(context.messages.map((message) => messageText(message)));
      if (state.callCount === 1) return fauxAssistant([fauxToolCall("echo", { text: "hi" })]);
      return fauxAssistant("done");
    },
    [echoTool()],
    {
      hooks: [
        {
          transformContext: (messages) => [...messages, first],
        },
        {
          transformContext: (messages) => {
            seenBySecond.push(messages.map((message) => (message.role === "custom" ? message.content : messageText(message))));
            return [...messages, second];
          },
        },
      ],
    },
  );
  const recorded: AgentMessage[] = [];
  agent.subscribe((event) => {
    if (event.type === "message_end") recorded.push(event.message);
  });
  const produced = await agent.prompt("hello");
  assert.equal(seenBySecond[0]?.includes("injected-first"), true);
  assert.equal(seenBySecond[0]?.includes("injected-second"), false);
  assert.equal(seenByModel[0]?.includes("injected-first"), true);
  assert.equal(seenByModel[0]?.includes("injected-second"), true);
  assert.equal(seenBySecond[1]?.includes("injected-second"), false);
  assert.equal(agent.messages.some((message) => userText(message) === "injected-first"), false);
  assert.equal(agent.messages.some((message) => userText(message) === "injected-second"), false);
  assert.equal(recorded.some((message) => userText(message) === "injected-first"), false);
  assert.equal(recorded.some((message) => userText(message) === "injected-second"), false);
  assert.equal(produced.some((message) => userText(message) === "injected-first"), false);
  assert.equal(produced.some((message) => userText(message) === "injected-second"), false);
});
