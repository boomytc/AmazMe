import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type AgentMessage, type AgentTool } from "@amazme/agent";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall, type FauxResponder } from "@amazme/ai/providers/faux";

function echoTool(options: { terminate?: boolean } = {}): AgentTool {
  return {
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(args) {
      const text = typeof args === "object" && args && "text" in args ? String((args as { text: unknown }).text) : "";
      return { content: [{ type: "text", text }], terminate: options.terminate === true };
    },
  };
}

function agentWith(respond: FauxResponder, tools: AgentTool[] = [], options: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
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

function userTexts(messages: readonly { role: string; content?: unknown }[]): string[] {
  return messages.flatMap((message) => (message.role === "user" && typeof message.content === "string" ? [message.content] : []));
}

test("the first onYield appends one user message and asks the model once more", async () => {
  let first = 0;
  let later = 0;
  let laterAtSecondRequest = -1;
  const seen: string[][] = [];
  const { agent, provider } = agentWith(
    (context, _options, state) => {
      if (state.callCount === 2) laterAtSecondRequest = later;
      seen.push(userTexts(context.messages));
      return fauxAssistant(state.callCount === 1 ? "answer-1" : "answer-2");
    },
    [],
    {
      hooks: [
        {
          onYield: () => {
            first += 1;
            return first === 1 ? "again" : undefined;
          },
        },
        {
          onYield: () => {
            later += 1;
            return undefined;
          },
        },
      ],
    },
  );
  const produced = await agent.prompt("go");
  assert.equal(provider.state.callCount, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.includes("again"), true);
  assert.equal(laterAtSecondRequest, 0);
  assert.equal(later, 1);
  assert.equal(first, 2);
  const again = produced.filter((message) => userText(message) === "again");
  assert.equal(again.length, 1);
  assert.equal(agent.messages.filter((message) => userText(message) === "again").length, 1);
  const last = produced[produced.length - 1];
  assert.equal(last && last.role === "assistant" && last.content[0]?.type === "text" ? last.content[0].text : "", "answer-2");
});

test("whitespace does not win and the next onYield can append", async () => {
  let second = 0;
  const { agent, provider } = agentWith(
    (_context, _options, state) => fauxAssistant(state.callCount === 1 ? "answer-1" : "answer-2"),
    [],
    {
      hooks: [
        { onYield: () => "  \n" },
        {
          onYield: () => {
            second += 1;
            return second === 1 ? "again" : undefined;
          },
        },
      ],
    },
  );
  const produced = await agent.prompt("go");
  assert.equal(provider.state.callCount, 2);
  assert.equal(second, 2);
  assert.equal(produced.filter((message) => userText(message) === "again").length, 1);
  assert.equal(produced.some((message) => message.role === "user" && userText(message).trim() === ""), false);
  assert.equal(provider.state.contexts[1] ? userTexts(provider.state.contexts[1].messages).includes("again") : false, true);
});

test("onYield that returns nothing completes after one request", async () => {
  let calls = 0;
  const { agent, provider } = agentWith(() => fauxAssistant("answer"), [], {
    hooks: [
      {
        onYield: () => {
          calls += 1;
          return undefined;
        },
      },
      {
        onYield: () => {
          calls += 1;
          return " \t";
        },
      },
    ],
  });
  const produced = await agent.prompt("go");
  assert.equal(provider.state.callCount, 1);
  assert.equal(calls, 2);
  assert.equal(produced.filter((message) => message.role === "user").length, 1);
  assert.equal(userText(produced.find((message) => message.role === "user")), "go");
});

test("a queued steer or follow-up runs and onYield is not called at that stop", async () => {
  const yieldsAt: number[] = [];
  const seen: string[][] = [];
  const steered = agentWith(
    (context, _options, state) => {
      seen.push(userTexts(context.messages));
      if (state.callCount === 1) {
        steered.agent.steer("steer-msg");
        return fauxAssistant("first");
      }
      return fauxAssistant("after-steer");
    },
    [],
    {
      hooks: [{
        onYield: () => {
          yieldsAt.push(steered.provider.state.callCount);
          return undefined;
        },
      }],
    },
  );
  await steered.agent.prompt("go");
  assert.equal(steered.provider.state.callCount, 2);
  assert.deepEqual(yieldsAt, [2]);
  assert.equal(seen[1]?.includes("steer-msg"), true);
  assert.equal(seen[1]?.includes("again"), false);

  const followedAt: number[] = [];
  const followedSeen: string[][] = [];
  const followed = agentWith(
    (context, _options, state) => {
      followedSeen.push(userTexts(context.messages));
      if (state.callCount === 1) {
        followed.agent.followUp("follow-msg");
        return fauxAssistant("first");
      }
      return fauxAssistant("after-follow");
    },
    [],
    {
      hooks: [{
        onYield: () => {
          followedAt.push(followed.provider.state.callCount);
          return undefined;
        },
      }],
    },
  );
  const produced = await followed.agent.prompt("go");
  assert.equal(followed.provider.state.callCount, 2);
  assert.deepEqual(followedAt, [2]);
  assert.equal(followedSeen[1]?.includes("follow-msg"), true);
  assert.equal(produced.some((message) => userText(message) === "again"), false);
});

test("a tool turn and a terminating turn do not call onYield", async () => {
  const toolYields: number[] = [];
  const toolRun = agentWith(
    (_context, _options, state) => state.callCount === 1 ? fauxAssistant([fauxToolCall("echo", { text: "hi" })]) : fauxAssistant("done"),
    [echoTool()],
    {
      hooks: [{
        onYield: () => {
          toolYields.push(toolRun.provider.state.callCount);
          return undefined;
        },
      }],
    },
  );
  const toolProduced = await toolRun.agent.prompt("go");
  assert.deepEqual(toolYields, [2]);
  assert.equal(toolRun.provider.state.callCount, 2);
  assert.equal(toolProduced.some((message) => userText(message) === "again"), false);
  const second = toolRun.provider.state.contexts[1];
  assert.equal(second?.messages.some((message) => message.role === "toolResult"), true);

  let terminateYields = 0;
  const stopped = agentWith(
    () => fauxAssistant([fauxToolCall("echo", { text: "final" })]),
    [echoTool({ terminate: true })],
    {
      hooks: [{
        onYield: () => {
          terminateYields += 1;
          throw new Error("onYield during terminate");
        },
      }],
    },
  );
  const produced = await stopped.agent.prompt("stop");
  assert.equal(terminateYields, 0);
  assert.equal(stopped.provider.state.callCount, 1);
  assert.equal(produced.some((message) => userText(message) === "again"), false);
});

test("onYield throw appends nothing and does not request the model again", async () => {
  let calls = 0;
  const { agent, provider } = agentWith(() => fauxAssistant("answer"), [], {
    hooks: [{
      onYield: () => {
        calls += 1;
        throw new Error("yield boom");
      },
    }],
  });
  await assert.rejects(agent.prompt("go"), /yield boom/);
  assert.equal(calls, 1);
  assert.equal(provider.state.callCount, 1);
  assert.equal(provider.state.contexts.length, 1);
  assert.equal(agent.messages.some((message) => userText(message) === "again"), false);
  assert.equal(agent.messages.filter((message) => message.role === "user").length, 1);
});

for (const text of ["again", undefined]) {
  test(`abort while onYield waits discards ${text === undefined ? "an empty result" : "the returned text"}`, async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = () => {};
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    let laterHooks = 0;
    const { agent, provider } = agentWith(() => fauxAssistant("answer"), [], {
      hooks: [{ onYield: async () => { started(); await gate; return text; } }, {
        onYield: () => { laterHooks += 1; return "later"; },
      }],
    });
    const pending = agent.prompt("go");
    try {
      await waiting;
      agent.abort();
      release();
      await pending;
      assert.equal(provider.state.callCount, 1);
      assert.deepEqual(userTexts(agent.messages), ["go"]);
      assert.equal(laterHooks, 0);
    } finally {
      release();
      await pending.catch(() => undefined);
    }
  });

  for (const kind of ["steer", "followUp"] as const) {
    test(`${kind} arriving during onYield takes precedence over ${text === undefined ? "an empty result" : "returned text"}`, async () => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started = () => {};
      const waiting = new Promise<void>((resolve) => { started = resolve; });
      let yields = 0;
      const { agent, provider } = agentWith(() => fauxAssistant("answer"), [], {
        hooks: [{ onYield: async () => {
          if (++yields !== 1) return undefined;
          started();
          await gate;
          return text;
        } }],
      });
      const pending = agent.prompt("go");
      try {
        await waiting;
        agent[kind]("queued");
        release();
        await pending;
        assert.equal(provider.state.callCount, 2);
        assert.deepEqual(userTexts(provider.state.contexts[1]?.messages ?? []), ["go", "queued"]);
        assert.deepEqual(userTexts(agent.messages), ["go", "queued"]);
      } finally {
        release();
        await pending.catch(() => undefined);
      }
    });
  }
}

test("abort from a yielded message event keeps the accepted message without another request", async () => {
  const { agent, provider } = agentWith(() => fauxAssistant("answer"), [], {
    hooks: [{ onYield: () => "again" }],
  });
  let ended = 0;
  agent.subscribe((event) => {
    if (event.type === "message_start" && userText(event.message) === "again") agent.abort();
    if (event.type === "message_end" && userText(event.message) === "again") ended += 1;
  });
  await agent.prompt("go");
  assert.equal(provider.state.callCount, 1);
  assert.equal(ended, 1);
  assert.deepEqual(userTexts(agent.messages), ["go", "again"]);
});

test("Agent does not accept finishTurn", () => {
  const { agent } = agentWith(() => fauxAssistant("ok"));
  assert.equal(Object.hasOwn(agent, "finishTurn"), false);
  const provider = fauxProvider();
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  new Agent({
    model,
    streamFn: models.streamSimple.bind(models),
    // @ts-expect-error finishTurn has been removed
    finishTurn: () => ({ action: "continue" }),
  });
});
