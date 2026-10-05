import type { ClassifierContext, ClassifierModel, ClassifierResult, SpecialCallOptions } from "../types.ts";
import { interpretClassifier, postClassifier, wireQuestions } from "./system-one.ts";

const LABEL = "System One API";

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
  if (!options.apiKey) {
    return { api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason: "error", errorMessage: `No API key for provider: ${model.provider}` };
  }
  const url = new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`);
  const posted = await postClassifier(LABEL, model, url, {
    model: model.id,
    state: context.state,
    questions: wireQuestions(context),
  }, options);
  if (!posted.ok) return posted.result;
  return interpretClassifier(LABEL, model, context, posted.payload, posted.text, options.apiKey);
}
