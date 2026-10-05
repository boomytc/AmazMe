import type { ClassifierContext, ClassifierModel, ClassifierResult, SpecialCallOptions } from "../types.ts";
import { classifierError, interpretClassifier, postClassifier, wireQuestions } from "./system-one.ts";

const LABEL = "Cloudflare Workers AI";

/**
 * System One on the Workers AI REST endpoint.
 * `POST {baseUrl}/run` with `{ model, input }`. Public `bool` questions go out as `noul`.
 * Cloudflare-hosted models return `{ success, result: { answers } }`.
 * Third-party models such as `typesafe/jev` nest a run record:
 * `{ success, result: { state: "Completed", result: { answers } } }`.
 * Answers and usage use the same validation as the TypeSafe channel.
 * https://developers.cloudflare.com/ai/models/typesafe/jev/
 * https://developers.cloudflare.com/workers-ai/models/clef/
 */
export async function classifyCloudflare(
  model: ClassifierModel,
  context: ClassifierContext,
  options: SpecialCallOptions = {},
): Promise<ClassifierResult> {
  if (!options.apiKey) {
    return { api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason: "error", errorMessage: `No API key for provider: ${model.provider}` };
  }
  const url = new URL("run", `${model.baseUrl.replace(/\/+$/u, "")}/`);
  const posted = await postClassifier(LABEL, model, url, {
    model: model.id,
    input: { state: context.state, questions: wireQuestions(context) },
  }, options);
  if (!posted.ok) return posted.result;
  const unwrapped = unwrapCloudflare(posted.payload);
  if ("errorMessage" in unwrapped) return classifierError(model, unwrapped.errorMessage, posted.text, options.apiKey);
  return interpretClassifier(LABEL, model, context, unwrapped.payload, posted.text, options.apiKey);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull the object that holds `answers` out of the direct envelope or the Completed run record. */
function unwrapCloudflare(body: unknown): { payload: Record<string, unknown> } | { errorMessage: string } {
  if (!isRecord(body)) return { errorMessage: `${LABEL} returned an unexpected response` };
  if (body.success === false) return { errorMessage: cloudflareErrorMessage(body.errors) };
  const result = body.result;
  if (!isRecord(result)) return { errorMessage: `${LABEL} returned an unexpected response` };
  if (isRecord(result.answers)) return { payload: result };
  if (result.state !== "Completed") return { errorMessage: `${LABEL} run did not complete (state: ${String(result.state)})` };
  const inner = result.result;
  if (!isRecord(inner) || !isRecord(inner.answers)) return { errorMessage: `${LABEL} returned an unexpected response` };
  return { payload: inner };
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
