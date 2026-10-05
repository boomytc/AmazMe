import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type AssistantEvent, type AssistantMessage, type Model, type StreamOptions } from "@amazme/ai";
import { checkAssistantStream } from "@amazme/ai/testing";
import { anthropicMessagesApi } from "@amazme/ai/api/anthropic-messages";
import { azureOpenAIResponsesApi } from "@amazme/ai/api/azure-openai-responses";
import { googleGenerativeAIApi } from "@amazme/ai/api/google-generative-ai";
import { openAICodexResponsesApi } from "@amazme/ai/api/openai-codex-responses";
import { openAIResponsesApi } from "@amazme/ai/api/openai-responses";
import { deepseekProvider } from "@amazme/ai/providers/deepseek";

const CONTEXT = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
const SHORT_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function recorded<TApi extends Model["api"]>(api: TApi, provider = "recorded"): Model<TApi> {
  return {
    id: "recorded",
    name: "recorded",
    provider,
    api,
    input: ["text"],
    contextWindow: 8_000,
    maxTokens: 1_000,
    cost: { input: 1_000_000, output: 2_000_000 },
  };
}

function httpError(retryAfter: string | undefined): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (retryAfter !== undefined) headers.set("Retry-After", retryAfter);
  return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers });
}

function utcTime(date: Date): string {
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function rfc850(ms: number): string {
  const date = new Date(ms);
  const day = LONG_DAY[date.getUTCDay()];
  const month = MONTH[date.getUTCMonth()];
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const yy = String(date.getUTCFullYear() % 100).padStart(2, "0");
  return `${day}, ${dd}-${month}-${yy} ${utcTime(date)} GMT`;
}

function asctime(ms: number): string {
  const date = new Date(ms);
  const day = SHORT_DAY[date.getUTCDay()];
  const month = MONTH[date.getUTCMonth()];
  const dateNum = date.getUTCDate();
  const dd = dateNum < 10 ? ` ${dateNum}` : String(dateNum);
  return `${day} ${month} ${dd} ${utcTime(date)} ${date.getUTCFullYear()}`;
}

interface FailureApi<TApi extends Model["api"]> {
  stream(
    model: Model<TApi>,
    context: typeof CONTEXT,
    options?: StreamOptions,
  ): AsyncIterable<AssistantEvent> & { result(): Promise<AssistantMessage> };
}

async function failure<TApi extends Model["api"]>(
  name: string,
  open: (fetchImpl: typeof fetch) => FailureApi<TApi>,
  model: Model<TApi>,
  baseUrl: string,
  retryAfter: string | undefined,
): Promise<AssistantMessage> {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return httpError(retryAfter);
  };
  const stream = open(fetchImpl).stream(model, CONTEXT, { apiKey: "test-key", baseUrl });
  return collected(name, stream, () => calls);
}

async function deepseekFailure(retryAfter: string | undefined): Promise<AssistantMessage> {
  let calls = 0;
  const models = createModels({ env: { DEEPSEEK_API_KEY: "sk-replay" } });
  models.setProvider(deepseekProvider({
    fetch: async () => {
      calls += 1;
      return httpError(retryAfter);
    },
  }));
  const model = models.getModel("deepseek", "deepseek-flash");
  assert.ok(model);
  const message = await collected(
    "openai-completions",
    models.stream(model, CONTEXT, { thinkingLevel: "high" }),
    () => calls,
  );
  assert.equal(message.api, "openai-completions");
  assert.equal(message.provider, "deepseek");
  return message;
}

async function collected(
  name: string,
  stream: AsyncIterable<AssistantEvent> & { result(): Promise<AssistantMessage> },
  calls: () => number,
): Promise<AssistantMessage> {
  const events: AssistantEvent[] = [];
  const finished = (async () => {
    for await (const event of stream) events.push(event);
  })();
  const message = await Promise.race([
    stream.result(),
    new Promise<AssistantMessage>((_, reject) => setTimeout(() => reject(new Error(`${name} hung`)), 1000)),
  ]);
  await finished;
  assert.equal(calls(), 1, name);
  assert.equal(message.stopReason, "error", name);
  assert.deepEqual(checkAssistantStream(events), [], name);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error", name);
  if (terminal?.type === "error") {
    assert.equal(Object.hasOwn(terminal.error, "retryAfterMs"), Object.hasOwn(message, "retryAfterMs"), name);
    assert.equal(terminal.error.retryAfterMs, message.retryAfterMs, name);
  }
  return message;
}

