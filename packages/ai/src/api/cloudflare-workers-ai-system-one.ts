import type { ClassifierContext, ClassifierModel, ClassifierQuestion, ClassifierResult, SpecialCallOptions } from "../types.ts";

const LABEL = "Cloudflare Workers AI";

/**
 * System One on the Workers AI REST endpoint.
 * `POST {baseUrl}/run` with `{ model, input }`. Public `bool` questions go out as `noul`.
 * Cloudflare-hosted models return `{ success, result: { answers } }`.
 * Third-party models such as `typesafe/jev` nest a run record:
 * `{ success, result: { state: "Completed", result: { answers } } }`.
 * https://developers.cloudflare.com/ai/models/typesafe/jev/
 * https://developers.cloudflare.com/workers-ai/models/clef/
 */
export async function classifyCloudflare(
  model: ClassifierModel,
  context: ClassifierContext,
  options: SpecialCallOptions = {},
): Promise<ClassifierResult> {
  const base: ClassifierResult = { api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason: "error" };
  if (!options.apiKey) return { ...base, errorMessage: `No API key for provider: ${model.provider}` };
  const url = new URL("run", `${model.baseUrl.replace(/\/+$/u, "")}/`);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: model.id, input: wireInput(context) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) return { ...base, errorMessage: `${LABEL} returned ${response.status}` };
  try {
    return { ...base, stopReason: "stop", answers: mapAnswers(context, unwrapAnswers(await response.json())) };
  } catch (error) {
    return { ...base, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

function wireInput(context: ClassifierContext): { state: ClassifierContext["state"]; questions: Record<string, unknown> } {
  return {
    state: context.state,
    questions: Object.fromEntries(Object.entries(context.questions).map(([id, question]) => [id, wireQuestion(question)])),
  };
}

function wireQuestion(question: ClassifierQuestion): unknown {
  if (question.type !== "bool") return question;
  return { ...question, type: "noul" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull `{ answers }` out of the direct envelope or the Completed run record. */
function unwrapAnswers(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
  if (body.success === false) throw new Error(cloudflareErrorMessage(body.errors));
  const result = body.result;
  if (!isRecord(result)) throw new Error(`${LABEL} returned an unexpected response`);
  if (isRecord(result.answers)) return result.answers;
  if (result.state !== "Completed") throw new Error(`${LABEL} run did not complete (state: ${String(result.state)})`);
  const inner = result.result;
  if (!isRecord(inner) || !isRecord(inner.answers)) throw new Error(`${LABEL} returned an unexpected response`);
  return inner.answers;
}

function mapAnswers(context: ClassifierContext, answers: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [id, answer] of Object.entries(answers)) {
    const question = context.questions[id];
    if (question?.type === "bool" && isRecord(answer) && answer.type === "noul" && typeof answer.noul === "number") {
      mapped[id] = { type: "bool", probability: answer.noul };
      continue;
    }
    mapped[id] = answer;
  }
  return mapped;
}

function cloudflareErrorMessage(errors: unknown): string {
  if (Array.isArray(errors)) {
    const messages = errors
      .map((error) => (isRecord(error) && typeof error.message === "string" ? error.message : undefined))
      .filter((message): message is string => message !== undefined);
    if (messages.length > 0) return `${LABEL} error: ${messages.join("; ")}`;
  }
  return `${LABEL} request failed`;
}
