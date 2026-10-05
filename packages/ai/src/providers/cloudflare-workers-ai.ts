import { classifyCloudflare } from "../api/cloudflare-workers-ai-system-one.ts";
import type { ApiKeyAuth } from "../auth.ts";
import { createProvider, type Provider } from "../models.ts";
import type { AuthResult, ClassifierModel, Model } from "../types.ts";
import { fillCloudflare, withCloudflarePlaceholders } from "./request-headers.ts";
import { wires } from "./wires.ts";

const CHAT_BASE = "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1";
const REST_BASE = "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai";

function cloudflareAuth(): ApiKeyAuth {
  return {
    env: "CLOUDFLARE_API_KEY",
    name: "Cloudflare API key",
    async resolve({ credential, env }): Promise<AuthResult | undefined> {
      const key = credential?.key ?? env.CLOUDFLARE_API_KEY;
      const account = credential?.env?.CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID;
      if (!key || !account) return undefined;
      return {
        apiKey: key,
        source: credential?.key ? "store" : "env",
        env: { CLOUDFLARE_ACCOUNT_ID: account },
      };
    },
  };
}

const chatModel: Model<"openai-completions"> = {
  id: "@cf/moonshotai/kimi-k2.6",
  name: "Kimi K2.6",
  provider: "cloudflare-workers-ai",
  api: "openai-completions",
  baseUrl: CHAT_BASE,
  input: ["text"],
  contextWindow: 262_144,
  maxTokens: 8192,
  cost: { input: 0, output: 0 },
};

const classifier: ClassifierModel = {
  id: "typesafe/jev",
  name: "Jev",
  provider: "cloudflare-workers-ai",
  api: "cloudflare-workers-ai-system-one",
  baseUrl: REST_BASE,
};

export function cloudflareWorkersAIProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    auth: { apiKey: cloudflareAuth() },
    models: [chatModel],
    api: wires("openai-completions", { ...options, wrap: withCloudflarePlaceholders }),
    classifiers: {
      models: [classifier],
      run: {
        "cloudflare-workers-ai-system-one": (model, context, call) => {
          const baseUrl = fillCloudflare(call.baseUrl ?? model.baseUrl, call.env) ?? model.baseUrl;
          return classifyCloudflare(baseUrl === model.baseUrl ? model : { ...model, baseUrl }, context, {
            ...call,
            baseUrl,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          });
        },
      },
    },
  });
}
