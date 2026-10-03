import { codexOAuth } from "../auth/oauth/flows.ts";
import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

/** Codex has no API-key path. Login is the ChatGPT subscription. */
export function openaiCodexProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "openai-codex",
    name: "OpenAI Codex (legacy)",
    baseUrl: "https://chatgpt.com/backend-api",
    auth: { oauth: codexOAuth(options.fetch) },
    models: catalogModels("openai-codex"),
    api: wires("openai-codex-responses", options),
  });
}
