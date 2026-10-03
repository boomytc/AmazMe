import { githubCopilotOAuth } from "../auth/oauth/flows.ts";
import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { withCopilotHeaders } from "./request-headers.ts";
import { wires } from "./wires.ts";

/** One provider id. Each model picks an existing protocol. Copilot headers wrap that request. */
export function githubCopilotProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "github-copilot",
    name: "GitHub Copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    auth: {
      apiKey: { env: "COPILOT_GITHUB_TOKEN", name: "GitHub Copilot token" },
      oauth: githubCopilotOAuth(options.fetch),
    },
    models: catalogModels("github-copilot"),
    api: wires(["anthropic-messages", "openai-completions", "openai-responses"], {
      ...options,
      wrap: withCopilotHeaders,
    }),
  });
}
