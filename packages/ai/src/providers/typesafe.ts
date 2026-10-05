import { classifyTypesafe } from "../api/typesafe-system-one.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ClassifierModel } from "../types.ts";

const model: ClassifierModel = {
  id: "jev-latest",
  name: "Jev",
  provider: "typesafe",
  api: "typesafe-system-one",
  baseUrl: "https://api.typesafe.ai/v1/",
};

/** Classifier provider. It has no chat models. */
export function typesafeProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "typesafe",
    name: "TypeSafe",
    auth: { apiKey: { env: "TYPESAFE_API_KEY", name: "TypeSafe API key" } },
    models: [],
    classifiers: {
      models: [model],
      run: {
        "typesafe-system-one": (active, context, call) => classifyTypesafe(active, context, { ...call, ...(options.fetch ? { fetch: options.fetch } : {}) }),
      },
    },
  });
}
