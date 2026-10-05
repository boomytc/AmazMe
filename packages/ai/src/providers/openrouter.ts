import { generateOpenRouterImages } from "../api/openrouter-images.ts";
import { openRouterOAuth } from "../auth/oauth/flows.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ImageModel } from "../types.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

const imageModel: ImageModel = {
  id: "black-forest-labs/flux.2-pro",
  name: "FLUX.2 Pro",
  provider: "openrouter",
  api: "openrouter-images",
  baseUrl: "https://openrouter.ai/api/v1",
};

export function openrouterProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: {
      apiKey: { env: "OPENROUTER_API_KEY", name: "OpenRouter API key" },
      oauth: openRouterOAuth(options.fetch),
    },
    models: catalogModels("openrouter"),
    api: wires(["anthropic-messages", "openai-completions"], options),
    images: {
      models: [imageModel],
      run: {
        "openrouter-images": (model, request, call) => generateOpenRouterImages(model, request, { ...call, ...(options.fetch ? { fetch: options.fetch } : {}) }),
      },
    },
  });
}
