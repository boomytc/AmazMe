import { resolve } from "node:path";
import type { AgentMessage } from "@amazme/agent";
import type { Models } from "@amazme/ai";
import { decideRoute, type RouterModels } from "./router.ts";
import { readLatestRoute, writeRouteRecord } from "./route-record.ts";
import type { SessionRouteEntry } from "./session.ts";
import { readRouterSettings } from "./settings.ts";

export interface RouterHostOptions {
  cwd: string;
  provider: string;
  modelId: string;
  models: {
    getModel: Models["getModel"];
    getClassifier?: Models["getClassifier"];
    classify?: Models["classify"];
  };
}

interface LaneSettingsRead {
  provider: string;
  modelId: string;
}

type ConfigureResult =
  | { ok: true; value: LaneSettingsRead }
  | { ok: false; error: { message: string } };

interface SessionLane {
  readonly name: string;
  accept(request: { kind: string; text?: string }): Promise<unknown>;
  configure(patch?: { provider?: string; modelId?: string }): Promise<ConfigureResult>;
  usage(): Promise<DisplayedUsage>;
}

interface DisplayedCost {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  total: number | null;
}

interface DisplayedUsage {
  total: {
    input: number;
    output: number;
    cost: DisplayedCost | null;
  };
}

const inflight = new Map<string, Promise<void>>();

/**
 * Classify on the first prompt of a new lane, before `accept` starts the operation.
 * `configure` during a drive is rejected as busy, so this runs while the lane is idle.
 * A route file, or a lane model already replaced by an earlier classification, skips TypeSafe.
 */
export function installSessionRouter(harness: { lane(name?: string): unknown }, options: RouterHostOptions): void {
  const open = harness.lane.bind(harness);
  harness.lane = (name?: string) => {
    const lane = open(name) as SessionLane;
    attach(lane, options);
    return lane;
  };
}

function attach(lane: SessionLane, options: RouterHostOptions): void {
  const accept = lane.accept.bind(lane);
  const usage = lane.usage.bind(lane);
  lane.accept = async (request) => {
    if (request.kind === "prompt" && typeof request.text === "string") {
      await ensureSessionRoute(lane, options, request.text);
    }
    return accept(request);
  };
  lane.usage = () => usage().then((view) => foldRouteUsage(view, readLatestRoute(options.cwd, lane.name)));
}

async function ensureSessionRoute(lane: SessionLane, options: RouterHostOptions, text: string): Promise<void> {
  const key = `${resolve(options.cwd)}\0${lane.name}`;
  const previous = inflight.get(key) ?? Promise.resolve();
  const run = previous.then(() => routeOnce(lane, options, text));
  inflight.set(key, run.then(() => undefined, () => undefined));
  await run;
}

async function routeOnce(lane: SessionLane, options: RouterHostOptions, text: string): Promise<void> {
  if (readLatestRoute(options.cwd, lane.name)) return;
  let router: ReturnType<typeof readRouterSettings>;
  try {
    router = readRouterSettings(options.cwd);
  } catch (error) {
    writeRouteRecord(options.cwd, {
      lane: lane.name,
      provider: options.provider,
      modelId: options.modelId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!router) return;
  const current = await lane.configure();
  if (!current.ok) return;
  if (current.value.provider !== options.provider || current.value.modelId !== options.modelId) return;
  const model = options.models.getModel(current.value.provider, current.value.modelId);
  if (!model) {
    writeRouteRecord(options.cwd, {
      lane: lane.name,
      provider: current.value.provider,
      modelId: current.value.modelId,
      reason: `unknown model ${current.value.provider}/${current.value.modelId}`,
    });
    return;
  }
  const models = routerModels(options.models);
  if (!models) {
    writeRouteRecord(options.cwd, {
      lane: lane.name,
      provider: model.provider,
      modelId: model.id,
      reason: "router needs models",
    });
    return;
  }
  const message: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
  const decision = await decideRoute(models, router, model, [message], new AbortController().signal);
  const applied = await lane.configure({ provider: decision.provider, modelId: decision.modelId });
  if (!applied.ok) {
    writeRouteRecord(options.cwd, {
      lane: lane.name,
      provider: model.provider,
      modelId: model.id,
      ...(decision.choice ? { choice: decision.choice } : {}),
      ...(decision.score !== undefined ? { score: decision.score } : {}),
      ...(decision.usage ? { usage: decision.usage } : {}),
      reason: applied.error.message,
    });
    return;
  }
  writeRouteRecord(options.cwd, { ...decision, lane: lane.name });
}

function routerModels(models: RouterHostOptions["models"]): RouterModels | undefined {
  if (!models.getClassifier || !models.classify) return undefined;
  const getClassifier = models.getClassifier.bind(models);
  const classify = models.classify.bind(models);
  return {
    getModel: (provider, modelId) => models.getModel(provider, modelId),
    getClassifier,
    classify,
  };
}

/**
 * Add the route record's Jev usage onto the lane total the footer already displays.
 * A missing Jev price, or a null Jev total, makes the cumulative cost null.
 * Token totals include the classifier. Cache and reasoning stay the lane's own figures.
 */
export function foldRouteUsage<T extends DisplayedUsage>(usage: T, route: SessionRouteEntry | undefined): T {
  const jev = route?.usage;
  if (!jev) return usage;
  const next = structuredClone(usage);
  next.total.input += jev.input;
  next.total.output += jev.output;
  const price = jev.cost;
  const cost = next.total.cost;
  const priceTotal = price?.total;
  if (!price || priceTotal === null || priceTotal === undefined || !cost || cost.total === null) {
    next.total.cost = null;
    return next;
  }
  const baseTotal = cost.total;
  next.total.cost = {
    input: cost.input === null ? null : cost.input + price.input,
    output: cost.output === null ? null : cost.output + price.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    total: baseTotal + priceTotal,
  };
  return next;
}
