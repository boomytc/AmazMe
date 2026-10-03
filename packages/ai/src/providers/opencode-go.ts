import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { withOpenCodeSessionHeader } from "./request-headers.ts";
import { wires } from "./wires.ts";

export function opencodeGoProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "opencode-go",
    name: "OpenCode Go",
    auth: { apiKey: { env: "OPENCODE_API_KEY", name: "OpenCode API key" } },
    models: catalogModels("opencode-go"),
    api: wires(["anthropic-messages", "openai-completions", "openai-responses"], {
      ...options,
      wrap: withOpenCodeSessionHeader,
    }),
  });
}
