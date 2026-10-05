import { messageText, usageCost, type ChoiceClassifierAnswer, type ClassifierModel, type ClassifierResult, type Model, type Models } from "@amazme/ai";
import type { AgentMessage } from "@amazme/agent";
import type { RouteUsage } from "./session.ts";
import { parseModelSpec, type RouterSettings } from "./settings.ts";

/** One classification for the whole session. Later model calls reuse the recorded target. */
export interface RouteDecision {
  provider: string;
  modelId: string;
  choice?: "standard" | "complex";
  score?: number;
  reason?: string;
  usage?: RouteUsage;
}

export type RouterModels = Pick<Models, "getModel" | "getClassifier" | "classify">;

const STATE_LIMIT = 8_000;

/**
 * Ask Jev once, with a single choice of `standard` or `complex`.
 * The probability of `complex` decides the model: at least 0.5 selects strong.
 * Any classifier failure keeps the current model and records why. This does not throw.
 */
export async function decideRoute(
  models: RouterModels,
  router: RouterSettings,
  current: Model,
  messages: readonly AgentMessage[],
  signal: AbortSignal,
): Promise<RouteDecision> {
  const classifierSpec = parseModelSpec(router.classifier);
  if (!classifierSpec) return keep(current, "router classifier must be provider/model");
  const classifier = models.getClassifier(classifierSpec.provider, classifierSpec.modelId);
  if (!classifier) return keep(current, `unknown classifier ${router.classifier}`);
  let result: ClassifierResult;
  try {
    result = await models.classify(classifier, {
      state: routingState(messages),
      questions: {
        route: {
          type: "choice",
          instructions: "How hard is this coding task?",
          criteria: {
            standard: "A routine edit, question, or local change.",
            complex: "A design, a wide change, or something a stronger model should do.",
          },
        },
      },
    }, { signal });
  } catch (error) {
    return keep(current, error instanceof Error ? error.message : String(error));
  }
  const usage = routeUsage(classifier, result);
  if (result.stopReason !== "stop") return keep(current, result.errorMessage ?? `classifier ${result.stopReason}`, usage);
  const answer = firstChoice(result);
  if (!answer) return keep(current, "classifier choice is missing", usage);
  const choice = answer.choice === "standard" || answer.choice === "complex" ? answer.choice : undefined;
  if (!choice) return keep(current, `classifier choice ${answer.choice} is not standard or complex`, usage);
  const score = complexScore(answer);
  const target = score >= 0.5 ? router.strong : router.cheap;
  const spec = parseModelSpec(target);
  if (!spec) return keep(current, `router target ${target} must be provider/model`, usage);
  const model = models.getModel(spec.provider, spec.modelId);
  if (!model) return keep(current, `unknown model ${target}`, usage);
  return {
    provider: model.provider,
    modelId: model.id,
    choice,
    score,
    ...(usage ? { usage } : {}),
  };
}

export function resolveRoutedModel(models: RouterModels, decision: { provider: string; modelId: string }, current: Model): Model {
  return models.getModel(decision.provider, decision.modelId) ?? current;
}

function keep(current: Model, reason: string, usage?: RouteUsage): RouteDecision {
  return {
    provider: current.provider,
    modelId: current.id,
    reason,
    ...(usage ? { usage } : {}),
  };
}

function firstChoice(result: ClassifierResult): ChoiceClassifierAnswer | undefined {
  for (const answer of Object.values(result.answers)) {
    if (answer.type === "choice") return answer;
  }
  return undefined;
}

/** Probability of `complex`. Without that probability, only an explicit complex choice contributes its confidence. */
function complexScore(answer: ChoiceClassifierAnswer): number {
  const complex = answer.probabilities.complex;
  if (typeof complex === "number") return complex;
  return answer.choice === "complex" ? answer.confidence : 0;
}

function routeUsage(classifier: ClassifierModel, result: ClassifierResult): RouteUsage | undefined {
  const usage = result.usage;
  if (!usage) return undefined;
  const priced = usageCost(classifier, usage);
  return {
    input: usage.input,
    output: usage.output,
    totalTokens: usage.totalTokens,
    cost: priced === null ? null : { input: priced.input, output: priced.output, total: priced.total },
  };
}

function routingState(messages: readonly AgentMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    parts.push(messageText(message));
  }
  const text = parts.join("\n").trim();
  const body = text.length > 0 ? text : "(empty)";
  return body.length > STATE_LIMIT ? body.slice(0, STATE_LIMIT) : body;
}
