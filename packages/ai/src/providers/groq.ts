import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function groqProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    auth: { apiKey: { env: "GROQ_API_KEY", name: "Groq API key" } },
    models: catalogModels("groq"),
    api: wires("openai-completions", options),
  });
}
