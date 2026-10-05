import type { ClassifierContext, ClassifierModel, ClassifierQuestion, ClassifierResult, SpecialCallOptions } from "../types.ts";

/**
 * TypeSafe System One. `POST {baseUrl}/systemone` with the model id.
 * Public `bool` questions are sent as wire `noul` and mapped back to `bool`.
 * https://api.typesafe.ai/v1/systemone
 */
export async function classifyTypesafe(
  model: ClassifierModel,
  context: ClassifierContext,
  options: SpecialCallOptions = {},
): Promise<ClassifierResult> {
  const base = errorResult(model);
  if (!options.apiKey) return { ...base, errorMessage: `No API key for provider: ${model.provider}` };
  const questions: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(context.questions)) questions[id] = wireQuestion(question);
  const url = new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: model.id, state: context.state, questions }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) return { ...base, errorMessage: `System One API returned ${response.status}` };
  const body = await response.json() as { answers?: Record<string, unknown> };
  return { ...base, stopReason: "stop", answers: mapAnswers(context, body.answers ?? {}) };
}

function wireQuestion(question: ClassifierQuestion): unknown {
  if (question.type !== "bool") return question;
  return { type: "noul", instructions: question.instructions, ...(question.criteria ? { criteria: question.criteria } : {}) };
}

function mapAnswers(context: ClassifierContext, answers: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [id, answer] of Object.entries(answers)) {
    const question = context.questions[id];
    if (question?.type === "bool" && answer && typeof answer === "object" && "noul" in answer) {
      const noul = (answer as { noul?: unknown }).noul;
      mapped[id] = { type: "bool", probability: typeof noul === "number" ? noul : 0 };
      continue;
    }
    mapped[id] = answer;
  }
  return mapped;
}

function errorResult(model: ClassifierModel): ClassifierResult {
  return { api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason: "error" };
}
