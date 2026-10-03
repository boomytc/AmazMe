import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

export function azureOpenAIResponsesProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "azure-openai-responses",
    name: "Azure OpenAI Responses",
    auth: { apiKey: { env: "AZURE_OPENAI_API_KEY", name: "Azure OpenAI API key" } },
    models: catalogModels("azure-openai-responses"),
    api: wires("azure-openai-responses", options),
  });
}
