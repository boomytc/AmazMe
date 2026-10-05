import assert from "node:assert/strict";
import test from "node:test";
import { createModels, ModelsError, usageCost, type ClassifierContext } from "@amazme/ai";
import { cloudflareWorkersAIProvider } from "@amazme/ai/providers/cloudflare-workers-ai";
import { typesafeProvider } from "@amazme/ai/providers/typesafe";

const KEY = "typesafe-test-key";

/** Cloudflare docs sample for `typesafe/jev`: noul, choice, and score in one response. */
const OFFICIAL_STATE = "Help! My payouts have been failing for 3 days.";

const officialContext: ClassifierContext = {
  state: OFFICIAL_STATE,
  questions: {
    is_urgent: {
      type: "bool",
      instructions: "Does this convey urgency?",
      criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" },
    },
    department: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Payments, invoicing, refunds",
        technical: "Bugs, outages, integrations",
        sales: "Pricing, upgrades, new accounts",
      },
    },
    frustration: {
      type: "score",
      instructions: "How frustrated is the customer?",
      criteria: ["Calm", "Frustrated", "Very angry"],
    },
  },
};

const officialBody = {
  model: "jev-1.13.0",
  answers: {
    is_urgent: { type: "noul", noul: 0.95 },
    department: {
      type: "choice",
      choice: "billing",
      confidence: 0.8,
      probabilities: { billing: 0.87, sales: 0, technical: 0.13 },
    },
    frustration: {
      type: "score",
      score: 1.04,
      confidence: 0.94,
      legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      probabilities: { "0": 0, "1": 0.96, "2": 0.04 },
    },
  },
  usage: { input_tokens: 426, output_tokens: 73 },
};

function typesafeModels(fetchImpl: typeof fetch, env: Record<string, string> = { TYPESAFE_API_KEY: KEY }) {
  const models = createModels({ env });
  models.setProvider(typesafeProvider({ fetch: fetchImpl }));
  const classifier = models.getClassifier("typesafe", "jev-latest");
  assert.ok(classifier);
  return { models, classifier };
}

