import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function nvidiaProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "nvidia",
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    auth: { apiKey: { env: "NVIDIA_API_KEY", name: "NVIDIA API key" } },
    models: catalogModels("nvidia"),
    api: wires("openai-completions", options),
  });
}
