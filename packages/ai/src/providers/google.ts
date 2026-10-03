import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function googleProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "google",
    name: "Google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    auth: { apiKey: { env: "GEMINI_API_KEY", name: "Gemini API key" } },
    models: catalogModels("google"),
    api: wires("google-generative-ai", options),
  });
}