test("jev-latest publishes the list price and a 64000 token window", () => {
  const { classifier } = typesafeModels(async () => new Response("unused"));
  assert.equal(classifier.contextWindow, 64_000);
  assert.deepEqual(classifier.cost, { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(classifier.api, "typesafe-system-one");
});

test("official noul, choice, and score samples map to typed answers and priced usage", async () => {
  let body = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${KEY}`);
    body = String(init?.body);
    return Response.json(officialBody);
  };
  const { models, classifier } = typesafeModels(fetchImpl);
  const result = await models.classify(classifier, officialContext);
  const sent = JSON.parse(body) as {
    model?: string;
    state?: unknown;
    questions?: {
      is_urgent?: { type?: string; criteria?: unknown };
      department?: { type?: string };
      frustration?: { type?: string; criteria?: unknown };
    };
  };
  assert.equal(sent.model, "jev-latest");
  assert.equal(sent.state, OFFICIAL_STATE);
  assert.equal(sent.questions?.is_urgent?.type, "noul");
  assert.deepEqual(sent.questions?.is_urgent?.criteria, officialContext.questions.is_urgent?.criteria);
  assert.equal(sent.questions?.department?.type, "choice");
  assert.deepEqual(sent.questions?.frustration?.criteria, officialContext.questions.frustration?.criteria);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.answers.is_urgent, { type: "bool", probability: 0.95 });
  assert.deepEqual(result.answers.department, {
    type: "choice",
    choice: "billing",
    confidence: 0.8,
    probabilities: { billing: 0.87, sales: 0, technical: 0.13 },
  });
  assert.deepEqual(result.answers.frustration, {
    type: "score",
    score: 1.04,
    confidence: 0.94,
    legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
    probabilities: { "0": 0, "1": 0.96, "2": 0.04 },
  });
  const priced = usageCost(classifier, { input: 426, output: 73 });
  assert.ok(priced);
  assert.equal(priced.output, 0);
  assert.equal(priced.cacheRead, 0);
  assert.equal(priced.cacheWrite, 0);
  assert.equal(priced.total, priced.input);
  assert.deepEqual(result.usage, {
    input: 426,
    output: 73,
    totalTokens: 499,
    cost: { input: priced.input, output: priced.output, total: priced.total },
  });
});

test("state, instructions, and criteria may be structured JSON", async () => {
  const seen: unknown[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen.push(JSON.parse(String(init?.body)));
    return Response.json({
      answers: { is_urgent: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 3, output_tokens: 0 },
    });
  };
  const { models, classifier } = typesafeModels(fetchImpl);
  const cases: ClassifierContext[] = [
    {
      state: "plain",
      questions: { is_urgent: { type: "bool", instructions: "now?" } },
    },
    {
      state: { ticket: { id: "A-104" }, charges: [49, 49] },
      questions: {
        is_urgent: {
          type: "bool",
          instructions: { goal: "refund" },
          criteria: { true: { kind: "time" }, false: ["none"] },
        },
      },
    },
    {
      state: ["Help!", { ticket: "A-104" }],
      questions: {
        is_urgent: {
          type: "bool",
          instructions: ["line", { text: "urgent" }],
        },
      },
    },
  ];
  for (const context of cases) {
    const result = await models.classify(classifier, context);
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(result.answers.is_urgent, { type: "bool", probability: 0.5 });
  }
  assert.equal((seen[0] as { state?: unknown }).state, "plain");
  const objectCall = seen[1] as { state?: unknown; questions?: { is_urgent?: { type?: string; instructions?: unknown; criteria?: unknown } } };
  assert.deepEqual(objectCall.state, { ticket: { id: "A-104" }, charges: [49, 49] });
  assert.equal(objectCall.questions?.is_urgent?.type, "noul");
  assert.deepEqual(objectCall.questions?.is_urgent?.instructions, { goal: "refund" });
  assert.deepEqual(objectCall.questions?.is_urgent?.criteria, { true: { kind: "time" }, false: ["none"] });
  const arrayCall = seen[2] as { state?: unknown; questions?: { is_urgent?: { instructions?: unknown } } };
  assert.deepEqual(arrayCall.state, ["Help!", { ticket: "A-104" }]);
  assert.deepEqual(arrayCall.questions?.is_urgent?.instructions, ["line", { text: "urgent" }]);
});

test("a 429 is retried and the following 200 is the result", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("slow down", { status: 429 });
    return Response.json(officialBody);
  };
  const { models, classifier } = typesafeModels(fetchImpl);
  const result = await models.classify(classifier, officialContext);
  assert.equal(calls, 2);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.answers.is_urgent && result.answers.is_urgent.type === "bool" ? result.answers.is_urgent.probability : 0, 0.95);
});

test("529 is retried twice and the error keeps a truncated body without the API key", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(`overloaded ${KEY} please retry ${"x".repeat(500)}`, { status: 529 });
  };
  const { models, classifier } = typesafeModels(fetchImpl);
  const result = await models.classify(classifier, officialContext);
  assert.equal(calls, 3);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /529/);
  assert.match(result.errorMessage ?? "", /overloaded/);
  assert.equal((result.errorMessage ?? "").includes(KEY), false);
  assert.ok((result.errorMessage ?? "").length < 500);
});

test("an aborted signal returns aborted and does not throw", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return Response.json(officialBody);
  };
  const { models, classifier } = typesafeModels(fetchImpl);
  const controller = new AbortController();
  controller.abort();
  const result = await models.classify(classifier, officialContext, { signal: controller.signal });
  assert.equal(calls, 0);
  assert.equal(result.stopReason, "aborted");
  assert.equal((result.errorMessage ?? "").includes(KEY), false);

  const inflight = new AbortController();
  let started = 0;
  const stall: typeof fetch = (_input, init) => {
    started += 1;
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const fail = () => reject(new DOMException("The operation was aborted", "AbortError"));
      if (!signal || signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
      inflight.abort();
    });
  };
  const second = typesafeModels(stall);
  const aborted = await second.models.classify(second.classifier, officialContext, { signal: inflight.signal });
  assert.equal(started, 1);
  assert.equal(aborted.stopReason, "aborted");
});

test("a bad answer is an error result and still carries priced usage", async () => {
  const fetchImpl: typeof fetch = async () => Response.json({
    answers: { is_urgent: { type: "noul", noul: "high" } },
    usage: { input_tokens: 426, output_tokens: 73 },
  });
  const { models, classifier } = typesafeModels(fetchImpl);
  const result = await models.classify(classifier, {
    state: OFFICIAL_STATE,
    questions: { is_urgent: { type: "bool", instructions: "Does this convey urgency?" } },
  });
  assert.equal(result.stopReason, "error");
  assert.deepEqual(result.answers, {});
  assert.match(result.errorMessage ?? "", /is_urgent/);
  const priced = usageCost(classifier, { input: 426, output: 73 });
  assert.ok(priced);
  assert.equal(priced.total, priced.input);
  assert.deepEqual(result.usage, {
    input: 426,
    output: 73,
    totalTokens: 499,
    cost: { input: priced.input, output: 0, total: priced.total },
  });
});

test("TYPESAFE_JEV_API_KEY is not an API key", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return Response.json(officialBody);
  };
  const { models, classifier } = typesafeModels(fetchImpl, { TYPESAFE_JEV_API_KEY: KEY });
  await assert.rejects(
    () => models.classify(classifier, officialContext),
    (error: unknown) => error instanceof ModelsError && error.code === "auth",
  );
  assert.equal(calls, 0);
});

test("Cloudflare Workers AI uses the same typed answers and keeps usage", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://api.cloudflare.com/client/v4/accounts/acct/ai/run");
    const sent = JSON.parse(String(init?.body)) as { model?: string; input?: { questions?: { is_urgent?: { type?: string } } } };
    assert.equal(sent.model, "typesafe/jev");
    assert.equal(sent.input?.questions?.is_urgent?.type, "noul");
    return Response.json({
      success: true,
      result: { state: "Completed", result: officialBody },
    });
  };
  const models = createModels({ env: { CLOUDFLARE_API_KEY: "cf-key", CLOUDFLARE_ACCOUNT_ID: "acct" } });
  models.setProvider(cloudflareWorkersAIProvider({ fetch: fetchImpl }));
  const classifier = models.getClassifier("cloudflare-workers-ai", "typesafe/jev");
  assert.ok(classifier);
  const result = await models.classify(classifier, officialContext);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.answers.is_urgent, { type: "bool", probability: 0.95 });
  assert.equal(result.answers.department?.type, "choice");
  assert.equal(result.answers.frustration?.type, "score");
  assert.equal(result.usage?.input, 426);
  assert.equal(result.usage?.output, 73);
});

test("Cloudflare returns aborted when the request is aborted", async () => {
  const models = createModels({ env: { CLOUDFLARE_API_KEY: "cf-key", CLOUDFLARE_ACCOUNT_ID: "acct" } });
  models.setProvider(cloudflareWorkersAIProvider({ fetch: async () => Response.json(officialBody) }));
  const classifier = models.getClassifier("cloudflare-workers-ai", "typesafe/jev");
  assert.ok(classifier);
  const controller = new AbortController();
  controller.abort();
  const result = await models.classify(classifier, officialContext, { signal: controller.signal });
  assert.equal(result.stopReason, "aborted");
});
