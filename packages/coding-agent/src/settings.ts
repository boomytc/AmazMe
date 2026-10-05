import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Model, Models } from "@amazme/ai";

/**
 * Workspace switches that do not fit `project.json`.
 *
 * `.amazme/project.json` stores `settings` as `Record<string, string>`, so it cannot hold these objects.
 * They live in `<cwd>/.amazme/settings.json` and stay absent until that file sets them.
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

/** Tool names that park until the user allows them. An empty list is off. */
export interface ApprovalSettings {
  tools: string[];
}

export function settingsFile(cwd: string): string {
  return join(resolve(cwd), ".amazme", "settings.json");
}

const SETTINGS_KEYS = new Set(["router", "approval"]);

/** Missing file or a file with no router is off. A present router that does not match the schema throws. */
export function readRouterSettings(cwd: string): RouterSettings | undefined {
  const parsed = readSettings(cwd);
  if (!parsed || !("router" in parsed) || parsed.router === undefined) return undefined;
  return parseRouter(parsed.router);
}

/**
 * Missing file, no `approval` key, or `tools: []` is off.
 * A present approval that does not match the schema throws.
 */
export function readApprovalSettings(cwd: string): ApprovalSettings | undefined {
  const parsed = readSettings(cwd);
  if (!parsed || !("approval" in parsed) || parsed.approval === undefined) return undefined;
  return parseApproval(parsed.approval);
}

function readSettings(cwd: string): Record<string, unknown> | undefined {
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
  const extra = Object.keys(parsed).filter((key) => !SETTINGS_KEYS.has(key));
  if (extra.length > 0) throw new Error("settings.json only allows router and approval");
  return parsed;
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

/**
 * API-key providers name the login command. DeepSeek with no key says
 * `amazme login api-key --provider deepseek`. OAuth-only providers stay on `amazme login`.
 */
export function missingApiKeyHint(providerId: string, env: string | undefined): string {
  if (!env) return "run amazme login";
  return `set ${env} or run amazme login api-key --provider ${providerId}`;
}

function unconfigured(
  role: "strong" | "cheap",
  spec: string,
  models: Pick<Models, "getProvider">,
  model: Model,
): string {
  const env = models.getProvider(model.provider)?.auth.apiKey?.env;
  return `router ${role} ${spec} is not configured: ${missingApiKeyHint(model.provider, env)}`;
}

function parseApproval(value: unknown): ApprovalSettings | undefined {
  if (!isRecord(value)) throw new Error("settings.json approval must be an object");
  const extra = Object.keys(value).filter((key) => key !== "tools");
  if (extra.length > 0) throw new Error("settings.json approval only allows tools");
  if (!("tools" in value)) throw new Error("settings.json approval requires tools");
  const tools = value.tools;
  if (!Array.isArray(tools) || tools.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("settings.json approval tools must be an array of tool names");
  }
  if (tools.length === 0) return undefined;
  const names: string[] = [];
  for (const name of tools) {
    if (!names.includes(name)) names.push(name);
  }
  return { tools: names };
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
