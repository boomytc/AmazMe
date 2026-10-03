import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function huggingfaceProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "huggingface",
    name: "Hugging Face",
    baseUrl: "https://router.huggingface.co/v1",
    auth: { apiKey: { env: "HF_TOKEN", name: "Hugging Face token" } },
    models: catalogModels("huggingface"),
    api: wires("openai-completions", options),
  });
}
