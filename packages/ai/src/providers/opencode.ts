import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { withOpenCodeSessionHeader } from "./request-headers.ts";
import { wires } from "./wires.ts";

export function opencodeProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "opencode",
    name: "OpenCode Zen",
    auth: { apiKey: { env: "OPENCODE_API_KEY", name: "OpenCode API key" } },
    models: catalogModels("opencode"),
    api: wires(["anthropic-messages", "google-generative-ai", "openai-completions", "openai-responses"], {
      ...options,
      wrap: withOpenCodeSessionHeader,
    }),
  });
}
