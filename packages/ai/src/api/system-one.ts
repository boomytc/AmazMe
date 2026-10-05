import { isAbort } from "./events.ts";
import type {
  ClassifierAnswer,
  ClassifierContext,
  ClassifierModel,
  ClassifierQuestion,
  ClassifierResult,
  SpecialCallOptions,
  Usage,
} from "../types.ts";
import { usageCost } from "../usage.ts";

const BODY_LIMIT = 400;
/** Attempts after the first response. 429 and 529 only. */
const RETRY_LIMIT = 2;
const RETRY_BASE_MS = 20;

/**
 * Public `bool` is wire `noul`. Choice and score keep their public type.
 * Instructions and criteria are copied as JSON, including objects and arrays.
 */
export function wireQuestion(question: ClassifierQuestion): unknown {
  if (question.type !== "bool") return question;
  return {
    type: "noul",
    ...(question.instructions !== undefined ? { instructions: question.instructions } : {}),
    ...(question.criteria !== undefined ? { criteria: question.criteria } : {}),
  };
}

export function wireQuestions(context: ClassifierContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(context.questions).map(([id, question]) => [id, wireQuestion(question)]));
}

/**
 * POST a System One body. 429 and 529 wait with exponential backoff, then retry, twice.
 * A bad status or a bad body becomes an error result. Abort becomes `aborted`. Neither throws.
 */
export async function postClassifier(
  label: string,
  model: ClassifierModel,
  url: URL,
  body: unknown,
  options: SpecialCallOptions,
): Promise<{ ok: true; payload: unknown; text: string } | { ok: false; result: ClassifierResult }> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    if (options.signal?.aborted) return { ok: false, result: aborted(model) };
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey ?? ""}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (isAbort(error, options.signal)) return { ok: false, result: aborted(model) };
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, result: failed(model, clipped(message, options.apiKey)) };
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (isAbort(error, options.signal)) return { ok: false, result: aborted(model) };
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, result: failed(model, clipped(message, options.apiKey)) };
    }
    if (response.ok) {
      try {
        return { ok: true, payload: JSON.parse(text) as unknown, text };
      } catch {
        return { ok: false, result: failed(model, `${label} returned an unexpected response: ${clipped(text, options.apiKey)}`) };
      }
    }
    const retryable = response.status === 429 || response.status === 529;
    if (retryable && attempt < RETRY_LIMIT) {
      try {
        await delay(RETRY_BASE_MS * 2 ** attempt, options.signal);
      } catch (error) {
        if (isAbort(error, options.signal)) return { ok: false, result: aborted(model) };
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, result: failed(model, clipped(message, options.apiKey)) };
      }
      continue;
    }
    return {
      ok: false,
      result: failed(model, `${label} returned ${response.status}: ${clipped(text, options.apiKey)}`),
    };
  }
  return { ok: false, result: failed(model, `${label} returned an unexpected response`) };
}

/**
 * Validate answers against the questions. Bool comes back as wire `noul`.
 * Token counts are priced with `usageCost` and kept when validation fails.
 */
export function interpretClassifier(
  label: string,
  model: ClassifierModel,
  context: ClassifierContext,
  payload: unknown,
  rawText: string,
  apiKey: string | undefined,
): ClassifierResult {
  const usage = readUsage(model, payload);
  const answers = isRecord(payload) && isRecord(payload.answers) ? payload.answers : undefined;
  if (!answers) return failed(model, `${label} answer format is invalid: ${clipped(rawText, apiKey)}`, usage);
  const mapped: Record<string, ClassifierAnswer> = {};
  for (const [id, question] of Object.entries(context.questions)) {
    const answer = parseAnswer(question, answers[id]);
    if (!answer) return failed(model, `${label} answer "${id}" is invalid: ${clipped(rawText, apiKey)}`, usage);
    mapped[id] = answer;
  }
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: mapped,
    stopReason: "stop",
    ...(usage ? { usage } : {}),
  };
}

function parseAnswer(question: ClassifierQuestion, answer: unknown): ClassifierAnswer | undefined {
  if (!isRecord(answer)) return undefined;
  if (question.type === "bool") {
    if (answer.type !== "noul" || !isFiniteNumber(answer.noul)) return undefined;
    return { type: "bool", probability: answer.noul };
  }
  if (question.type === "choice") {
    if (answer.type !== "choice" || typeof answer.choice !== "string" || !isFiniteNumber(answer.confidence)) return undefined;
    const probabilities = numberRecord(answer.probabilities);
    if (!probabilities) return undefined;
    return { type: "choice", choice: answer.choice, probabilities, confidence: answer.confidence };
  }
  if (answer.type !== "score" || !isFiniteNumber(answer.score) || !isFiniteNumber(answer.confidence)) return undefined;
  const probabilities = answer.probabilities === undefined ? undefined : numberRecord(answer.probabilities);
  if (answer.probabilities !== undefined && !probabilities) return undefined;
  const legend = answer.legend === undefined ? undefined : stringRecord(answer.legend);
  if (answer.legend !== undefined && !legend) return undefined;
  return {
    type: "score",
    score: answer.score,
    confidence: answer.confidence,
    ...(probabilities ? { probabilities } : {}),
    ...(legend ? { legend } : {}),
  };
}

function readUsage(model: ClassifierModel, payload: unknown): Usage | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  const input = isFiniteNumber(payload.usage.input_tokens) ? payload.usage.input_tokens : undefined;
  const output = isFiniteNumber(payload.usage.output_tokens) ? payload.usage.output_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  const prompt = input ?? 0;
  const completion = output ?? 0;
  const amounts = usageCost(model, { input: prompt, output: completion });
  return {
    input: prompt,
    output: completion,
    totalTokens: prompt + completion,
    cost: amounts === null
      ? { input: 0, output: 0, total: 0 }
      : {
          input: amounts.input,
          output: amounts.output,
          total: amounts.total ?? amounts.input + amounts.cacheWrite + amounts.output,
        },
  };
}

/** Error result whose message ends with the response body, with the API key removed. */
export function classifierError(
  model: ClassifierModel,
  message: string,
  rawText: string,
  apiKey: string | undefined,
): ClassifierResult {
  const detail = clipped(rawText, apiKey);
  return failed(model, detail.length > 0 ? `${message}: ${detail}` : message);
}

function failed(model: ClassifierModel, errorMessage: string, usage?: Usage): ClassifierResult {
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: "error",
    errorMessage,
    ...(usage ? { usage } : {}),
  };
}

function aborted(model: ClassifierModel): ClassifierResult {
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: "aborted",
    errorMessage: "Request aborted",
  };
}

function clipped(text: string, apiKey: string | undefined): string {
  const redacted = apiKey && apiKey.length > 0 ? text.replaceAll(apiKey, "[redacted]") : text;
  return redacted.slice(0, BODY_LIMIT);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isFiniteNumber(item)) return undefined;
    out[key] = item;
  }
  return out;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return undefined;
    out[key] = item;
  }
  return out;
}
