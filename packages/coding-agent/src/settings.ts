import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Model, Models } from "@amazme/ai";

/**
 * Workspace router switch.
 *
 * `.amazme/project.json` stores `settings` as `Record<string, string>`, so it cannot hold this object.
 * The router lives in `<cwd>/.amazme/settings.json` and is absent until that file sets it.
 */
export interface RouterSettings {
  /** Classifier spec, `provider/model`. TypeSafe Jev is `typesafe/jev-latest`. */
  classifier: string;
  /** Chat spec used when the complex probability is at least 0.5. */
  strong: string;
  /** Chat spec used otherwise. */
  cheap: string;
}

export interface ModelSpec {
  provider: string;
  modelId: string;
}

export function settingsFile(cwd: string): string {
  return join(resolve(cwd), ".amazme", "settings.json");
}

/** Missing file or a file with no router is off. A present router that does not match the schema throws. */
export function readRouterSettings(cwd: string): RouterSettings | undefined {
  let raw: string;
  try {
    raw = readFileSync(settingsFile(cwd), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new Error(`settings.json cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("settings.json must be JSON");
  }
  if (!isRecord(parsed)) throw new Error("settings.json must be an object");
  const extra = Object.keys(parsed).filter((key) => key !== "router");
  if (extra.length > 0) throw new Error("settings.json only allows router");
  if (!("router" in parsed) || parsed.router === undefined) return undefined;
  return parseRouter(parsed.router);
}

/** `provider/model`. The model id may itself contain slashes. */
export function parseModelSpec(spec: string): ModelSpec | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash >= spec.length - 1 || /\s/.test(spec)) return undefined;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/**
 * Strong and cheap must already have credentials. The classifier key is not required here:
 * a missing classifier key fails the one classification and the session keeps its current model.
 */
export async function requireRouterKeys(
  models: Pick<Models, "getModel" | "getProvider" | "getAuth">,
  cwd: string,
): Promise<void> {
  const router = readRouterSettings(cwd);
  if (!router) return;
  const problems: string[] = [];
  for (const role of ["strong", "cheap"] as const) {
    const spec = parseModelSpec(router[role]);
    if (!spec) {
      problems.push(`router ${role} must be provider/model`);
      continue;
    }
    const model = models.getModel(spec.provider, spec.modelId);
    if (!model) {
      problems.push(`router ${role} ${router[role]} is unknown`);
      continue;
    }
    if (await models.getAuth(model)) continue;
    problems.push(unconfigured(role, router[role], models, model));
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

function unconfigured(
  role: "strong" | "cheap",
  spec: string,
  models: Pick<Models, "getProvider">,
  model: Model,
): string {
  const env = models.getProvider(model.provider)?.auth.apiKey?.env;
  const hint = env ? `set ${env} or run amazme login` : "run amazme login";
  return `router ${role} ${spec} is not configured: ${hint}`;
}

function parseRouter(value: unknown): RouterSettings {
  if (!isRecord(value)) throw new Error("settings.json router must be an object");
  const extra = Object.keys(value).filter((key) => key !== "classifier" && key !== "strong" && key !== "cheap");
  if (extra.length > 0) throw new Error("settings.json router only allows classifier, strong, and cheap");
  const classifier = value.classifier;
  const strong = value.strong;
  const cheap = value.cheap;
  if (typeof classifier !== "string" || typeof strong !== "string" || typeof cheap !== "string") {
    throw new Error("settings.json router requires classifier, strong, and cheap as provider/model");
  }
  if (!parseModelSpec(classifier) || !parseModelSpec(strong) || !parseModelSpec(cheap)) {
    throw new Error("settings.json router requires classifier, strong, and cheap as provider/model");
  }
  return { classifier, strong, cheap };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