function absent(message: AssistantMessage, label: string): void {
  assert.equal(Object.hasOwn(message, "retryAfterMs"), false, label);
}

test("completions, anthropic, and responses copy Retry-After onto the HTTP failure", async () => {
  const now = Date.parse("2026-10-15T17:00:00.000Z");
  const singleDigitDay = Date.parse("2026-10-05T17:00:04.000Z");
  const previous = Date.now;
  Date.now = () => now;
  try {
    const protocols: Array<{
      name: string;
      ask: (retryAfter: string | undefined) => Promise<AssistantMessage>;
    }> = [
      {
        name: "openai-completions",
        ask: (retryAfter) => deepseekFailure(retryAfter),
      },
      {
        name: "anthropic-messages",
        ask: (retryAfter) => failure(
          "anthropic-messages",
          (fetchImpl) => anthropicMessagesApi({ fetch: fetchImpl }),
          recorded("anthropic-messages"),
          "https://api.anthropic.com",
          retryAfter,
        ),
      },
      {
        name: "openai-responses",
        ask: (retryAfter) => failure(
          "openai-responses",
          (fetchImpl) => openAIResponsesApi({ fetch: fetchImpl }),
          recorded("openai-responses"),
          "https://example.test/v1",
          retryAfter,
        ),
      },
    ];

    for (const protocol of protocols) {
      const seconds = await protocol.ask("2");
      assert.equal(seconds.retryAfterMs, 2_000, protocol.name);
      const secondsMutated = await protocol.ask("3");
      assert.equal(secondsMutated.retryAfterMs, 3_000, protocol.name);
      assert.equal((await protocol.ask("0")).retryAfterMs, 0, protocol.name);

      const imf = new Date(now + 4_000).toUTCString();
      assert.equal(Date.parse(imf), now + 4_000, imf);
      assert.equal((await protocol.ask(imf)).retryAfterMs, 4_000, protocol.name);
      const imfMutated = new Date(now + 9_000).toUTCString();
      assert.equal((await protocol.ask(imfMutated)).retryAfterMs, 9_000, protocol.name);
      const obs = rfc850(now + 4_000);
      assert.equal(Date.parse(obs), now + 4_000, obs);
      assert.equal((await protocol.ask(obs)).retryAfterMs, 4_000, protocol.name);
      // asctime has no zone token. Date.parse of the raw header follows the local zone, so the check is the product delay.
      const ascii = asctime(now + 15_000);
      assert.equal((await protocol.ask(ascii)).retryAfterMs, 15_000, protocol.name);
      const padded = asctime(singleDigitDay);
      assert.equal((await protocol.ask(padded)).retryAfterMs, 0, protocol.name);
      assert.equal((await protocol.ask(new Date(now - 5_000).toUTCString())).retryAfterMs, 0, protocol.name);

      absent(await protocol.ask("soon"), protocol.name);
      absent(await protocol.ask("1.5"), `${protocol.name} fractional`);

      assert.equal((await protocol.ask("121")).retryAfterMs, 120_000, protocol.name);
      assert.equal((await protocol.ask("86400")).retryAfterMs, 120_000, `${protocol.name} far`);
      assert.equal((await protocol.ask("119")).retryAfterMs, 119_000, protocol.name);

      absent(await protocol.ask(undefined), `${protocol.name} missing`);
      assert.equal((await protocol.ask("5")).retryAfterMs, 5_000, `${protocol.name} added`);
    }

    const untouched: Array<{
      name: string;
      ask: () => Promise<AssistantMessage>;
    }> = [
      {
        name: "google-generative-ai",
        ask: () => failure(
          "google-generative-ai",
          (fetchImpl) => googleGenerativeAIApi({ fetch: fetchImpl }),
          recorded("google-generative-ai"),
          "https://generativelanguage.googleapis.com/v1beta",
          "2",
        ),
      },
      {
        name: "azure-openai-responses",
        ask: () => failure(
          "azure-openai-responses",
          (fetchImpl) => azureOpenAIResponsesApi({ fetch: fetchImpl }),
          recorded("azure-openai-responses"),
          "https://east.openai.azure.com",
          "2",
        ),
      },
      {
        name: "openai-codex-responses",
        ask: () => failure(
          "openai-codex-responses",
          (fetchImpl) => openAICodexResponsesApi({ fetch: fetchImpl }),
          recorded("openai-codex-responses"),
          "https://chatgpt.com/backend-api",
          "2",
        ),
      },
    ];
    for (const protocol of untouched) absent(await protocol.ask(), protocol.name);
  } finally {
    Date.now = previous;
  }
});
